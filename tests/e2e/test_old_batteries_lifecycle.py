"""
كل مسارات البطارية القديمة من أول ما تدخل المحل لحد آخرها، مع التأكد من الحسابات في كل خطوة:
رصيد المورد، الخزنة، المخزون، تكلفة FIFO، تقرير الأرباح، دفتر الحركة، وتقرير البطاريات القديمة.
"""
import pytest

from conftest import near


# ---------------- أدوات ----------------

def intake_from_sale(world, pieces=1, value_each=300, kind="SCRAP", price=1500):
    p = world.product()
    world.buy(p, 1, 1000)
    extra = {"hasScrap": True, "scrapPieces": pieces, "scrapKind": kind}
    if value_each:
        extra.update({"scrapKg": pieces * 12, "scrapPriceKg": value_each / 12})
    inv = world.sell([(p, 1, price)], **extra)
    rows = [b for b in world.api.get("/returns/old-batteries", view="sort") if (b.get("salesInvoice") or {}).get("id") == inv["id"]]
    assert len(rows) == pieces
    return inv, rows


def sort(world, b, **body):
    return world.api.patch(f"/returns/old-batteries/{b['id']}/sort", body)


def ob(world, b):
    return world.api.get(f"/returns/old-batteries/{b['id']}")


def send(world, batteries, supplier, receiver="مندوب"):
    world.api.post("/returns/old-batteries/send", {"ids": [b["id"] for b in batteries], "supplierId": supplier["id"], "receiverName": receiver})


def receive(world, b, product=None, wh=None, fee=0, how="BALANCE"):
    body = {"consumptionFee": fee}
    if product:
        body["replacementProductId"] = product["id"]
    if wh:
        body["replacementWarehouseId"] = wh["id"]
    if fee:
        body["feeSettlement"] = how
        if how == "CASH":
            body["methodId"] = world.cash["id"]
    return world.api.patch(f"/returns/old-batteries/{b['id']}/receive", body)


class Snap:
    """لقطة للحسابات قبل الخطوة عشان نقيس الفرق بعدها."""

    def __init__(self, world, supplier=None):
        self.world = world
        self.supplier = supplier
        self.cash = world.account(world.cash)
        self.sup = world.supplier_balance(supplier) if supplier else 0
        rep = world.profit()
        self.revenue, self.cogs, self.expenses, self.net = rep["revenue"], rep["cogs"], rep["expenses"], rep["netProfit"]

    def delta(self):
        rep = self.world.profit()
        return {
            "cash": round(self.world.account(self.world.cash) - self.cash, 2),
            "supplier": round(self.world.supplier_balance(self.supplier) - self.sup, 2) if self.supplier else 0,
            "revenue": round(rep["revenue"] - self.revenue, 2),
            "cogs": round(rep["cogs"] - self.cogs, 2),
            "expenses": round(rep["expenses"] - self.expenses, 2),
            "net": round(rep["netProfit"] - self.net, 2),
        }


def used_wh(world):
    w = world.api.get("/returns/old-batteries/config")["usedWarehouse"]
    return {"id": w["id"], "name": w["name"]}


# ---------------- الاستلام ----------------

def test_intake_value_split_by_pieces_and_shop_owned(world):
    _, rows = intake_from_sale(world, pieces=3, value_each=250)
    assert all(near(b["intakeValue"], 250) and b["ownership"] == "SHOP" and b["decision"] == "PENDING" for b in rows)


def test_manual_intake_quantity_and_validation(world):
    p = world.product()
    made = world.api.post("/returns/old-batteries", {"kind": "MANUAL", "productId": p["id"], "quantity": 3, "intakeValue": 120, "ageBand": "OVER_YEAR"})
    assert len(made) == 3 and all(near(b["intakeValue"], 120) and b["decision"] == "PENDING" for b in made)
    world.api.fails("POST", "/returns/old-batteries", {"kind": "MANUAL"})
    world.api.fails("POST", "/returns/old-batteries", {"kind": "WARRANTY_WAIT", "productId": p["id"]})
    for b in made:
        world.api.delete(f"/returns/old-batteries/{b['id']}")


def test_production_date_sets_age_band(world):
    _, [b] = intake_from_sale(world)
    assert sort(world, b, decision="SCRAP", productionDate="2020-01-01")["ageBand"] == "OVER_YEAR"
    assert sort(world, b, decision="SCRAP", productionDate="2026-10-01")["ageBand"] == "UNDER_YEAR"
    assert sort(world, b, decision="SCRAP", productionDate=None, ageBand="OVER_YEAR")["ageBand"] == "OVER_YEAR"


