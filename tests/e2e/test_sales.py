"""البيع بكل الطرق وأثره على المخزون، FIFO، حساب العميل، الخزنة، والأرباح."""
from conftest import near


# ---------------- الدفع ----------------

def test_cash_sale_full_payment(world):
    p = world.product()
    world.buy(p, 10, 100)
    cash0 = world.account(world.cash)
    c = world.customer()
    inv = world.sell([(p, 3, 150)], customer=c, payments=[world.pay(world.cash, 450)])

    assert inv["status"] == "PAID" and near(inv["total"], 450) and near(inv["paidAmount"], 450)
    assert near(world.stock(p), 7)
    assert near(world.customer_balance(c), 0)
    assert near(world.account(world.cash) - cash0, 450)
    full = world.sale(inv)
    assert len(full["receipts"]) == 1 and near(full["receipts"][0]["amount"], 450)
    assert near(full["lines"][0]["unitCost"], 100)


def test_credit_sale_then_collect(world):
    p = world.product()
    world.buy(p, 5, 100)
    c = world.customer()
    inv = world.sell([(p, 2, 300)], customer=c)
    assert inv["status"] == "CONFIRMED"
    assert near(world.customer_balance(c), 600)

    cash0 = world.account(world.cash)
    world.api.post("/cash/receipts", {"customerId": c["id"], "methodId": world.cash["id"], "amount": 250, "salesInvoiceId": inv["id"]})
    mid = world.sale(inv)
    assert mid["status"] == "PARTIAL" and near(mid["paidAmount"], 250)
    assert near(world.customer_balance(c), 350)

    world.api.post("/cash/receipts", {"customerId": c["id"], "methodId": world.cash["id"], "amount": 350})
    assert world.sale(inv)["status"] == "PAID"
    assert near(world.customer_balance(c), 0)
    assert near(world.account(world.cash) - cash0, 600)


def test_split_tenders_cash_and_bank(world):
    p = world.product()
    world.buy(p, 5, 100)
    c = world.customer()
    cash0, bank0 = world.account(world.cash), world.account(world.bank)
    inv = world.sell([(p, 2, 500)], customer=c, payments=[world.pay(world.cash, 300), world.pay(world.bank, 500)])
    assert inv["status"] == "PARTIAL"
    assert near(world.account(world.cash) - cash0, 300)
    assert near(world.account(world.bank) - bank0, 500)
    assert near(world.customer_balance(c), 200)


def test_check_payment_does_not_hit_cash(world):
    p = world.product()
    world.buy(p, 2, 100)
    c = world.customer()
    cash0 = world.account(world.cash)
    inv = world.sell([(p, 1, 400)], customer=c, payments=[world.pay(world.check, 400)])
    assert inv["status"] == "PAID"
    assert near(world.account(world.cash), cash0)
    assert near(world.customer_balance(c), 0)


def test_discount_and_tax(world):
    p = world.product()
    world.buy(p, 5, 50)
    inv = world.sell([(p, 2, 100)], discount=20, taxRate=14)
    # (200 - 20) + 14% = 205.2
    assert near(inv["subtotal"], 200) and near(inv["discount"], 20)
    assert near(inv["tax"], 25.2) and near(inv["total"], 205.2)


def test_line_discount(world):
    p = world.product()
    world.buy(p, 5, 50)
    c = world.customer()
    inv = world.api.post("/sales", {
        "customerId": c["id"], "warehouseId": world.main["id"], "confirm": True,
        "lines": [{"productId": p["id"], "quantity": 2, "unitPrice": 100, "discount": 30}],
    })
    world.touched_customers.add(c["id"])
    assert near(inv["total"], 170)


def test_walk_in_customer_cash(world):
    walk_in = next(c for c in world.api.get("/customers") if c["name"] == "عميل سريع")
    world.touched_customers.add(walk_in["id"])
    p = world.product()
    world.buy(p, 3, 100)
    before = world.customer_balance(walk_in)
    world.sell([(p, 1, 200)], customer=walk_in, payments=[world.pay(world.cash, 200)])
    assert near(world.customer_balance(walk_in), before)


