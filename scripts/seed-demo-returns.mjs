/**
 * داتا تجريبية للمرتجعات (كل الأسماء فيها "تجريبي") — من غير ما تلمس الخزنة (كله آجل).
 * Usage: node scripts/seed-demo-returns.mjs [baseUrl]
 */
const BASE = (process.argv[2] || 'https://btarya.vercel.app').replace(/\/$/, '') + '/api';
let token = '';
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${body?.message || text}`);
  return body;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });

const login = await post('/auth/login', { username: process.env.E2E_USER || 'admin', password: process.env.E2E_PASS || 'admin123' });
token = login.accessToken || login.token;

const warehouses = await api('/warehouses');
const main = warehouses.find((w) => !['RETURNS', 'USED'].includes(w.code));
const returnsWh = warehouses.find((w) => w.code === 'RETURNS');
const usedWh = (await api('/returns/old-batteries/config')).usedWarehouse;

async function supplierNamed(code, name) {
  const all = await api('/suppliers');
  return all.find((s) => s.code === code) || post('/suppliers', { code, name });
}
async function productNamed(name, salePrice) {
  const all = await api('/products');
  return all.find((p) => p.name === name) || post('/products', { name, unit: 'قطعة', salePrice });
}

const supplier = await supplierNamed('DEMO-SUP', 'مورد تجريبي — محروس');
const trike = await supplierNamed('DEMO-TRK', 'تروسيكل خردة تجريبي');
const customer = await post('/customers/by-name', { name: 'زبون تجريبي' });
const td70 = await productNamed('TD70 SPOT تجريبي', 2200);
const ns40 = await productNamed('NS40 CALSIUM تجريبي', 1500);
const din74 = await productNamed('DIN74 VOLTIGO تجريبي', 3000);
const used = await productNamed('TD70 SPOT مستعمل تجريبي', 900);
console.log('warehouses:', main.name, '·', returnsWh.name, '·', usedWh.name);

console.log('1) فاتورة شراء آجل من المورد التجريبي');
const purchase = await post('/purchases', {
  supplierId: supplier.id, warehouseId: main.id, confirm: true, notes: 'داتا تجريبية',
  lines: [
    { productId: td70.id, quantity: 10, unitCost: 1600 },
    { productId: ns40.id, quantity: 10, unitCost: 1100 },
    { productId: din74.id, quantity: 6, unitCost: 2400 },
  ],
});
console.log('   ', purchase.number);

console.log('2) مرتجعات بيع → مخزن المرتجعات');
for (const [p, qty, name] of [[td70, 3, 'زبون تجريبي ١'], [ns40, 2, 'زبون تجريبي ٢'], [din74, 1, 'زبون تجريبي ٣']]) {
  const r = await post('/returns/sales', { customerName: name, productId: p.id, scrapPieces: qty, notes: 'داتا تجريبية' });
  console.log('   ', r.number, p.name, '×', qty);
}

console.log('3) بيع بخردة من الزبون (٤ بطاريات قديمة مستنية الفرز)');
const scrapSale = await post('/sales', {
  customerId: customer.id, warehouseId: main.id, confirm: true, notes: 'داتا تجريبية',
  hasScrap: true, scrapKind: 'SCRAP', scrapPieces: 4, scrapKg: 48, scrapPriceKg: 25,
  lines: [{ productId: td70.id, quantity: 2, unitPrice: 2000 }],
});
console.log('   ', scrapSale.number);

console.log('4) زبون ضمان دفع فرق وخد جديدة');
const swap = await post('/sales', {
  customerId: customer.id, warehouseId: main.id, confirm: true, notes: 'داتا تجريبية',
  hasScrap: true, scrapKind: 'WARRANTY_SWAP', scrapPieces: 1,
  lines: [{ productId: ns40.id, quantity: 1, unitPrice: 800 }],
});
console.log('   ', swap.number);

console.log('5) فرز جزء من البطاريات عشان يبقى فيه كل الحالات');
const pending = (await api('/returns/old-batteries?view=sort')).filter((b) => [scrapSale.id, swap.id].includes(b.salesInvoice?.id));
const fromScrap = pending.filter((b) => b.salesInvoice?.id === scrapSale.id);
const fromSwap = pending.filter((b) => b.salesInvoice?.id === swap.id);
// واحدة خردة، واحدة مستعمل، واحدة ضمان للمورد (مبعوتة)، والباقي مستني الفرز
await patch(`/returns/old-batteries/${fromScrap[0].id}/sort`, { productId: td70.id, condition: 'BAD', ageBand: 'OVER_YEAR', decision: 'SCRAP', weightKg: 12 });
await patch(`/returns/old-batteries/${fromScrap[1].id}/sort`, { productId: td70.id, condition: 'GOOD', ageBand: 'OVER_YEAR', decision: 'USED', stockProductId: used.id, stockWarehouseId: usedWh.id });
await patch(`/returns/old-batteries/${fromSwap[0].id}/sort`, { productId: ns40.id, condition: 'BAD', ageBand: 'UNDER_YEAR', decision: 'WARRANTY', supplierId: supplier.id });
await post('/returns/old-batteries/send', { ids: [fromSwap[0].id], supplierId: supplier.id, receiverName: 'عبده كاوتشة (تجريبي)' });
console.log('    مستني الفرز:', fromScrap.length - 2, '· خردة: 1 · مستعمل/سيرفس: 1 · ضمان عند المورد: 1');

console.log('6) ضمان زبون مستني البديل');
const [w1] = await post('/returns/old-batteries', { kind: 'WARRANTY_WAIT', productId: din74.id, customerName: 'زبون ضمان تجريبي', customerPhone: '01000000001', ageBand: 'UNDER_YEAR', notes: 'داتا تجريبية' });
const [w2] = await post('/returns/old-batteries', { kind: 'WARRANTY_WAIT', productId: td70.id, customerName: 'زبون ضمان تجريبي ٢', customerPhone: '01000000002', productionDate: '2026-04-15', notes: 'داتا تجريبية' });
await post('/returns/old-batteries/send', { ids: [w2.id], supplierId: supplier.id, receiverName: 'ممدوح (تجريبي)' });
console.log('    في المحل:', w1.number, '· عند المورد:', w2.number);

const stock = await api(`/stock/balances?warehouseId=${returnsWh.id}`);
console.log('\nمخزن المرتجعات دلوقتي:');
for (const r of stock.filter((s) => [td70.id, ns40.id, din74.id].includes(s.productId))) console.log('   ', r.product.name, '×', r.quantity);
console.log('\nالمورد التجريبي:', supplier.name, '· التروسيكل:', trike.name);
console.log('تم ✔');