# ---------------- خردة → بيع ----------------

@pytest.mark.parametrize("settlement", ["CASH", "BALANCE", "INVOICE"])
def test_scrap_path_each_settlement(world, settlement):
    trike = world.supplier("تروسيكل")
    _, rows = intake_from_sale(world, pieces=2, value_each=300)
    for b in rows:
        sort(world, b, condition="BAD", ageBand="OVER_YEAR", decision="SCRAP", weightKg=12)
    body = {"supplierId": trike["id"], "withWater": True, "grossKg": 24, "priceKg": 40, "settlement": settlement, "oldBatteryIds": [b["id"] for b in rows]}
    if settlement == "CASH":
        body["methodId"] = world.cash["id"]
    if settlement == "INVOICE":
        p = world.product()
        inv = world.buy(p, 5, 300, supplier=trike)
        body["purchaseInvoiceId"] = inv["id"]

    snap = Snap(world, trike)
    sale = world.api.post("/scrap", body)
    amount = 24 * 0.85 * 40  # 816
    assert near(sale["amount"], amount)
    d = snap.delta()
    assert near(d["revenue"], amount) and near(d["cogs"], 600) and near(d["net"], amount - 600)
    if settlement == "CASH":
        assert near(d["cash"], amount) and near(d["supplier"], 0)
    else:
        assert near(d["cash"], 0) and near(d["supplier"], -amount)
    if settlement == "INVOICE":
        assert near(world.api.get(f"/purchases/{body['purchaseInvoiceId']}")["total"], 1500 - amount)
    assert all(ob(world, b)["scrapSale"]["id"] == sale["id"] for b in rows)

    world.api.delete(f"/scrap/{sale['id']}")
    back = snap.delta()
    assert all(near(v, 0) for v in back.values()), back
    assert all(ob(world, b)["scrapSale"] is None for b in rows)


def test_scrap_sale_edit_changes_linked_batteries(world):
    trike = world.supplier("تروسيكل")
    _, rows = intake_from_sale(world, pieces=3, value_each=200)
    for b in rows:
        sort(world, b, decision="SCRAP")
    sale = world.api.post("/scrap", {"supplierId": trike["id"], "grossKg": 30, "priceKg": 25, "settlement": "BALANCE", "oldBatteryIds": [rows[0]["id"]]})
    snap = Snap(world, trike)
    world.api.patch(f"/scrap/{sale['id']}", {"supplierId": trike["id"], "grossKg": 30, "priceKg": 25, "settlement": "BALANCE", "oldBatteryIds": [b["id"] for b in rows]})
    assert near(snap.delta()["cogs"], 400)
    linked = [b["id"] for b in world.api.get(f"/scrap/{sale['id']}")["oldBatteries"]]
    assert sorted(linked) == sorted(b["id"] for b in rows)


def test_scrap_battery_linked_to_sale_cannot_be_resorted_or_deleted(world):
    trike = world.supplier("تروسيكل")
    _, [b] = intake_from_sale(world)
    sort(world, b, decision="SCRAP")
    world.api.post("/scrap", {"supplierId": trike["id"], "grossKg": 12, "priceKg": 30, "settlement": "BALANCE", "oldBatteryIds": [b["id"]]})
    world.api.fails("PATCH", f"/returns/old-batteries/{b['id']}/sort", {"decision": "PENDING"})
    world.api.fails("DELETE", f"/returns/old-batteries/{b['id']}")
    world.api.fails("POST", "/scrap", {"supplierId": trike["id"], "grossKg": 12, "priceKg": 30, "settlement": "BALANCE", "oldBatteryIds": [b["id"]]})


def test_non_scrap_battery_cannot_join_scrap_sale(world):
    trike = world.supplier("تروسيكل")
    _, [b] = intake_from_sale(world)
    world.api.fails("POST", "/scrap", {"supplierId": trike["id"], "grossKg": 12, "priceKg": 30, "settlement": "BALANCE", "oldBatteryIds": [b["id"]]})


# ---------------- مستعمل/سيرفس → بيع ----------------