# ---------------- مسودة / تأكيد / رفض ----------------

def test_draft_then_confirm(world):
    p = world.product()
    world.buy(p, 4, 100)
    c = world.customer()
    draft = world.sell([(p, 3, 200)], customer=c, confirm=False)
    assert draft["status"] == "DRAFT"
    assert near(world.stock(p), 4) and near(world.customer_balance(c), 0)

    world.api.post(f"/sales/{draft['id']}/confirm", {"payments": [world.pay(world.cash, 100)]})
    assert near(world.stock(p), 1)
    assert near(world.customer_balance(c), 500)
    assert world.sale(draft)["status"] == "PARTIAL"
    world.api.fails("POST", f"/sales/{draft['id']}/confirm", {})


def test_draft_delete_has_no_effect(world):
    p = world.product()
    world.buy(p, 2, 100)
    draft = world.sell([(p, 2, 200)], confirm=False)
    world.api.delete(f"/sales/{draft['id']}")
    assert near(world.stock(p), 2)


def test_rejects_overstock_and_overpay(world):
    p = world.product()
    world.buy(p, 2, 100)
    c = world.customer()
    world.api.fails("POST", "/sales", {"customerId": c["id"], "warehouseId": world.main["id"], "confirm": True, "lines": [{"productId": p["id"], "quantity": 3, "unitPrice": 100}]})
    world.api.fails("POST", "/sales", {
        "customerId": c["id"], "warehouseId": world.main["id"], "confirm": True,
        "lines": [{"productId": p["id"], "quantity": 1, "unitPrice": 100}],
        "payments": [world.pay(world.cash, 150)],
    })
    world.api.fails("POST", "/sales", {"customerId": c["id"], "warehouseId": world.main["id"], "confirm": True, "lines": []})
    world.api.fails("POST", "/sales", {"customerId": c["id"], "warehouseId": world.second["id"], "confirm": True, "lines": [{"productId": p["id"], "quantity": 1, "unitPrice": 100}]})
    assert near(world.stock(p), 2) and near(world.customer_balance(c), 0)


# ---------------- FIFO ----------------

def test_fifo_across_batches_and_preview(world):
    p = world.product()
    b1 = world.buy(p, 1, 1000)
    b2 = world.buy(p, 3, 1100)
    preview = world.api.get("/sales/fifo-preview", warehouseId=world.main["id"], lines=f"{p['id']}:2")
    assert near(preview[0]["unitCost"], 1050) and near(preview[0]["totalCost"], 2100)
    two_lines = world.api.get("/sales/fifo-preview", warehouseId=world.main["id"], lines=f"{p['id']}:1,{p['id']}:1")
    assert near(two_lines[0]["unitCost"], 1000) and near(two_lines[1]["unitCost"], 1100)

    inv = world.sell([(p, 2, 1500)])
    alloc = world.sale_fifo(inv)["lines"][0]["allocations"]
    assert [(a["reference"], a["quantity"]) for a in alloc] == [(b1["number"], 1), (b2["number"], 1)]
    assert near(world.sale(inv)["lines"][0]["unitCost"], 1050)
    batches = world.fifo(p)
    assert near(batches["remainingQty"], 2) and near(batches["remainingValue"], 2200)


def test_fifo_same_product_two_lines(world):
    p = world.product()
    world.buy(p, 1, 100)
    world.buy(p, 1, 200)
    inv = world.sell([(p, 1, 300), (p, 1, 300)])
    costs = [line["unitCost"] for line in world.sale_fifo(inv)["lines"]]
    assert sorted(costs) == [100, 200]


