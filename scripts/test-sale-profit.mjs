/**
 * معاينة تكلفة البيع (FIFO) + ربح الفاتورة مع خردة مستلمة من العميل.
 * Usage: node scripts/test-sale-profit.mjs [baseUrl]
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

const login = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
token = login.accessToken || login.token;
const wh = (await api('/warehouses')).find((w) => w.code !== 'RETURNS');
const supplier = (await api('/suppliers'))[0];
const customer = (await api('/customers'))[0];
const product = await api('/products', { method: 'POST', body: JSON.stringify({ name: `بطارية ربح ${tag}`, unit: 'قطعة', salePrice: 1500 }) });

await api('/purchases', { method: 'POST', body: JSON.stringify({ supplierId: supplier.id, warehouseId: wh.id, confirm: true, lines: [{ productId: product.id, quantity: 1, unitCost: 1000 }] }) });
await new Promise((r) => setTimeout(r, 30));
await api('/purchases', { method: 'POST', body: JSON.stringify({ supplierId: supplier.id, warehouseId: wh.id, confirm: true, lines: [{ productId: product.id, quantity: 3, unitCost: 1100 }] }) });

console.log('1) معاينة: 2 بطاريات → 1 بـ1000 + 1 بـ1100');
const preview = await api(`/sales/fifo-preview?warehouseId=${wh.id}&lines=${product.id}:2`);
console.log('   ', preview[0].allocations.map((a) => `${a.quantity}@${a.unitCost} ${a.reference}`).join(' + '), 'unit', preview[0].unitCost);
assert(near(preview[0].unitCost, 1050) && near(preview[0].totalCost, 2100), 'preview cost wrong');

console.log('2) نفس الصنف في بندين: البند التاني يكمّل بعد الأول');
const preview2 = await api(`/sales/fifo-preview?warehouseId=${wh.id}&lines=${product.id}:1,${product.id}:1`);
assert(near(preview2[0].unitCost, 1000) && near(preview2[1].unitCost, 1100), 'multi-line preview wrong');

console.log('3) بيع بسعر 900 (أقل من التكلفة) + خردة 12 كجم × 25 = 300');
const before = (await api(`/customers/${customer.id}`)).balance;
const sale = await api('/sales', {
  method: 'POST',
  body: JSON.stringify({ customerId: customer.id, warehouseId: wh.id, confirm: true, hasScrap: true, scrapKg: 12, scrapPriceKg: 25, lines: [{ productId: product.id, quantity: 1, unitPrice: 900 }] }),
});
assert(near(sale.total, 900), `customer should owe 900 only, got ${sale.total}`);
const after = (await api(`/customers/${customer.id}`)).balance;
assert(near(after - before, 900), 'customer balance should grow by 900 (not including scrap)');
const full = await api(`/sales/${sale.id}`);
const cost = full.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
const profit = full.subtotal - full.discount + full.scrapAmount - cost;
console.log('   revenue', full.subtotal + full.scrapAmount, 'cost', cost, 'profit', profit);
assert(near(cost, 1000) && near(profit, 200), 'invoice profit should be 900 + 300 − 1000 = 200');

console.log('4) معاينة أثناء التعديل بتستبعد الفاتورة نفسها');
const editPreview = await api(`/sales/fifo-preview?warehouseId=${wh.id}&lines=${product.id}:1&excludeInvoiceId=${sale.id}`);
assert(near(editPreview[0].unitCost, 1000), 'edit preview should still see first batch');

console.log('5) تقرير الأرباح');
const rep = await api('/reports/profit');
console.log('   revenue', rep.revenue, 'cogs', rep.cogs, 'net', rep.netProfit);
console.log('\nALL OK');
