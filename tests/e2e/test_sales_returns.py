"""مرتجع البيع بكل الطرق: صنف لمخزن المرتجعات، خردة، استهلاك فلوس، استبدال، تعديل، حذف."""
from conftest import near


def sr(world, **body):
    return world.api.post("/returns/sales", body)


def test_product_return_goes_to_returns_warehouse(world):
    p = world.product(cost=500)
    r0 = world.stock(p, world.returns_wh)
    ret = sr(world, customerName="زبون مرتجع", productId=p["id"])
    assert ret["warehouseId"] == world.returns_wh["id"]
    assert near(world.stock(p, world.returns_wh) - r0, 1)
    fifo = world.fifo(p, world.returns_wh)
    assert near(fifo["remainingQty"], 1) and near(fifo["layers"][-1]["unitCost"], 500)


def test_return_pieces_count_as_quantity(world):
    p = world.product(cost=300)
    sr(world, productId=p["id"], scrapPieces=3)
    assert near(world.stock(p, world.returns_wh), 3)


def test_scrap_only_return_no_stock(world):
    ret = sr(world, customerName="خردة بس", scrapKg=14)
    assert ret["lines"] == [] or ret["lines"] is None or len(ret["lines"]) == 0


def test_return_with_consumption_money_hits_cash_and_profit(world):
    p = world.product(cost=200)
    cash0 = world.account(world.cash)
    profit0 = world.profit()
    ret = sr(world, productId=p["id"], consumptionAmount=150, cashAccountId=world.cash["cashAccountId"])
    assert near(world.account(world.cash) - cash0, 150)
    assert near(ret["consumptionAmount"], 150)
    assert near(world.profit()["revenue"] - profit0["revenue"], 150)


def test_return_with_replacement_takes_from_warehouse(world):
    old = world.product(cost=100)
    new = world.product()
    world.buy(new, 3, 900)
    ret = sr(world, productId=old["id"], giveReplacement=True, replacementProductId=new["id"], replacementWarehouseId=world.main["id"], replacementQty=1)
    assert near(world.stock(new), 2)
    assert near(world.stock(old, world.returns_wh), 1)
    assert ret["giveReplacement"] is True


def test_return_validation(world):
    p = world.product()
    world.api.fails("POST", "/returns/sales", {"customerName": "x"})
    world.api.fails("POST", "/returns/sales", {"productId": p["id"], "consumptionAmount": 50})
    world.api.fails("POST", "/returns/sales", {"productId": p["id"], "giveReplacement": True, "replacementProductId": p["id"], "replacementWarehouseId": world.main["id"], "replacementQty": 5})
    world.api.fails("POST", "/returns/sales", {"productId": p["id"], "giveReplacement": True})


def test_update_sales_return_reverses_old_effects(world):
    a, b = world.product(cost=100), world.product(cost=100)
    new = world.product()
    world.buy(new, 3, 900)
    cash0 = world.account(world.cash)
    ret = sr(world, productId=a["id"], consumptionAmount=100, cashAccountId=world.cash["cashAccountId"],
             giveReplacement=True, replacementProductId=new["id"], replacementWarehouseId=world.main["id"], replacementQty=1)
    world.api.patch(f"/returns/sales/{ret['id']}", {"productId": b["id"], "consumptionAmount": 40, "cashAccountId": world.cash["cashAccountId"]})
    assert near(world.stock(a, world.returns_wh), 0)
    assert near(world.stock(b, world.returns_wh), 1)
    assert near(world.stock(new), 3), "الاستبدال اتلغى يرجع للمخزن"
    assert near(world.account(world.cash) - cash0, 40)


def test_delete_sales_return_reverses_everything(world):
    p = world.product(cost=100)
    new = world.product()
    world.buy(new, 2, 900)
    cash0 = world.account(world.cash)
    ret = sr(world, productId=p["id"], consumptionAmount=70, cashAccountId=world.cash["cashAccountId"],
             giveReplacement=True, replacementProductId=new["id"], replacementWarehouseId=world.main["id"], replacementQty=1)
    world.api.delete(f"/returns/sales/{ret['id']}")
    assert near(world.stock(p, world.returns_wh), 0)
    assert near(world.stock(new), 2)
    assert near(world.account(world.cash), cash0)


def test_cannot_delete_return_after_selling_it(world):
    p = world.product(cost=100)
    ret = sr(world, productId=p["id"])
    world.sell([(p, 1, 300)], wh=world.returns_wh)
    world.api.fails("DELETE", f"/returns/sales/{ret['id']}")
    assert near(world.stock(p, world.returns_wh), 0)


def test_sell_from_returns_warehouse_uses_return_cost(world):
    p = world.product(cost=450)
    sr(world, productId=p["id"])
    inv = world.sell([(p, 1, 700)], wh=world.returns_wh)
    assert near(world.sale(inv)["lines"][0]["unitCost"], 450)


def test_returns_report(world):
    before = world.api.get("/reports/returns")
    p = world.product(cost=100)
    sr(world, productId=p["id"], consumptionAmount=55, cashAccountId=world.cash["cashAccountId"])
    after = world.api.get("/reports/returns")
    assert after["salesCount"] == before["salesCount"] + 1
    assert near(after["salesTotal"] - before["salesTotal"], 55)