def test_purchase_cost_edit_recosts_sales(world):
    p = world.product()
    s = world.supplier()
    b1 = world.buy(p, 2, 100, supplier=s)
    inv = world.sell([(p, 2, 200)])
    full = world.api.get(f"/purchases/{b1['id']}")
    world.api.patch(f"/purchases/{b1['id']}", {
        "supplierId": s["id"], "warehouseId": world.main["id"],
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 2, "unitCost": 80}],
    })
    assert near(world.sale(inv)["lines"][0]["unitCost"], 80)


def test_transfer_keeps_batch_cost(world):
    p = world.product()
    b = world.buy(p, 3, 120)
    world.api.post("/stock/transfers", {"fromWarehouseId": world.main["id"], "toWarehouseId": world.second["id"], "lines": [{"productId": p["id"], "quantity": 2}]})
    inv = world.sell([(p, 1, 300)], wh=world.second)
    alloc = world.sale_fifo(inv)["lines"][0]["allocations"][0]
    assert near(alloc["unitCost"], 120) and alloc["reference"] == b["number"]


# ---------------- تعديل وحذف ----------------

def test_edit_posted_sale_quantity_price_and_payments(world):
    p = world.product()
    world.buy(p, 10, 100)
    c = world.customer()
    inv = world.sell([(p, 3, 200)], customer=c, payments=[world.pay(world.cash, 200)])
    cash0 = world.account(world.cash)
    full = world.sale(inv)
    world.api.patch(f"/sales/{inv['id']}", {
        "customerId": c["id"], "warehouseId": world.main["id"],
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 5, "unitPrice": 220}],
        "payments": [{"id": full["receipts"][0]["id"], "methodId": world.cash["id"], "amount": 500}],
    })
    after = world.sale(inv)
    assert near(after["total"], 1100) and near(after["paidAmount"], 500) and after["status"] == "PARTIAL"
    assert near(world.stock(p), 5)
    assert near(world.customer_balance(c), 600)
    assert near(world.account(world.cash) - cash0, 300)


def test_edit_posted_sale_change_product_and_warehouse(world):
    p1, p2 = world.product(), world.product()
    world.buy(p1, 5, 100)
    world.buy(p2, 5, 300, wh=world.second)
    c = world.customer()
    inv = world.sell([(p1, 2, 200)], customer=c)
    full = world.sale(inv)
    world.api.patch(f"/sales/{inv['id']}", {
        "customerId": c["id"], "warehouseId": world.second["id"],
        "lines": [{"id": full["lines"][0]["id"], "productId": p2["id"], "quantity": 1, "unitPrice": 500}],
    })
    assert near(world.stock(p1), 5)
    assert near(world.stock(p2, world.second), 4)
    assert near(world.customer_balance(c), 500)
    assert near(world.sale(inv)["lines"][0]["unitCost"], 300)


def test_edit_posted_sale_change_customer(world):
    p = world.product()
    world.buy(p, 2, 100)
    a, b = world.customer(), world.customer()
    inv = world.sell([(p, 1, 400)], customer=a)
    full = world.sale(inv)
    world.api.patch(f"/sales/{inv['id']}", {
        "customerId": b["id"], "warehouseId": world.main["id"],
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 1, "unitPrice": 400}],
    })
    assert near(world.customer_balance(a), 0) and near(world.customer_balance(b), 400)


def test_edit_rejects_overstock(world):
    p = world.product()
    world.buy(p, 3, 100)
    c = world.customer()
    inv = world.sell([(p, 2, 200)], customer=c)
    full = world.sale(inv)
    world.api.fails("PATCH", f"/sales/{inv['id']}", {
        "customerId": c["id"], "warehouseId": world.main["id"],
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 4, "unitPrice": 200}],
    })
    assert near(world.stock(p), 1) and near(world.customer_balance(c), 400)


def test_delete_posted_sale_reverses_everything(world):
    p = world.product()
    world.buy(p, 4, 100)
    c = world.customer()
    cash0 = world.account(world.cash)
    inv = world.sell([(p, 3, 200)], customer=c, payments=[world.pay(world.cash, 250)])
    world.api.delete(f"/sales/{inv['id']}")
    assert near(world.stock(p), 4)
    assert near(world.customer_balance(c), 0)
    assert near(world.account(world.cash), cash0)
    world.api.fails("GET", f"/sales/{inv['id']}")


