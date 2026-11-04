"""البطاريات القديمة: الفرز، مرتجع الضمان للمورد، البديل وتكلفته، وبيع الخردة بالتسويات التلاتة."""
from conftest import near


def old_from_sale(world, product, pieces=1, kg=12, price_kg=25):
    inv = world.sell([(product, 1, 1500)], hasScrap=True, scrapPieces=pieces, scrapKg=kg, scrapPriceKg=price_kg)
    rows = [b for b in world.api.get("/returns/old-batteries", view="sort") if (b.get("salesInvoice") or {}).get("id") == inv["id"]]
    assert len(rows) == pieces
    return rows


def sort(world, battery, **body):
    return world.api.patch(f"/returns/old-batteries/{battery['id']}/sort", body)


def test_sort_used_enters_stock_at_intake_value_and_unsort(world):
    p, used = world.product(), world.product("مستعمل", sale=700)
    world.buy(p, 2, 1600)
    [b] = old_from_sale(world, p)
    sort(world, b, condition="GOOD", ageBand="OVER_YEAR", decision="USED", stockProductId=used["id"], stockWarehouseId=world.main["id"])
    assert near(world.stock(used), 1)
    assert near(world.fifo(used)["layers"][0]["unitCost"], 300)
    inv = world.sell([(used, 1, 700)])
    assert near(world.sale(inv)["lines"][0]["unitCost"], 300)
    world.api.fails("PATCH", f"/returns/old-batteries/{b['id']}/sort", {"decision": "PENDING"})


def test_bulk_sort_groups_and_used_warehouse(world):
    p, used = world.product(), world.product("مستعمل", sale=700)
    world.buy(p, 1, 1000)
    batteries = old_from_sale(world, p, pieces=5, kg=60, price_kg=25)
    ids = [b["id"] for b in batteries]
    used_wh = world.api.get("/returns/old-batteries/config")["usedWarehouse"]
    assert used_wh["name"] == "مستعمل/سيرفس"

    r1 = world.api.post("/returns/old-batteries/sort-bulk", {"ids": ids[:2], "decision": "SCRAP", "condition": "BAD", "ageBand": "OVER_YEAR"})
    r2 = world.api.post("/returns/old-batteries/sort-bulk", {"ids": ids[2:4], "decision": "USED", "condition": "GOOD", "stockProductId": used["id"]})
    r3 = world.api.post("/returns/old-batteries/sort-bulk", {"ids": ids[4:], "decision": "WARRANTY", "ageBand": "UNDER_YEAR"})
    assert (r1["done"], r2["done"], r3["done"]) == (2, 2, 1) and not (r1["errors"] or r2["errors"] or r3["errors"])

    rows = {b["id"]: b for b in world.api.get("/returns/old-batteries")}
    assert [rows[i]["decision"] for i in ids] == ["SCRAP", "SCRAP", "USED", "USED", "WARRANTY"]
    assert all(rows[i]["stockWarehouse"]["id"] == used_wh["id"] for i in ids[2:4])
    assert all(rows[i]["ageBand"] == "OVER_YEAR" and rows[i]["condition"] == "BAD" for i in ids[:2])
    wh = {"id": used_wh["id"], "name": used_wh["name"]}
    assert near(world.stock(used, wh), 2)
    assert near(world.fifo(used, wh)["remainingValue"], 600)

    bad = world.api.post("/returns/old-batteries/sort-bulk", {"ids": ids[2:4], "decision": "USED"})
    assert bad["done"] == 0 and len(bad["errors"]) == 2

    service = world.api.post("/returns/old-batteries/sort-bulk", {"ids": ids[:1], "decision": "SERVICE", "stockProductId": used["id"]})
    assert service["done"] == 1
    assert world.api.get(f"/returns/old-batteries/{ids[0]}")["decision"] == "USED", "السيرفس والمستعمل مصير واحد"
    assert near(world.stock(used, wh), 3)
    world.api.patch(f"/returns/old-batteries/{ids[0]}/sort", {"decision": "SCRAP"})

    sold = world.sell([(used, 2, 700)], wh=wh)
    assert near(world.sale(sold)["lines"][0]["unitCost"], 300)


def test_warranty_shop_owned_replacement_cost(world):
    p, s = world.product(), world.supplier()
    world.buy(p, 2, 1600, supplier=s)
    [b] = old_from_sale(world, p)
    sort(world, b, productId=p["id"], condition="BAD", productionDate="2026-06-01", decision="WARRANTY")
    world.api.post("/returns/old-batteries/send", {"ids": [b["id"]], "supplierId": s["id"], "receiverName": "عبده كاوتشة"})
    bal0 = world.supplier_balance(s)
    world.api.patch(f"/returns/old-batteries/{b['id']}/receive", {
        "replacementProductId": p["id"], "replacementWarehouseId": world.main["id"], "consumptionFee": 400, "feeSettlement": "BALANCE",
    })
    assert near(world.supplier_balance(s) - bal0, 400)
    layer = next(l for l in world.fifo(p)["layers"] if (l["reference"] or "").endswith("-RPL"))
    assert near(layer["unitCost"], 700)
    world.api.patch(f"/returns/old-batteries/{b['id']}/undo-receive")
    assert near(world.supplier_balance(s), bal0)
    assert not any((l["reference"] or "").endswith("-RPL") for l in world.fifo(p)["layers"])