def test_used_path_sell_profit(world):
    used = world.product("مستعمل", sale=900)
    wh = used_wh(world)
    _, [b] = intake_from_sale(world, value_each=350)
    sort(world, b, condition="GOOD", ageBand="OVER_YEAR", decision="USED", stockProductId=used["id"])
    assert near(world.stock(used, wh), 1)
    snap = Snap(world)
    inv = world.sell([(used, 1, 900)], wh=wh)
    d = snap.delta()
    assert near(d["revenue"], 900) and near(d["cogs"], 350) and near(d["net"], 550)
    assert near(world.sale(inv)["lines"][0]["unitCost"], 350)
    world.api.fails("PATCH", f"/returns/old-batteries/{b['id']}/sort", {"decision": "SCRAP"})
    world.api.fails("DELETE", f"/returns/old-batteries/{b['id']}")


def test_used_then_moved_back_before_sale(world):
    used = world.product("مستعمل")
    wh = used_wh(world)
    _, [b] = intake_from_sale(world)
    sort(world, b, decision="USED", stockProductId=used["id"])
    sort(world, b, decision="SCRAP")
    assert near(world.stock(used, wh), 0)
    sort(world, b, decision="USED", stockProductId=used["id"])
    sort(world, b, decision="USED", stockProductId=used["id"], notes="نفس الصنف ونفس المخزن — مفيش حركة جديدة")
    assert near(world.stock(used, wh), 1)
    world.api.delete(f"/returns/old-batteries/{b['id']}")
    assert near(world.stock(used, wh), 0)


def test_used_to_other_warehouse_and_change_product(world):
    a, c = world.product("مستعمل أ"), world.product("مستعمل ب")
    _, [b] = intake_from_sale(world)
    sort(world, b, decision="USED", stockProductId=a["id"], stockWarehouseId=world.second["id"])
    assert near(world.stock(a, world.second), 1)
    sort(world, b, decision="USED", stockProductId=c["id"], stockWarehouseId=world.second["id"])
    assert near(world.stock(a, world.second), 0) and near(world.stock(c, world.second), 1)


# ---------------- ضمان المورد — ملك المحل ----------------

@pytest.mark.parametrize("fee,how", [(0, None), (400, "BALANCE"), (400, "CASH")])
def test_shop_warranty_replacement_then_sell(world, fee, how):
    new, s = world.product(), world.supplier()
    _, [b] = intake_from_sale(world, value_each=300)
    sort(world, b, productId=new["id"], condition="BAD", ageBand="UNDER_YEAR", decision="WARRANTY")
    send(world, [b], s, "عبده كاوتشة")
    assert ob(world, b)["claimStatus"] == "SENT"

    snap = Snap(world, s)
    receive(world, b, new, world.main, fee, how or "BALANCE")
    d = snap.delta()
    assert near(world.stock(new), 1)
    cost = 300 + fee
    assert near(world.fifo(new)["layers"][-1]["unitCost"], cost)
    assert near(d["supplier"], fee if how == "BALANCE" else 0)
    assert near(d["cash"], -fee if how == "CASH" else 0)
    assert near(d["net"], 0), "استلام البديل مش ربح ولا خسارة لحد ما يتباع"

    snap2 = Snap(world, s)
    world.sell([(new, 1, 2000)])
    d2 = snap2.delta()
    assert near(d2["revenue"], 2000) and near(d2["cogs"], cost) and near(d2["net"], 2000 - cost)

    if fee:
        st = world.api.get(f"/suppliers/{s['id']}/statement")["statement"]
        assert any(r["kind"] == "warranty" and near(r["debit"], fee) for r in st)
    world.api.fails("PATCH", f"/returns/old-batteries/{b['id']}/undo-receive")


def test_warranty_swap_replacement_costs_only_the_fee(world):
    new, s = world.product(), world.supplier()
    _, [b] = intake_from_sale(world, value_each=0, kind="WARRANTY_SWAP", price=800)
    assert near(b["intakeValue"], 0) and b["source"] == "WARRANTY_SWAP"
    sort(world, b, decision="WARRANTY")
    send(world, [b], s)
    receive(world, b, new, world.main, 400, "BALANCE")
    assert near(world.fifo(new)["layers"][-1]["unitCost"], 400)


def test_undo_receive_restores_everything(world):
    new, s = world.product(), world.supplier()
    _, [b] = intake_from_sale(world)
    sort(world, b, decision="WARRANTY")
    send(world, [b], s)
    snap = Snap(world, s)
    receive(world, b, new, world.main, 250, "CASH")
    world.api.patch(f"/returns/old-batteries/{b['id']}/undo-receive")
    assert all(near(v, 0) for v in snap.delta().values())
    assert near(world.stock(new), 0) and ob(world, b)["claimStatus"] == "SENT"


