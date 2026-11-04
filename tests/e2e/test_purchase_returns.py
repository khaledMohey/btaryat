"""مرتجع الشراء: خصم المخزون وحساب المورد، الحدود، التعديل، الحذف، والاستلام البديل."""
from conftest import near


def pr(world, supplier, product, qty, cost, wh=None):
    return world.api.post("/returns/purchases", {
        "supplierId": supplier["id"],
        "warehouseId": (wh or world.main)["id"],
        "lines": [{"productId": product["id"], "quantity": qty, "unitCost": cost}],
    })


def test_purchase_return_reduces_stock_and_supplier(world):
    p, s = world.product(), world.supplier()
    world.buy(p, 10, 100, supplier=s)
    assert near(world.supplier_balance(s), 1000)
    ret = pr(world, s, p, 3, 100)
    assert near(ret["total"], 300)
    assert near(world.stock(p), 7)
    assert near(world.supplier_balance(s), 700)


def test_purchase_return_consumption_fee_balance_and_cash(world):
    p, s = world.product(), world.supplier()
    world.buy(p, 10, 100, supplier=s)
    profit0 = world.profit()
    ret = world.api.post("/returns/purchases", {
        "supplierId": s["id"], "warehouseId": world.main["id"], "consumptionFee": 50, "feeSettlement": "BALANCE",
        "lines": [{"productId": p["id"], "quantity": 2, "unitCost": 100}],
    })
    assert near(world.supplier_balance(s), 1000 - 200 + 50)
    assert near(world.profit()["expenses"] - profit0["expenses"], 50)

    cash0 = world.account(world.cash)
    world.api.patch(f"/returns/purchases/{ret['id']}", {
        "warehouseId": world.main["id"], "consumptionFee": 80, "feeSettlement": "CASH", "methodId": world.cash["id"],
        "lines": [{"productId": p["id"], "quantity": 2, "unitCost": 100}],
    })
    assert near(world.supplier_balance(s), 800)
    assert near(cash0 - world.account(world.cash), 80)
    st = world.api.get(f"/suppliers/{s['id']}/statement")
    assert any(r["type"] == "استهلاك مرتجع شراء" and near(r["debit"], 80) for r in st["statement"])

    world.api.delete(f"/returns/purchases/{ret['id']}")
    assert near(world.account(world.cash), cash0)
    assert near(world.supplier_balance(s), 1000)
    world.api.fails("POST", "/returns/purchases", {
        "supplierId": s["id"], "warehouseId": world.main["id"], "consumptionFee": 30,
        "lines": [{"productId": p["id"], "quantity": 1, "unitCost": 100}],
    })


def test_purchase_return_limits(world):
    p, s, other = world.product(), world.supplier(), world.supplier()
    world.buy(p, 4, 100, supplier=s)
    world.sell([(p, 3, 200)])
    world.api.fails("POST", "/returns/purchases", {"supplierId": s["id"], "warehouseId": world.main["id"], "lines": [{"productId": p["id"], "quantity": 2, "unitCost": 100}]})
    world.api.fails("POST", "/returns/purchases", {"supplierId": other["id"], "warehouseId": world.main["id"], "lines": [{"productId": p["id"], "quantity": 1, "unitCost": 100}]})
    world.api.fails("POST", "/returns/purchases", {"supplierId": s["id"], "warehouseId": world.main["id"], "lines": [{"productId": p["id"], "quantity": 0, "unitCost": 100}]})
    pr(world, s, p, 1, 100)
    assert near(world.stock(p), 0)


def test_update_purchase_return(world):
    p, s = world.product(), world.supplier()
    world.buy(p, 10, 100, supplier=s)
    ret = pr(world, s, p, 2, 100)
    world.api.patch(f"/returns/purchases/{ret['id']}", {"warehouseId": world.main["id"], "lines": [{"productId": p["id"], "quantity": 5, "unitCost": 90}]})
    assert near(world.stock(p), 5)
    assert near(world.supplier_balance(s), 1000 - 450)


def test_delete_purchase_return(world):
    p, s = world.product(), world.supplier()
    world.buy(p, 5, 100, supplier=s)
    ret = pr(world, s, p, 2, 100)
    world.api.delete(f"/returns/purchases/{ret['id']}")
    assert near(world.stock(p), 5)
    assert near(world.supplier_balance(s), 500)


def test_restock_partial_into_other_warehouse(world):
    p, s = world.product(), world.supplier()
    world.buy(p, 5, 100, supplier=s)
    ret = pr(world, s, p, 3, 100)
    world.api.post(f"/returns/purchases/{ret['id']}/restock", {"warehouseId": world.second["id"], "lines": [{"productId": p["id"], "quantity": 2}]})
    assert near(world.stock(p, world.second), 2)
    assert near(world.supplier_balance(s), 500 - 300 + 200)
    world.api.fails("POST", f"/returns/purchases/{ret['id']}/restock", {"warehouseId": world.second["id"], "lines": [{"productId": p["id"], "quantity": 2}]})
    fifo = world.fifo(p, world.second)
    assert near(fifo["remainingValue"], 200)
    st = world.api.get(f"/suppliers/{s['id']}/statement")
    kinds = [r["kind"] for r in st["statement"]]
    assert "purchase_return" in kinds and "restock" in kinds


def test_delete_return_reverses_restock(world):
    p, s = world.product(), world.supplier()
    world.buy(p, 5, 100, supplier=s)
    ret = pr(world, s, p, 2, 100)
    world.api.post(f"/returns/purchases/{ret['id']}/restock", {"warehouseId": world.main["id"], "lines": [{"productId": p["id"], "quantity": 2}]})
    world.api.delete(f"/returns/purchases/{ret['id']}")
    assert near(world.stock(p), 5)
    assert near(world.supplier_balance(s), 500)


def test_return_from_returns_warehouse(world):
    p, s = world.product(cost=100), world.supplier()
    world.buy(p, 2, 100, supplier=s)
    world.api.post("/returns/sales", {"productId": p["id"]})
    products = world.api.get(f"/returns/purchases/products/{s['id']}", warehouseId=world.returns_wh["id"])["products"]
    row = next(r for r in products if r["productId"] == p["id"])
    assert near(row["remainingQty"], 1)
    pr(world, s, p, 1, 100, wh=world.returns_wh)
    assert near(world.stock(p, world.returns_wh), 0)
    assert near(world.supplier_balance(s), 100)


def test_purchase_edit_after_supplier_return(world):
    """مرتجع الشراء مش مربوط بفاتورة: تعديل الفاتورة مسموح طالما المخزون يكفي، والحذف بيترفض لو جزء اتصرف."""
    p, s = world.product(), world.supplier()
    inv = world.buy(p, 5, 100, supplier=s)
    pr(world, s, p, 1, 100)
    world.api.fails("DELETE", f"/purchases/{inv['id']}")
    full = world.api.get(f"/purchases/{inv['id']}")
    world.api.patch(f"/purchases/{inv['id']}", {
        "supplierId": s["id"], "warehouseId": world.main["id"],
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 6, "unitCost": 100}],
    })
    assert near(world.stock(p), 5)
    assert near(world.supplier_balance(s), 600 - 100)
    world.api.fails("PATCH", f"/purchases/{inv['id']}", {
        "supplierId": s["id"], "warehouseId": world.main["id"],
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 0.5, "unitCost": 100}],
    })


def test_cannot_delete_purchase_after_selling_it(world):
    p, s = world.product(), world.supplier()
    inv = world.buy(p, 2, 100, supplier=s)
    world.sell([(p, 2, 200)])
    world.api.fails("DELETE", f"/purchases/{inv['id']}")
