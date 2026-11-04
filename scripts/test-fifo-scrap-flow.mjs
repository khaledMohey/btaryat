/**
 * FIFO + بيع الخردة — اختبار من أول لآخر على API شغال.
 * Usage: node scripts/test-fifo-scrap-flow.mjs [baseUrl]
 */
const BASE = (process.argv[2] || 'http://localhost:4555').replace(/\/$/, '');
const USER = process.env.TEST_USER || 'admin';
const PASS = process.env.TEST_PASS || 'admin123';
const tag = `t${Date.now().toString(36)}`;
let token = '';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body?.message || text || res.statusText;
    throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${Array.isArray(msg) ? msg.join(', ') : msg}`);
  }
  return body;
}

async function supplierBalance(id) {
  const st = await api(`/suppliers/${id}/statement`);
  return st.balance;
}

async function main() {
  console.log(`Testing against ${BASE}`);
  const login = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: USER, password: PASS }) });
  token = login.accessToken || login.token;

  const whA = (await api('/warehouses')).find((w) => w.code !== 'RETURNS');
  const whB = await api('/warehouses', { method: 'POST', body: JSON.stringify({ code: `B${tag}`, name: `مخزن ب ${tag}` }) });
  const supplier = (await api('/suppliers'))[0];
  const customer = (await api('/customers'))[0];
  const product = await api('/products', { method: 'POST', body: JSON.stringify({ name: `بطارية FIFO ${tag}`, unit: 'قطعة', costPrice: 0, salePrice: 200 }) });
  assert(whA && supplier && customer && product?.id, 'setup failed');

  console.log('1) شراء 10 بـ 100 ثم 5 بـ 120');
  const p1 = await api('/purchases', { method: 'POST', body: JSON.stringify({ supplierId: supplier.id, warehouseId: whA.id, confirm: true, lines: [{ productId: product.id, quantity: 10, unitCost: 100 }] }) });
  await new Promise((r) => setTimeout(r, 30));
  const p2 = await api('/purchases', { method: 'POST', body: JSON.stringify({ supplierId: supplier.id, warehouseId: whA.id, confirm: true, lines: [{ productId: product.id, quantity: 5, unitCost: 120 }] }) });

  console.log('2) بيع 12 → 10 من الدفعة الأولى + 2 من التانية');
  const s1 = await api('/sales', { method: 'POST', body: JSON.stringify({ customerId: customer.id, warehouseId: whA.id, confirm: true, lines: [{ productId: product.id, quantity: 12, unitPrice: 200 }] }) });
  const f1 = await api(`/sales/${s1.id}/fifo`);
  const line = f1.lines[0];
  console.log('   ', line.allocations.map((a) => `${a.quantity}@${a.unitCost} ${a.reference}`).join(' + '), '→ cost', line.unitCost);
  assert(line.allocations.length === 2, 'expected 2 batches');
  assert(line.allocations[0].reference === p1.number && near(line.allocations[0].quantity, 10), 'first batch wrong');
  assert(line.allocations[1].reference === p2.number && near(line.allocations[1].quantity, 2), 'second batch wrong');
  assert(near(line.unitCost, (1000 + 240) / 12, 0.001), 'FIFO unit cost wrong');
  const saved = await api(`/sales/${s1.id}`);
  assert(near(saved.lines[0].unitCost, (1000 + 240) / 12, 0.001), 'sales line unitCost not recosted');

  console.log('3) تحويل 2 لمخزن ب وبيع 1 منه بتكلفة الدفعة التانية');
  await api('/stock/transfers', { method: 'POST', body: JSON.stringify({ fromWarehouseId: whA.id, toWarehouseId: whB.id, lines: [{ productId: product.id, quantity: 2 }] }) });
  const s2 = await api('/sales', { method: 'POST', body: JSON.stringify({ customerId: customer.id, warehouseId: whB.id, confirm: true, lines: [{ productId: product.id, quantity: 1, unitPrice: 200 }] }) });
  const f2 = await api(`/sales/${s2.id}/fifo`);
  assert(near(f2.lines[0].unitCost, 120), `transfer sale cost expected 120 got ${f2.lines[0].unitCost}`);
  assert(f2.lines[0].allocations[0].reference === p2.number, 'transfer layer should keep purchase ref');

  console.log('4) دفعات المخزن أ');
  const batches = await api(`/stock/fifo?productId=${product.id}&warehouseId=${whA.id}`);
  for (const l of batches.layers) console.log(`    ${l.reference} دخل ${l.quantity} @${l.unitCost} اتسحب ${l.used} فاضل ${l.remaining}`, l.consumed.map((c) => `${c.type}:${c.reference}×${c.quantity}`).join(', '));
  assert(near(batches.remainingQty, 1) && near(batches.remainingValue, 120), 'warehouse A should have 1 @120 left');

  console.log('5) تعديل سعر الدفعة الأولى 100 → 90 → تكلفة البيع تتعدل');
  const p1full = await api(`/purchases/${p1.id}`);
  await api(`/purchases/${p1.id}`, { method: 'PATCH', body: JSON.stringify({ supplierId: supplier.id, warehouseId: whA.id, lines: [{ id: p1full.lines[0].id, productId: product.id, quantity: 10, unitCost: 90 }] }) });
  const f1b = await api(`/sales/${s1.id}/fifo`);
  assert(near(f1b.lines[0].unitCost, (900 + 240) / 12, 0.001), `recost after purchase edit wrong: ${f1b.lines[0].unitCost}`);

  console.log('6) خردة جوه فاتورة شراء: 100 كجم بمياه × 20 → 85 كجم = 1700');
  const balBefore = await supplierBalance(supplier.id);
  const p3 = await api('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplierId: supplier.id, warehouseId: whA.id, confirm: true,
      scrap: { withWater: true, grossKg: 100, priceKg: 20 },
      lines: [{ productId: product.id, quantity: 30, unitCost: 100 }],
    }),
  });
  assert(near(p3.total, 3000 - 1700), `invoice total should be 1300 got ${p3.total}`);
  const p3full = await api(`/purchases/${p3.id}`);
  assert(p3full.scrapSale && near(p3full.scrapSale.netKg, 85) && near(p3full.scrapSale.amount, 1700), 'embedded scrap sale wrong');
  assert(near(await supplierBalance(supplier.id), balBefore + 1300), 'supplier balance after purchase with scrap wrong');

  console.log('7) خردة منفصلة — خصم من الحساب: 50 كجم بدون مياه × 18 = 900');
  const bal2 = await supplierBalance(supplier.id);
  const sc1 = await api('/scrap', { method: 'POST', body: JSON.stringify({ supplierId: supplier.id, withWater: false, grossKg: 50, priceKg: 18, settlement: 'BALANCE' }) });
  assert(near(sc1.amount, 900) && near(sc1.netKg, 50), 'scrap BALANCE amount wrong');
  assert(near(await supplierBalance(supplier.id), bal2 - 900), 'BALANCE settlement should reduce supplier balance');

  console.log('8) خردة منفصلة — خصم من فاتورة شراء مفتوحة');
  const p4 = await api('/purchases', { method: 'POST', body: JSON.stringify({ supplierId: supplier.id, warehouseId: whA.id, confirm: true, lines: [{ productId: product.id, quantity: 10, unitCost: 100 }] }) });
  const open = await api(`/scrap/open-invoices?supplierId=${supplier.id}`);
  assert(open.some((i) => i.id === p4.id), 'open invoice missing');
  const bal3 = await supplierBalance(supplier.id);
  const sc2 = await api('/scrap', { method: 'POST', body: JSON.stringify({ supplierId: supplier.id, withWater: true, grossKg: 20, priceKg: 25, settlement: 'INVOICE', purchaseInvoiceId: p4.id }) });
  assert(near(sc2.amount, 17 * 25), 'INVOICE scrap amount wrong');
  const p4after = await api(`/purchases/${p4.id}`);
  assert(near(p4after.total, 1000 - 425) && near(p4after.scrapAmount, 425), 'invoice not reduced by scrap');
  assert(near(await supplierBalance(supplier.id), bal3 - 425), 'INVOICE settlement should reduce supplier balance');

  console.log('9) خردة منفصلة — استلام فلوس');
  const methods = await api('/cash/methods');
  const cash = methods.find((m) => m.kind === 'IMMEDIATE');
  assert(cash, 'no immediate pay method');
  const accountsBefore = await api('/cash/accounts');
  const bal4 = await supplierBalance(supplier.id);
  const sc3 = await api('/scrap', { method: 'POST', body: JSON.stringify({ supplierId: supplier.id, withWater: false, grossKg: 10, priceKg: 30, settlement: 'CASH', methodId: cash.id }) });
  const accountsAfter = await api('/cash/accounts');
  const acc = accountsAfter.find((a) => a.id === sc3.cashAccount?.id);
  const accBefore = accountsBefore.find((a) => a.id === sc3.cashAccount?.id);
  assert(acc && accBefore && near(acc.balance - accBefore.balance, 300), 'cash account should increase by 300');
  assert(near(await supplierBalance(supplier.id), bal4), 'CASH settlement should not change supplier balance');

  console.log('10) تعديل وحذف الخردة يعكس الأثر');
  await api(`/scrap/${sc2.id}`, { method: 'DELETE' });
  const p4back = await api(`/purchases/${p4.id}`);
  assert(near(p4back.total, 1000) && near(p4back.scrapAmount, 0), 'invoice not restored after scrap delete');
  await api(`/scrap/${sc1.id}`, { method: 'PATCH', body: JSON.stringify({ supplierId: supplier.id, withWater: true, grossKg: 50, priceKg: 18, settlement: 'BALANCE' }) });
  const sc1b = await api(`/scrap/${sc1.id}`);
  assert(near(sc1b.amount, 42.5 * 18), 'scrap edit amount wrong');

  console.log('11) كشف حساب المورد متوازن');
  const st = await api(`/suppliers/${supplier.id}/statement`);
  const scrapRows = st.statement.filter((r) => r.kind === 'scrap');
  assert(scrapRows.length >= 3, 'statement scrap rows missing');
  const last = st.statement[st.statement.length - 1];
  assert(near(last.balance, st.balance), 'statement running balance != supplier balance');

  console.log('12) تعديل الفاتورة اللي فيها خردة وشيل الخردة');
  await api(`/purchases/${p3.id}`, { method: 'PATCH', body: JSON.stringify({ supplierId: supplier.id, warehouseId: whA.id, scrap: null, lines: [{ id: p3full.lines[0].id, productId: product.id, quantity: 30, unitCost: 100 }] }) });
  const p3b = await api(`/purchases/${p3.id}`);
  assert(near(p3b.total, 3000) && !p3b.scrapSale, 'removing scrap from invoice failed');

  console.log('\nALL OK');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