def test_unsend_and_resend_to_other_supplier(world):
    s1, s2 = world.supplier(), world.supplier()
    _, [b] = intake_from_sale(world)
    sort(world, b, decision="WARRANTY")
    send(world, [b], s1, "أ")
    world.api.patch(f"/returns/old-batteries/{b['id']}/unsend")
    row = ob(world, b)
    assert row["claimStatus"] == "IN_SHOP" and row["sentAt"] is None
    send(world, [b], s2, "ب")
    row = ob(world, b)
    assert row["supplier"]["id"] == s2["id"] and row["receiverName"] == "ب"


def test_reject_paths(world):
    s, trike = world.supplier(), world.supplier("تروسيكل")
    _, [a, b] = intake_from_sale(world, pieces=2)
    for x in (a, b):
        sort(world, x, decision="WARRANTY")
    send(world, [a, b], s)
    world.api.patch(f"/returns/old-batteries/{a['id']}/reject", {"toScrap": True})
    world.api.patch(f"/returns/old-batteries/{b['id']}/reject", {"toScrap": False})
    assert ob(world, a)["decision"] == "SCRAP" and ob(world, b)["claimStatus"] == "REJECTED"
    sale = world.api.post("/scrap", {"supplierId": trike["id"], "grossKg": 12, "priceKg": 30, "settlement": "BALANCE", "oldBatteryIds": [a["id"]]})
    assert len(sale["oldBatteries"]) == 1
    sort(world, b, decision="WARRANTY")
    assert ob(world, b)["claimStatus"] == "IN_SHOP", "المرفوضة ترجع في المحل وتتبعت تاني"
    send(world, [b], world.supplier())
    world.api.patch(f"/returns/old-batteries/{b['id']}/reject", {"toScrap": False})
    sort(world, b, decision="SCRAP")
    row = ob(world, b)
    assert row["decision"] == "SCRAP" and row["claimStatus"] is None and row["sentAt"] is None


def test_warranty_step_guards(world):
    s, new = world.supplier(), world.product()
    _, [b] = intake_from_sale(world)
    world.api.fails("POST", "/returns/old-batteries/send", {"ids": [b["id"]], "supplierId": s["id"]})
    sort(world, b, decision="WARRANTY")
    world.api.fails("PATCH", f"/returns/old-batteries/{b['id']}/receive", {"replacementProductId": new["id"], "replacementWarehouseId": world.main["id"]})
    send(world, [b], s)
    world.api.fails("PATCH", f"/returns/old-batteries/{b['id']}/sort", {"decision": "SCRAP"})
    world.api.fails("PATCH", f"/returns/old-batteries/{b['id']}/receive", {"replacementProductId": new["id"]})
    world.api.fails("PATCH", f"/returns/old-batteries/{b['id']}/receive", {"replacementProductId": new["id"], "replacementWarehouseId": world.main["id"], "consumptionFee": 100})
    receive(world, b, new, world.main)
    world.api.fails("POST", "/returns/old-batteries/send", {"ids": [b["id"]], "supplierId": s["id"]})
    world.api.fails("PATCH", f"/returns/old-batteries/{b['id']}/deliver")
    world.api.fails("DELETE", f"/returns/old-batteries/{b['id']}")


# ---------------- ضمان الزبون ----------------

def test_customer_warranty_full_cycle_and_undo(world):
    p, s = world.product(), world.supplier()
    [w] = world.api.post("/returns/old-batteries", {"kind": "WARRANTY_WAIT", "productId": p["id"], "customerName": "زبون ضمان", "customerPhone": "0123", "ageBand": "UNDER_YEAR"})
    assert w["ownership"] == "CUSTOMER" and near(w["intakeValue"], 0) and w["decision"] == "WARRANTY"
    send(world, [w], s)
    snap = Snap(world, s)
    receive(world, w, p)
    assert all(near(v, 0) for v in snap.delta().values()), "ضمان الزبون من غير استهلاك مالوش أثر مالي"
    assert near(world.stock(p), 0)
    world.api.patch(f"/returns/old-batteries/{w['id']}/deliver")
    assert ob(world, w)["claimStatus"] == "DELIVERED"
    world.api.patch(f"/returns/old-batteries/{w['id']}/undo-deliver")
    world.api.patch(f"/returns/old-batteries/{w['id']}/undo-receive")
    assert ob(world, w)["claimStatus"] == "SENT"


