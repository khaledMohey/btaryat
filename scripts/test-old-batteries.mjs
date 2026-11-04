/**
 * البطاريات القديمة: استلام من البيع → فرز → مرتجع ضمان → بديل بتكلفة (خردة + استهلاك) → بيع → ربح.
 * Usage: node scripts/test-old-batteries.mjs [baseUrl]
 */
const BASE = (process.argv[2] || 'http://localhost:4555').replace(/\/$/, '');
const tag = `t${Date.now().toString(36)}`;
let token = '';
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${body?.message || text}`);
  return body;
}
const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body || {}) });
const balanceOf = async (id) => (await api(`/suppliers/${id}/statement`)).balance;

const login = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
token = login.accessToken || login.token;
const wh = (await api('/warehouses')).find((w) => w.code !== 'RETURNS');
const supplier = (await api('/suppliers'))[0];
const customer = (await api('/customers'))[0];
const td70 = await api('/products', { method: 'POST', body: JSON.stringify({ name: `td70 spot ${tag}`, unit: 'قطعة', salePrice: 2000 }) });
const used = await api('/products', { method: 'POST', body: JSON.stringify({ name: `td70 spot مستعمل ${tag}`, unit: 'قطعة', salePrice: 700 }) });
await api('/purchases', { method: 'POST', body: JSON.stringify({ supplierId: supplier.id, warehouseId: wh.id, confirm: true, lines: [{ productId: td70.id, quantity: 5, unitCost: 1600 }] }) });

console.log('1) بيع جديدة + الزبون سلّم 3 بطاريات خردة 36 كجم × 25 = 900');
const sale = await api('/sales', {
  method: 'POST',
  body: JSON.stringify({ customerId: customer.id, warehouseId: wh.id, confirm: true, hasScrap: true, scrapPieces: 3, scrapKg: 36, scrapPriceKg: 25, lines: [{ productId: td70.id, quantity: 1, unitPrice: 1500 }] }),
});
let pending = (await api('/returns/old-batteries?view=sort')).filter((b) => b.salesInvoice?.id === sale.id);
assert(pending.length === 3 && pending.every((b) => near(b.intakeValue, 300)), 'expected 3 old batteries at 300 each');

console.log('2) تعديل الفاتورة لـ 2 بطارية → واحدة تتشال');
const full = await api(`/sales/${sale.id}`);
await patch(`/sales/${sale.id}`, { customerId: customer.id, warehouseId: wh.id, hasScrap: true, scrapPieces: 2, scrapKg: 24, scrapPriceKg: 25, lines: [{ id: full.lines[0].id, productId: td70.id, quantity: 1, unitPrice: 1500 }] });
pending = (await api('/returns/old-batteries?view=sort')).filter((b) => b.salesInvoice?.id === sale.id);
assert(pending.length === 2 && pending.every((b) => near(b.intakeValue, 300)), 'expected 2 old batteries at 300');
const [a, b] = pending;

console.log('3) فرز: الأولى بايظة أقل من سنة → ضمان · التانية سليمة أكتر من سنة → مستعمل');
await patch(`/returns/old-batteries/${a.id}/sort`, { productId: td70.id, ageBand: 'UNDER_YEAR', condition: 'BAD', decision: 'WARRANTY' });
await patch(`/returns/old-batteries/${b.id}/sort`, { productId: td70.id, ageBand: 'OVER_YEAR', condition: 'GOOD', decision: 'USED', stockProductId: used.id, stockWarehouseId: wh.id });
const usedFifo = await api(`/stock/fifo?productId=${used.id}&warehouseId=${wh.id}`);
assert(near(usedFifo.remainingQty, 1) && near(usedFifo.layers[0].unitCost, 300), 'used battery should enter stock at 300');

console.log('4) ضمان زبون مستني (ملك زبون)');
const [wait] = await api('/returns/old-batteries', { method: 'POST', body: JSON.stringify({ kind: 'WARRANTY_WAIT', productId: td70.id, customerName: 'زبون ضمان', customerPhone: '0100', productionDate: new Date(Date.now() - 100 * 864e5).toISOString().slice(0, 10) }) });
assert(wait.ownership === 'CUSTOMER' && wait.ageBand === 'UNDER_YEAR' && wait.claimStatus === 'IN_SHOP', 'warranty wait wrong');

console.log('5) إرسال الاتنين للمورد');
await api('/returns/old-batteries/send', { method: 'POST', body: JSON.stringify({ ids: [a.id, wait.id], supplierId: supplier.id, receiverName: 'عبده كاوتشة' }) });
const sent = await api('/returns/old-batteries?view=warranty');
assert(sent.filter((x) => [a.id, wait.id].includes(x.id)).every((x) => x.claimStatus === 'SENT' && x.receiverName === 'عبده كاوتشة'), 'send failed');

console.log('6) وصل بديل المحل باستهلاك 400 على حساب المورد → تكلفة 700');
const bal0 = await balanceOf(supplier.id);
await patch(`/returns/old-batteries/${a.id}/receive`, { replacementProductId: td70.id, replacementWarehouseId: wh.id, consumptionFee: 400, feeSettlement: 'BALANCE' });
assert(near(await balanceOf(supplier.id), bal0 + 400), 'supplier balance should grow by fee');
const fifo = await api(`/stock/fifo?productId=${td70.id}&warehouseId=${wh.id}`);
const rpl = fifo.layers.find((l) => (l.reference || '').endsWith('-RPL'));
assert(rpl && near(rpl.unitCost, 700), `replacement layer should cost 700, got ${rpl?.unitCost}`);

console.log('7) بديل الزبون من غير استهلاك وتسليمه');
await patch(`/returns/old-batteries/${wait.id}/receive`, { replacementProductId: td70.id, consumptionFee: 0 });
await patch(`/returns/old-batteries/${wait.id}/deliver`);
const delivered = (await api('/returns/old-batteries?view=warranty')).find((x) => x.id === wait.id);
assert(delivered.claimStatus === 'DELIVERED', 'deliver failed');

console.log('8) بيع البديل (FIFO بيطلع الأقدم الأول — 1600 لحد ما يخلصوا)');
const s2 = await api('/sales', { method: 'POST', body: JSON.stringify({ customerId: customer.id, warehouseId: wh.id, confirm: true, lines: [{ productId: td70.id, quantity: 5, unitPrice: 1800 }] }) });
const f2 = await api(`/sales/${s2.id}/fifo`);
console.log('   ', f2.lines[0].allocations.map((x) => `${x.quantity}@${x.unitCost} ${x.reference}`).join(' + '));
assert(f2.lines[0].allocations.some((x) => (x.reference || '').endsWith('-RPL') && near(x.unitCost, 700)), 'replacement batch not used');

console.log('9) خردة: ارجع بطارية للفرز وخليها خردة وبيعها للتروسيكل');
await patch(`/returns/old-batteries/${b.id}/sort`, { decision: 'PENDING' });
const usedAfter = await api(`/stock/fifo?productId=${used.id}&warehouseId=${wh.id}`);
assert(near(usedAfter.remainingQty, 0), 'used stock should be removed after unsort');
await patch(`/returns/old-batteries/${b.id}/sort`, { condition: 'BAD', ageBand: 'OVER_YEAR', decision: 'SCRAP', weightKg: 12 });
const pile = await api('/scrap/pile');
assert(pile.some((x) => x.id === b.id), 'scrap pile missing battery');
const sc = await api('/scrap', { method: 'POST', body: JSON.stringify({ supplierId: supplier.id, withWater: false, grossKg: 12, priceKg: 30, settlement: 'BALANCE', oldBatteryIds: [b.id] }) });
assert(sc.oldBatteries.length === 1, 'scrap sale not linked');
const rep = await api('/reports/profit');
const scrapCost = rep.lines.find((l) => l.id === `scrapcost-${sc.id}`);
assert(scrapCost && near(scrapCost.amount, 300), 'scrap cost line missing in profit');

console.log('10) كشف المورد فيه الاستهلاك ومتوازن');
const st = await api(`/suppliers/${supplier.id}/statement`);
assert(st.statement.some((r) => r.kind === 'warranty' && near(r.debit, 400)), 'statement warranty fee row missing');
assert(near(st.statement[st.statement.length - 1].balance, st.balance), 'statement not balanced');

console.log('11) إلغاء استلام بديل اتباع لازم يترفض');
let blocked = false;
try { await patch(`/returns/old-batteries/${a.id}/undo-receive`); } catch { blocked = true; }
assert(blocked, 'undo receive should be blocked after replacement was sold');

console.log('\nALL OK');
