"""
اختبارات end-to-end للنظام كله على API حقيقي وقاعدة بيانات SQLite جديدة.

التشغيل:
    python -m pytest tests/e2e -v

- بيبني قاعدة جديدة (prisma db push + seed) ويشغّل الـ API على بورت 4566.
- لو عايز تختبر على سيرفر شغال: E2E_BASE_URL=http://localhost:3001 (بيعدّي التجهيز).
- E2E_BUILD=1 يبني الـ API الأول (npm run build -w @m5azen/api).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parents[2]
API_DIR = ROOT / "apps" / "api"
DB_FILE = API_DIR / "prisma" / "pytest-e2e.db"
PORT = int(os.environ.get("E2E_PORT", "4566"))
EPS = 0.011


def near(a: float, b: float, eps: float = EPS) -> bool:
    return abs((a or 0) - (b or 0)) <= eps


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


class Api:
    def __init__(self, base: str):
        self.base = base.rstrip("/") + "/api"
        self.token = ""
        self.s = requests.Session()

    def _call(self, method: str, path: str, body=None, params=None):
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        res = self.s.request(method, self.base + path, json=body, params=params, headers=headers, timeout=60)
        data = res.json() if res.text else None
        if not res.ok:
            msg = data.get("message") if isinstance(data, dict) else res.text
            if isinstance(msg, list):
                msg = ", ".join(msg)
            raise ApiError(res.status_code, str(msg))
        return data

    def get(self, path, **params):
        return self._call("GET", path, params=params or None)

    def post(self, path, body=None):
        return self._call("POST", path, body or {})

    def patch(self, path, body=None):
        return self._call("PATCH", path, body or {})

    def delete(self, path):
        return self._call("DELETE", path)

    def fails(self, method: str, path: str, body=None) -> ApiError:
        """لازم الطلب يترفض (4xx) — بيرجع الخطأ عشان نتأكد من الرسالة."""
        try:
            self._call(method, path, body)
        except ApiError as err:
            assert 400 <= err.status < 500, f"expected 4xx got {err.status}: {err.message}"
            return err
        raise AssertionError(f"{method} {path} should have failed")


def _run(cmd: str, env: dict, cwd: Path):
    out = subprocess.run(cmd, cwd=cwd, env=env, shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode != 0:
        raise RuntimeError(f"{cmd} failed:\n{out.stdout}\n{out.stderr}")
    return out.stdout


@pytest.fixture(scope="session")
def base_url():
    external = os.environ.get("E2E_BASE_URL")
    if external:
        yield external
        return

    env = {k: v for k, v in os.environ.items() if k not in ("TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN")}
    env["DATABASE_URL"] = f"file:./{DB_FILE.name}"
    env["PORT"] = str(PORT)
    if os.environ.get("E2E_BUILD") == "1" or not (API_DIR / "dist" / "main.js").exists():
        _run("npm run build -w @m5azen/api", env, ROOT)
    for f in DB_FILE.parent.glob(DB_FILE.name + "*"):
        f.unlink()
    _run("npx prisma db push --skip-generate", env, API_DIR)
    _run("npx tsx prisma/seed.ts", env, API_DIR)

    log = open(ROOT / "tests" / "e2e" / "server.log", "w", encoding="utf-8")
    proc = subprocess.Popen(["node", "dist/main.js"], cwd=API_DIR, env=env, stdout=log, stderr=subprocess.STDOUT)
    url = f"http://localhost:{PORT}"
    for _ in range(120):
        try:
            if requests.get(url + "/api/health", timeout=2).ok:
                break
        except requests.RequestException:
            pass
        if proc.poll() is not None:
            raise RuntimeError("API exited — see tests/e2e/server.log")
        time.sleep(0.5)
    else:
        proc.kill()
        raise RuntimeError("API did not start")
    yield url
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()
    for f in DB_FILE.parent.glob(DB_FILE.name + "*"):
        try:
            f.unlink()
        except OSError:
            pass


@pytest.fixture(scope="session")
def api(base_url) -> Api:
    client = Api(base_url)
    res = client.post("/auth/login", {"username": os.environ.get("E2E_USER", "admin"), "password": os.environ.get("E2E_PASS", "admin123")})
    client.token = res.get("accessToken") or res.get("token")
    return client


class World:
    """بيانات ثابتة + مصانع للاختبارات + قراءة الأرصدة."""

    def __init__(self, api: Api):
        self.api = api
        warehouses = api.get("/warehouses", includeSystem="1")
        self.main = next(w for w in warehouses if w["code"] == "WH01")
        self.returns_wh = next(w for w in warehouses if w["code"] == "RETURNS")
        self.second = api.post("/warehouses", {"code": f"WH2-{uid()}", "name": f"مخزن تاني {uid()}"})
        methods = api.get("/cash/methods")
        self.cash = next(m for m in methods if m["kind"] == "IMMEDIATE" and m.get("cashAccount", {}).get("code") == "CASH01")
        self.check = next(m for m in methods if m["kind"] == "CHECK")
        code = f"BNK{uid()[:5]}".upper()
        self.bank = api.post("/cash/methods", {"name": f"بنك {code}", "code": code, "kind": "IMMEDIATE", "accountType": "BANK"})
        self.touched_products: set[str] = set()
        self.touched_customers: set[str] = set()
        self.touched_suppliers: set[str] = set()

    # ---------- مصانع ----------
    def product(self, name="بطارية", sale=2000, cost=0):
        p = self.api.post("/products", {"name": f"{name} {uid()}", "unit": "قطعة", "salePrice": sale, "costPrice": cost})
        self.touched_products.add(p["id"])
        return p

    def customer(self, name="زبون"):
        c = self.api.post("/customers/by-name", {"name": f"{name} {uid()}"})
        self.touched_customers.add(c["id"])
        return c

    def supplier(self, name="مورد"):
        s = self.api.post("/suppliers", {"code": f"S{uid()[:8]}", "name": f"{name} {uid()}"})
        self.touched_suppliers.add(s["id"])
        return s

    def buy(self, product, qty, cost, supplier=None, wh=None, payments=None, confirm=True, **extra):
        supplier = supplier or self.supplier()
        self.touched_suppliers.add(supplier["id"])
        body = {
            "supplierId": supplier["id"],
            "warehouseId": (wh or self.main)["id"],
            "confirm": confirm,
            "lines": [{"productId": product["id"], "quantity": qty, "unitCost": cost}],
            **extra,
        }
        if payments:
            body["payments"] = payments
        inv = self.api.post("/purchases", body)
        time.sleep(0.02)  # ترتيب الدفعات بالوقت
        return inv

    def sell(self, lines, customer=None, wh=None, payments=None, confirm=True, **extra):
        customer = customer or self.customer()
        self.touched_customers.add(customer["id"])
        body = {
            "customerId": customer["id"],
            "warehouseId": (wh or self.main)["id"],
            "confirm": confirm,
            "lines": [{"productId": p["id"], "quantity": q, "unitPrice": price} for p, q, price in lines],
            **extra,
        }
        if payments:
            body["payments"] = payments
        inv = self.api.post("/sales", body)
        time.sleep(0.02)
        return inv

    def pay(self, method, amount, id=None):
        part = {"methodId": method["id"], "amount": amount}
        if id:
            part["id"] = id
        return part

    # ---------- أرصدة ----------
    def stock(self, product, wh=None) -> float:
        rows = self.api.get("/stock/balances", warehouseId=(wh or self.main)["id"])
        return next((r["quantity"] for r in rows if r["productId"] == product["id"]), 0)

    def customer_balance(self, customer) -> float:
        return self.api.get(f"/customers/{customer['id']}")["balance"]

    def supplier_balance(self, supplier) -> float:
        return self.api.get(f"/suppliers/{supplier['id']}")["balance"]

    def account(self, method) -> float:
        acc_id = method.get("cashAccountId") or method.get("cashAccount", {}).get("id")
        return next(a["balance"] for a in self.api.get("/cash/accounts") if a["id"] == acc_id)

    def sale(self, inv):
        return self.api.get(f"/sales/{inv['id']}")

    def fifo(self, product, wh=None):
        return self.api.get("/stock/fifo", productId=product["id"], warehouseId=(wh or self.main)["id"])

    def sale_fifo(self, inv):
        return self.api.get(f"/sales/{inv['id']}/fifo")

    def receipts_payload(self, inv):
        full = self.sale(inv)
        return [{"id": r["id"], "methodId": r["paymentMethod"], "amount": r["amount"]} for r in full.get("receipts") or []]

    def profit(self):
        return self.api.get("/reports/profit")


def uid() -> str:
    return uuid.uuid4().hex[:8]


@pytest.fixture(scope="session")
def world(api) -> World:
    return World(api)


@pytest.fixture(autouse=True)
def stock_invariants(world: World):
    """بعد كل اختبار: الرصيد = مجموع الحركات = اللي فاضل في دفعات FIFO، ورصيد المورد/العميل = كشف حسابه."""
    world.touched_products.clear()
    world.touched_customers.clear()
    world.touched_suppliers.clear()
    yield
    api = world.api
    warehouses = [world.main, world.second, world.returns_wh]
    balances = {wh["id"]: api.get("/stock/balances", warehouseId=wh["id"]) for wh in warehouses}
    for pid in list(world.touched_products):
        moves = api.get("/stock/movements", productId=pid)
        for wh in warehouses:
            bal = next((r["quantity"] for r in balances[wh["id"]] if r["productId"] == pid), 0)
            moved = sum(m["quantity"] for m in moves if m["warehouseId"] == wh["id"])
            assert near(bal, moved), f"product {pid} in {wh['name']}: balance {bal} != movements {moved}"
            fifo = api.get("/stock/fifo", productId=pid, warehouseId=wh["id"])
            assert near(fifo["remainingQty"], bal), f"product {pid} in {wh['name']}: FIFO {fifo['remainingQty']} != balance {bal}"
            assert not fifo["fallbackOuts"], f"product {pid} in {wh['name']}: sold without a batch {fifo['fallbackOuts']}"
    for sid in list(world.touched_suppliers):
        raw = api.get(f"/suppliers/{sid}")["balance"]
        st = api.get(f"/suppliers/{sid}/statement")
        computed = st["statement"][-1]["balance"] if st["statement"] else 0
        assert near(raw, computed), f"supplier {sid}: balance {raw} != statement {computed}"
    for cid in list(world.touched_customers):
        raw = api.get(f"/customers/{cid}")["balance"]
        st = api.get(f"/customers/{cid}/statement")
        computed = st["statement"][-1]["balance"] if st["statement"] else 0
        assert near(raw, computed), f"customer {cid}: balance {raw} != statement {computed}"