def test_warranty_fee_paid_cash(world):
    p, s = world.product(), world.supplier()
    world.buy(p, 1, 1600, supplier=s)
    [b] = old_from_sale(world, p)
    sort(world, b, condition="BAD", ageBand="UNDER_YEAR", decision="WARRANTY", supplierId=s["id"])
    world.api.post("/returns/old-batteries/send", {"ids": [b["id"]], "supplierId": s["id"]})
    cash0, bal0 = world.account(world.cash), world.supplier_balance(s)
    world.api.patch(f"/returns/old-batteries/{b['id']}/receive", {
        "replacementProductId": p["id"], "replacementWarehouseId": world.main["id"], "consumptionFee": 350, "feeSettlement": "CASH", "methodId": world.cash["id"],
    })
    assert near(cash0 - world.account(world.cash), 350)
    assert near(world.supplier_balance(s), bal0)


def test_customer_warranty_wait_flow(world):
    p, s = world.product(), world.supplier()
    [w] = world.api.post("/returns/old-batteries", {"kind": "WARRANTY_WAIT", "productId": p["id"], "customerName": "زبون ضمان", "customerPhone": "0100", "ageBand": "UNDER_YEAR"})
    assert w["ownership"] == "CUSTOMER" and w["claimStatus"] == "IN_SHOP"
    world.api.fails("PATCH", f"/returns/old-batteries/{w['id']}/sort", {"decision": "SCRAP"})
    world.api.post("/returns/old-batteries/send", {"ids": [w["id"]], "supplierId": s["id"]})
    world.api.patch(f"/returns/old-batteries/{w['id']}/receive", {"replacementProductId": p["id"], "consumptionFee": 0})
    assert near(world.stock(p), 0), "بديل الزبون مش بيدخل مخزون المحل"
    world.api.patch(f"/returns/old-batteries/{w['id']}/deliver")
    row = world.api.get(f"/returns/old-batteries/{w['id']}")
    assert row["claimStatus"] == "DELIVERED"


def test_supplier_rejects_warranty_to_scrap(world):
    p, s = world.product(), world.supplier()
    world.buy(p, 1, 1000)
    [b] = old_from_sale(world, p)
    sort(world, b, decision="WARRANTY")
    world.api.post("/returns/old-batteries/send", {"ids": [b["id"]], "supplierId": s["id"]})
    world.api.patch(f"/returns/old-batteries/{b['id']}/reject", {"toScrap": True})
    assert world.api.get(f"/returns/old-batteries/{b['id']}")["decision"] == "SCRAP"


def test_scrap_pile_sale_profit_and_settlements(world):
    p, trike = world.product(), world.supplier("تروسيكل")
    world.buy(p, 1, 1000)
    batteries = old_from_sale(world, p, pieces=2, kg=24, price_kg=25)
    for b in batteries:
        sort(world, b, condition="BAD", ageBand="OVER_YEAR", decision="SCRAP", weightKg=12)

    bal0 = world.supplier_balance(trike)
    profit0 = world.profit()
    sale = world.api.post("/scrap", {"supplierId": trike["id"], "withWater": True, "grossKg": 24, "priceKg": 30, "settlement": "BALANCE", "oldBatteryIds": [b["id"] for b in batteries]})
    assert near(sale["netKg"], 20.4) and near(sale["amount"], 612)
    assert near(world.supplier_balance(trike), bal0 - 612)
    profit1 = world.profit()
    assert near(profit1["revenue"] - profit0["revenue"], 612)
    assert near(profit1["cogs"] - profit0["cogs"], 600), "تكلفة الخردة = اللي اتحسب للزبون"
    world.api.fails("PATCH", f"/returns/old-batteries/{batteries[0]['id']}/sort", {"decision": "PENDING"})

    world.api.delete(f"/scrap/{sale['id']}")
    assert near(world.supplier_balance(trike), bal0)
    assert all(b["scrapSaleId"] is None for b in world.api.get("/scrap/pile") if b["id"] in {x["id"] for x in batteries})


def test_scrap_sale_cash_and_invoice_settlements(world):
    p, s = world.product(), world.supplier()
    cash0 = world.account(world.cash)
    cash_sale = world.api.post("/scrap", {"supplierId": s["id"], "grossKg": 10, "priceKg": 30, "settlement": "CASH", "methodId": world.cash["id"]})
    assert near(world.account(world.cash) - cash0, 300)
    inv = world.buy(p, 10, 100, supplier=s)
    bal0 = world.supplier_balance(s)
    world.api.post("/scrap", {"supplierId": s["id"], "withWater": True, "grossKg": 20, "priceKg": 25, "settlement": "INVOICE", "purchaseInvoiceId": inv["id"]})
    assert near(world.api.get(f"/purchases/{inv['id']}")["total"], 1000 - 425)
    assert near(world.supplier_balance(s), bal0 - 425)
    world.api.delete(f"/scrap/{cash_sale['id']}")
    assert near(world.account(world.cash), cash0)


def test_scrap_inside_purchase_invoice(world):
    p, s = world.product(), world.supplier()
    inv = world.buy(p, 30, 100, supplier=s, scrap={"withWater": True, "grossKg": 100, "priceKg": 20})
    assert near(inv["total"], 3000 - 1700)
    assert near(world.supplier_balance(s), 1300)
    full = world.api.get(f"/purchases/{inv['id']}")
    world.api.patch(f"/purchases/{inv['id']}", {
        "supplierId": s["id"], "warehouseId": world.main["id"], "scrap": None,
        "lines": [{"id": full["lines"][0]["id"], "productId": p["id"], "quantity": 30, "unitCost": 100}],
    })
    assert near(world.supplier_balance(s), 3000)
    world.api.fails("POST", "/purchases", {"supplierId": s["id"], "warehouseId": world.main["id"], "confirm": True, "scrap": {"grossKg": 1000, "priceKg": 20}, "lines": [{"productId": p["id"], "quantity": 1, "unitCost": 100}]})
