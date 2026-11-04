"""حالات الفلوس اللي بتبوظ عادةً: تحصيل/سداد لاحق ثم تعديل أو حذف الفاتورة."""
from conftest import near


def test_delete_sale_after_later_collection(world):
    p = world.product()
    world.buy(p, 3, 100)
    c = world.customer()
    cash0 = world.account(world.cash)
    inv = world.sell([(p, 2, 300)], customer=c)
    world.api.post("/cash/receipts", {"customerId": c["id"], "methodId": world.cash["id"], "amount": 400, "salesInvoiceId": inv["id"]})
    assert near(world.account(world.cash) - cash0, 400)
    world.api.delete(f"/sales/{inv['id']}")
    assert near(world.account(world.cash), cash0), "التحصيل اللي على الفاتورة لازم يرجع من الخزنة"
    assert near(world.customer_balance(c), 0)
    assert near(world.stock(p), 3)


def test_edit_sale_keeps_later_collection(world):
    p = world.product()
    world.buy(p, 5, 100)
    c = world.customer()
    inv = world.sell([(p, 2, 300)], customer=c)
    world.api.post("/cash/receipts", {"customerId": c["id"], "methodId": world.cash["id"], "amount": 200, "salesInvoiceId": inv["id"]})
    cash0 = world.account(world.cash)
    full = world.sale(inv)
    world.api.patch(f"/sales/{inv['id']}", {
        "customerId": c["id"], "warehouseId": world.main["id"],
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 3, "unitPrice": 300}],
        "payments": world.receipts_payload(inv),
    })
    after = world.sale(inv)
    assert near(after["total"], 900) and near(after["paidAmount"], 200)
    assert near(world.customer_balance(c), 700)
    assert near(world.account(world.cash), cash0)


def test_customer_overpayment_becomes_credit(world):
    p = world.product()
    world.buy(p, 2, 100)
    c = world.customer()
    world.sell([(p, 1, 300)], customer=c)
    world.api.post("/cash/receipts", {"customerId": c["id"], "methodId": world.cash["id"], "amount": 500})
    assert near(world.customer_balance(c), -200)


def test_purchase_payments_and_delete(world):
    p, s = world.product(), world.supplier()
    cash0 = world.account(world.cash)
    inv = world.buy(p, 4, 250, supplier=s, payments=[world.pay(world.cash, 400)])
    assert near(cash0 - world.account(world.cash), 400)
    assert near(world.supplier_balance(s), 600)
    world.api.post("/cash/payments", {"supplierId": s["id"], "methodId": world.cash["id"], "amount": 100, "purchaseInvoiceId": inv["id"]})
    assert near(world.supplier_balance(s), 500)
    world.api.delete(f"/purchases/{inv['id']}")
    assert near(world.account(world.cash), cash0), "كل السداد على الفاتورة يرجع الخزنة"
    assert near(world.supplier_balance(s), 0)
    assert near(world.stock(p), 0)


def test_purchase_edit_posted_cost_and_payment(world):
    p, s = world.product(), world.supplier()
    inv = world.buy(p, 2, 100, supplier=s, payments=[world.pay(world.cash, 50)])
    cash0 = world.account(world.cash)
    full = world.api.get(f"/purchases/{inv['id']}")
    world.api.patch(f"/purchases/{inv['id']}", {
        "supplierId": s["id"], "warehouseId": world.main["id"],
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 3, "unitCost": 120}],
        "payments": [{"id": full["payments"][0]["id"], "methodId": world.cash["id"], "amount": 160}],
    })
    assert near(world.stock(p), 3)
    assert near(world.supplier_balance(s), 360 - 160)
    assert near(cash0 - world.account(world.cash), 110)
    assert near(world.fifo(p)["remainingValue"], 360)


def test_profit_report_net_equals_parts(world):
    rep = world.profit()
    assert near(rep["netProfit"], rep["revenue"] - rep["cogs"] - rep["expenses"])
    assert near(rep["operatingProfit"], rep["revenue"] - rep["cogs"])
    lines_in = sum(l["amount"] for l in rep["lines"] if l["side"] == "IN" and l["kind"] in ("REVENUE",))
    lines_out = sum(l["amount"] for l in rep["lines"] if l["side"] == "OUT" and l["kind"] in ("RETURN", "DISCOUNT"))
    assert near(rep["revenue"], lines_in - lines_out, 0.05)