def test_customer_warranty_with_fee_hits_supplier(world):
    p, s = world.product(), world.supplier()
    [w] = world.api.post("/returns/old-batteries", {"kind": "WARRANTY_WAIT", "productId": p["id"], "customerName": "زبون ضمان"})
    send(world, [w], s)
    snap = Snap(world, s)
    receive(world, w, p, fee=150, how="BALANCE")
    assert near(snap.delta()["supplier"], 150)


def test_customer_warranty_cannot_be_scrapped(world):
    p = world.product()
    [w] = world.api.post("/returns/old-batteries", {"kind": "WARRANTY_WAIT", "productId": p["id"], "customerName": "زبون"})
    for decision in ("SCRAP", "USED", "PENDING"):
        world.api.fails("PATCH", f"/returns/old-batteries/{w['id']}/sort", {"decision": decision, "stockProductId": p["id"]})
    bulk = world.api.post("/returns/old-batteries/sort-bulk", {"ids": [w["id"]], "decision": "SCRAP"})
    assert bulk["done"] == 0 and len(bulk["errors"]) == 1


# ---------------- الربط بفاتورة البيع ----------------

def test_invoice_edit_keeps_sorted_batteries(world):
    p = world.product()
    world.buy(p, 2, 1000)
    c = world.customer()
    inv = world.sell([(p, 1, 1500)], customer=c, hasScrap=True, scrapPieces=3, scrapKg=36, scrapPriceKg=25)
    rows = [b for b in world.api.get("/returns/old-batteries", view="sort") if (b.get("salesInvoice") or {}).get("id") == inv["id"]]
    sort(world, rows[0], decision="SCRAP")
    sort(world, rows[1], decision="SCRAP")
    full = world.sale(inv)
    world.api.patch(f"/sales/{inv['id']}", {
        "customerId": c["id"], "warehouseId": world.main["id"], "hasScrap": True, "scrapPieces": 1, "scrapKg": 12, "scrapPriceKg": 25,
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 1, "unitPrice": 1500}],
    })
    linked = [b for b in world.api.get("/returns/old-batteries") if (b.get("salesInvoice") or {}).get("id") == inv["id"]]
    assert len(linked) == 2 and all(b["decision"] == "SCRAP" for b in linked), "المفروزين مبيتمسحوش"
    world.api.delete(f"/sales/{inv['id']}")
    kept = [b for b in world.api.get("/returns/old-batteries") if b["id"] in {rows[0]["id"], rows[1]["id"]}]
    assert len(kept) == 2 and all(b["salesInvoice"] is None for b in kept)


def test_draft_sale_has_no_old_batteries_until_confirmed(world):
    p = world.product()
    world.buy(p, 1, 1000)
    inv = world.sell([(p, 1, 1500)], confirm=False, hasScrap=True, scrapPieces=2, scrapKg=24, scrapPriceKg=25)
    mine = lambda: [b for b in world.api.get("/returns/old-batteries", view="sort") if (b.get("salesInvoice") or {}).get("id") == inv["id"]]
    assert mine() == []
    world.api.post(f"/sales/{inv['id']}/confirm", {})
    assert len(mine()) == 2


# ---------------- الفرز الجماعي ----------------

def test_bulk_sort_full_night(world):
    used, s, trike = world.product("مستعمل"), world.supplier(), world.supplier("تروسيكل")
    _, rows = intake_from_sale(world, pieces=6, value_each=200)
    ids = [b["id"] for b in rows]
    r1 = world.api.post("/returns/old-batteries/sort-bulk", {"ids": ids[:3], "decision": "SCRAP", "condition": "BAD", "ageBand": "OVER_YEAR"})
    r2 = world.api.post("/returns/old-batteries/sort-bulk", {"ids": ids[3:5], "decision": "USED", "condition": "GOOD", "ageBand": "OVER_YEAR", "stockProductId": used["id"]})
    r3 = world.api.post("/returns/old-batteries/sort-bulk", {"ids": ids[5:], "decision": "WARRANTY", "condition": "BAD", "ageBand": "UNDER_YEAR", "supplierId": s["id"]})
    assert (r1["done"], r2["done"], r3["done"]) == (3, 2, 1)
    assert near(world.stock(used, used_wh(world)), 2)
    pile = {b["id"] for b in world.api.get("/scrap/pile")}
    assert set(ids[:3]) <= pile
    sale = world.api.post("/scrap", {"supplierId": trike["id"], "grossKg": 36, "priceKg": 30, "settlement": "BALANCE", "oldBatteryIds": ids[:3]})
    assert len(sale["oldBatteries"]) == 3
    assert ob(world, rows[5])["claimStatus"] == "IN_SHOP" and ob(world, rows[5])["supplier"]["id"] == s["id"]