# ---------------- الخردة مع البيع والربح ----------------

def test_sale_below_cost_with_scrap_profit(world):
    p = world.product()
    world.buy(p, 2, 1000)
    c = world.customer()
    profit0 = world.profit()
    inv = world.sell([(p, 1, 900)], customer=c, hasScrap=True, scrapPieces=1, scrapKg=12, scrapPriceKg=25)
    assert near(inv["total"], 900), "الخردة مش مطلوبة من العميل"
    assert near(world.customer_balance(c), 900)
    full = world.sale(inv)
    profit = full["subtotal"] - full["discount"] + full["scrapAmount"] - sum(l["quantity"] * l["unitCost"] for l in full["lines"])
    assert near(profit, 200)
    profit1 = world.profit()
    assert near(profit1["revenue"] - profit0["revenue"], 1200)
    assert near(profit1["cogs"] - profit0["cogs"], 1000)


def test_sale_scrap_creates_old_batteries_and_sync_on_edit_delete(world):
    p = world.product()
    world.buy(p, 3, 1000)
    c = world.customer()
    inv = world.sell([(p, 1, 1500)], customer=c, hasScrap=True, scrapPieces=3, scrapKg=36, scrapPriceKg=25)

    def mine():
        return [b for b in world.api.get("/returns/old-batteries", view="sort") if (b.get("salesInvoice") or {}).get("id") == inv["id"]]

    assert len(mine()) == 3 and all(near(b["intakeValue"], 300) for b in mine())
    full = world.sale(inv)
    world.api.patch(f"/sales/{inv['id']}", {
        "customerId": c["id"], "warehouseId": world.main["id"], "hasScrap": True, "scrapPieces": 2, "scrapKg": 30, "scrapPriceKg": 25,
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 1, "unitPrice": 1500}],
    })
    assert len(mine()) == 2 and all(near(b["intakeValue"], 375) for b in mine())
    world.api.delete(f"/sales/{inv['id']}")
    assert len(mine()) == 0


def test_warranty_swap_sale_without_scrap_value(world):
    p = world.product()
    world.buy(p, 2, 1600)
    inv = world.sell([(p, 1, 800)], hasScrap=True, scrapKind="WARRANTY_SWAP", scrapPieces=1)
    assert near(inv["total"], 800)
    rows = [b for b in world.api.get("/returns/old-batteries", view="sort") if (b.get("salesInvoice") or {}).get("id") == inv["id"]]
    assert len(rows) == 1 and rows[0]["source"] == "WARRANTY_SWAP" and rows[0]["ownership"] == "SHOP" and near(rows[0]["intakeValue"], 0)


def test_customer_statement_matches_balance(world):
    p = world.product()
    world.buy(p, 5, 100)
    c = world.customer()
    world.sell([(p, 1, 300)], customer=c, discount=50)
    world.sell([(p, 2, 200)], customer=c, payments=[world.pay(world.cash, 100)])
    world.api.post("/cash/receipts", {"customerId": c["id"], "methodId": world.bank["id"], "amount": 150})
    st = world.api.get(f"/customers/{c['id']}/statement")
    assert near(st["statement"][-1]["balance"], 250 + 400 - 100 - 150)
    assert near(world.customer_balance(c), 400)


def test_sales_report_and_dues(world):
    p = world.product()
    world.buy(p, 3, 100)
    c = world.customer()
    before = world.api.get("/reports/sales")
    inv = world.sell([(p, 1, 777)], customer=c)
    after = world.api.get("/reports/sales")
    assert near(after["total"] - before["total"], 777)
    dues = world.api.get("/sales/dues")
    assert any(d["customerId"] == c["id"] and near(d["total"] - d["paidAmount"], 777) for d in dues)
    assert inv["number"].startswith("SAL-")