# ---------------- التقارير ----------------

def test_old_batteries_report_tracks_everything(world):
    rep0 = world.api.get("/reports/old-batteries")
    used, s, trike = world.product("مستعمل"), world.supplier(), world.supplier("تروسيكل")
    _, rows = intake_from_sale(world, pieces=4, value_each=100)
    sort(world, rows[0], decision="SCRAP")
    sort(world, rows[1], decision="USED", stockProductId=used["id"])
    sort(world, rows[2], decision="WARRANTY")
    send(world, [rows[2]], s)
    new = world.product()
    receive(world, rows[2], new, world.main, 50, "BALANCE")
    sale = world.api.post("/scrap", {"supplierId": trike["id"], "grossKg": 12, "priceKg": 20, "settlement": "BALANCE", "oldBatteryIds": [rows[0]["id"]]})
    rep = world.api.get("/reports/old-batteries")
    assert rep["intake"]["count"] - rep0["intake"]["count"] == 4
    assert near(rep["intake"]["saleScrap"]["value"] - rep0["intake"]["saleScrap"]["value"], 400)
    assert rep["sorted"]["scrap"] - rep0["sorted"]["scrap"] == 1
    assert rep["sorted"]["used"] - rep0["sorted"]["used"] == 1
    assert rep["sorted"]["warranty"] - rep0["sorted"]["warranty"] == 1
    assert rep["now"]["toSort"] - rep0["now"]["toSort"] == 1
    assert near(rep["warranty"]["fees"] - rep0["warranty"]["fees"], 50)
    assert near(rep["warranty"]["replacementCost"] - rep0["warranty"]["replacementCost"], 150)
    row = next(r for r in rep["scrapSales"]["rows"] if r["number"] == sale["number"])
    assert near(row["amount"], 240) and near(row["cost"], 100) and near(row["profit"], 140)


def test_journal_reconciles_with_cash_and_stock(world):
    """دفتر الحركة لازم يطابق تقرير الخزنة وحركات المخزون بالظبط."""
    used, s, trike = world.product("مستعمل"), world.supplier(), world.supplier("تروسيكل")
    _, rows = intake_from_sale(world, pieces=3, value_each=100)
    sort(world, rows[0], decision="SCRAP")
    sort(world, rows[1], decision="USED", stockProductId=used["id"])
    sort(world, rows[2], decision="WARRANTY")
    send(world, [rows[2]], s, "عبده")
    new = world.product()
    receive(world, rows[2], new, world.main, 120, "CASH")
    world.api.post("/scrap", {"supplierId": trike["id"], "grossKg": 12, "priceKg": 20, "settlement": "CASH", "methodId": world.cash["id"], "oldBatteryIds": [rows[0]["id"]]})

    journal = world.api.get("/reports/journal")
    cash = world.api.get("/reports/cash")
    assert near(journal["totals"]["cashIn"], cash["totalIn"]) and near(journal["totals"]["cashOut"], cash["totalOut"])
    kinds = {r["kind"] for r in journal["rows"]}
    for k in ("استلام بطارية قديمة", "فرز بطارية", "إرسال ضمان للمورد", "وصل بديل ضمان", "استهلاك ضمان", "دخول مستعمل/سيرفس", "بيع خردة", "فاتورة بيع"):
        assert k in kinds, f"journal missing {k}"
    fee_row = next(r for r in journal["rows"] if r["reference"] == f"{rows[2]['number']}-FEE")
    assert near(fee_row["cashOut"], 120)
    rpl_row = next(r for r in journal["rows"] if r["reference"] == f"{rows[2]['number']}-RPL")
    assert near(rpl_row["goodsIn"], 1) and near(rpl_row["value"], 220)

    # البضاعة في الدفتر = مجموع حركات المخزون كلها
    total_in = total_out = 0
    for wh in world.api.get("/warehouses", includeSystem="1"):
        for row in world.api.get("/stock/movements", warehouseId=wh["id"], page="1", pageSize="100000")["items"]:
            if row["quantity"] > 0:
                total_in += row["quantity"]
            else:
                total_out += -row["quantity"]
    assert near(journal["totals"]["goodsIn"], total_in) and near(journal["totals"]["goodsOut"], total_out)


def test_journal_date_filter(world):
    empty = world.api.get("/reports/journal", **{"from": "2000-01-01", "to": "2000-01-02"})
    assert empty["rows"] == [] and empty["totals"]["cashIn"] == 0
