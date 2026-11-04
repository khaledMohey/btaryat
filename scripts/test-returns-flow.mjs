/**
 * End-to-end returns math test against a live API.
 * Usage: node scripts/test-returns-flow.mjs [baseUrl]
 * Default: https://btarya.vercel.app
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envLocal = join(root, '.env.local');
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const BASE = (process.argv[2] || 'https://btarya.vercel.app').replace(/\/$/, '');
const USER = process.env.TEST_USER || 'admin';
const PASS = process.env.TEST_PASS || 'admin123';

let token = '';
const tag = `t${Date.now().toString(36)}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body?.message || body?.error || text || res.statusText;
    throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${Array.isArray(msg) ? msg.join(', ') : msg}`);
  }
  return body;
}

function stockOf(balances, warehouseId, productId) {
  const row = balances.find((b) => b.warehouseId === warehouseId && b.productId === productId);
  return row?.quantity || 0;
}

async function main() {
  console.log(`Testing against ${BASE}`);
  const login = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  token = login.accessToken || login.token;
  assert(token, 'no token');

  const warehousesAll = await api('/warehouses?includeSystem=1');
  const warehousesOps = await api('/warehouses');
  const returnsWh = warehousesAll.find((w) => w.code === 'RETURNS');
  assert(returnsWh, 'RETURNS warehouse missing');
  assert(!warehousesOps.some((w) => w.code === 'RETURNS'), 'RETURNS must be hidden from operational warehouse list');
  const mainWh = warehousesOps.find((w) => w.isActive !== false) || warehousesOps[0];
  assert(mainWh, 'no operational warehouse');

  const suppliers = await api('/suppliers');
  const customers = await api('/customers');
  const products = await api('/products');
  assert(suppliers.length && customers.length && products.length, 'need supplier/customer/product');

  const supplier = suppliers[0];
  const customer = customers[0];
  const product = products[0];
  const unitCost = 100;
  const unitPrice = 150;
  const buyQty = 10;
  const sellQty = 4;
  const salesReturnQty = 2;
  const purchaseReturnQty = 2;
  const restockQty = 2;

  const beforeBalances = await api(`/stock/balances?warehouseId=`);
  // some APIs need no filter — try valuation items
  let getBal;
  try {
    const val = await api('/stock/valuation');
    getBal = (whId, pid) => {
      const row = (val.items || []).find((i) => i.warehouseId === whId && (i.productId === pid || i.id?.includes?.(pid)));
      // valuation shape: { warehouseId, productId, quantity } or nested
      if (row) return row.quantity || 0;
      const alt = (val.items || []).find((i) => i.warehouse?.id === whId && i.product?.id === pid);
      return alt?.quantity || 0;
    };
    // normalize: map items
    const map = new Map();
    for (const i of val.items || []) {
      const wh = i.warehouseId || i.warehouse?.id;
      const pid = i.productId || i.product?.id;
      if (wh && pid) map.set(`${wh}:${pid}`, i.quantity || 0);
    }
    getBal = (whId, pid) => map.get(`${whId}:${pid}`) || 0;
  } catch {
    getBal = () => 0;
  }

  const mainBefore = getBal(mainWh.id, product.id);
  const returnsBefore = getBal(returnsWh.id, product.id);
  const supplierBefore = (await api(`/suppliers`)).find((s) => s.id === supplier.id)?.balance ?? supplier.balance ?? 0;

  console.log('1) Purchase confirmed', { buyQty, warehouse: mainWh.name });
  const purchase = await api('/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplierId: supplier.id,
      warehouseId: mainWh.id,
      confirm: true,
      notes: `test-returns ${tag}`,
      lines: [{ productId: product.id, quantity: buyQty, unitCost }],
    }),
  });
  assert(purchase?.id, 'purchase failed');

  console.log('2) Sale confirmed', { sellQty });
  const sale = await api('/sales', {
    method: 'POST',
    body: JSON.stringify({
      customerId: customer.id,
      warehouseId: mainWh.id,
      confirm: true,
      notes: `test-returns ${tag}`,
      lines: [{ productId: product.id, quantity: sellQty, unitPrice }],
    }),
  });
  assert(sale?.id, 'sale failed');

  // Refresh valuation
  const val2 = await api('/stock/valuation?includeSystem=1').catch(() => api('/stock/valuation'));
  const map2 = new Map();
  for (const i of val2.items || []) {
    const wh = i.warehouseId || i.warehouse?.id;
    const pid = i.productId || i.product?.id;
    if (wh && pid) map2.set(`${wh}:${pid}`, i.quantity || 0);
  }
  const bal = (wh, pid) => map2.get(`${wh}:${pid}`) || 0;

  // Also try stock balances endpoint if valuation excludes RETURNS
  async function refreshMap() {
    const val = await api('/stock/valuation');
    map2.clear();
    for (const i of val.items || []) {
      const wh = i.warehouseId || i.warehouse?.id;
      const pid = i.productId || i.product?.id;
      if (wh && pid) map2.set(`${wh}:${pid}`, i.quantity || 0);
    }
    // pull RETURNS specifically via movements or balances
    try {
      const mov = await api(`/stock/movements?warehouseId=${returnsWh.id}&page=1&pageSize=5`);
      void mov;
    } catch { /* ignore */ }
  }

  await refreshMap();
  const mainAfterBuySell = bal(mainWh.id, product.id);
  assert(
    Math.abs(mainAfterBuySell - (mainBefore + buyQty - sellQty)) < 0.001,
    `main stock after buy/sell expected ${mainBefore + buyQty - sellQty} got ${mainAfterBuySell}`,
  );

  console.log('3) Sales return into RETURNS', { salesReturnQty });
  const sr = await api('/returns/sales', {
    method: 'POST',
    body: JSON.stringify({
      customerName: `اختبار ${tag}`,
      productId: product.id,
      scrapPieces: salesReturnQty,
      notes: `test-returns ${tag}`,
    }),
  });
  assert(sr?.warehouse?.code === 'RETURNS' || sr?.warehouse?.name?.includes('مرتجع'), `sales return warehouse wrong: ${JSON.stringify(sr?.warehouse)}`);

  const productsBeforePr = await api(`/returns/purchases/products/${supplier.id}`);
  const row = productsBeforePr.products.find((p) => p.productId === product.id);
  assert(row, 'product should appear in supplier returnable list after sales return');
  console.log('   purchase products row', {
    purchasedQty: row.purchasedQty,
    returnedQty: row.returnedQty,
    purchaseRemaining: row.purchaseRemaining,
    returnsStock: row.returnsStock,
    remainingQty: row.remainingQty,
  });
  assert(row.returnsStock >= salesReturnQty, `returnsStock expected >= ${salesReturnQty}, got ${row.returnsStock}`);
  assert(row.remainingQty === Math.min(row.purchaseRemaining, row.returnsStock), 'remainingQty must be min(purchaseRemaining, returnsStock)');
  assert(row.remainingQty >= purchaseReturnQty, `not enough remaining for purchase return (${row.remainingQty})`);

  // Ensure RETURNS not in ops list still
  const ops2 = await api('/warehouses');
  assert(!ops2.some((w) => w.code === 'RETURNS'), 'RETURNS leaked into ops list');

  console.log('4) Purchase return from RETURNS', { purchaseReturnQty });
  const supplierMid = (await api('/suppliers')).find((s) => s.id === supplier.id);
  const pr = await api('/returns/purchases', {
    method: 'POST',
    body: JSON.stringify({
      supplierId: supplier.id,
      notes: `test-returns ${tag}`,
      lines: [{ productId: product.id, quantity: purchaseReturnQty, unitCost: row.unitCost || unitCost }],
    }),
  });
  assert(pr?.id, 'purchase return failed');
  assert(pr.warehouse?.code === 'RETURNS' || pr.warehouseId === returnsWh.id, 'purchase return must use RETURNS warehouse');

  const supplierAfterPr = (await api('/suppliers')).find((s) => s.id === supplier.id);
  const expectedSupplierDelta = purchaseReturnQty * (row.unitCost || unitCost);
  assert(
    Math.abs((supplierAfterPr.balance ?? 0) - ((supplierMid.balance ?? 0) - expectedSupplierDelta)) < 0.05,
    `supplier balance after PR: before=${supplierMid.balance} after=${supplierAfterPr.balance} expected delta -${expectedSupplierDelta}`,
  );

  const productsAfterPr = await api(`/returns/purchases/products/${supplier.id}`);
  const row2 = productsAfterPr.products.find((p) => p.productId === product.id);
  if (row2) {
    assert(row2.returnedQty >= row.returnedQty + purchaseReturnQty, 'returnedQty should increase');
    assert(row2.returnsStock <= row.returnsStock - purchaseReturnQty + 0.001, 'returnsStock should decrease');
  }

  console.log('5) Restock into main warehouse', { restockQty, warehouse: mainWh.name });
  const mainBeforeRestockVal = await api('/stock/valuation');
  const mainMap = new Map();
  for (const i of mainBeforeRestockVal.items || []) {
    const wh = i.warehouseId || i.warehouse?.id;
    const pid = i.productId || i.product?.id;
    if (wh && pid) mainMap.set(`${wh}:${pid}`, i.quantity || 0);
  }
  const mainBeforeRestock = mainMap.get(`${mainWh.id}:${product.id}`) || 0;

  await api(`/returns/purchases/${pr.id}/restock`, {
    method: 'POST',
    body: JSON.stringify({
      warehouseId: mainWh.id,
      lines: [{ productId: product.id, quantity: restockQty }],
    }),
  });

  const afterRestockVal = await api('/stock/valuation');
  const afterMap = new Map();
  for (const i of afterRestockVal.items || []) {
    const wh = i.warehouseId || i.warehouse?.id;
    const pid = i.productId || i.product?.id;
    if (wh && pid) afterMap.set(`${wh}:${pid}`, i.quantity || 0);
  }
  const mainAfterRestock = afterMap.get(`${mainWh.id}:${product.id}`) || 0;
  assert(
    Math.abs(mainAfterRestock - (mainBeforeRestock + restockQty)) < 0.001,
    `main after restock expected ${mainBeforeRestock + restockQty} got ${mainAfterRestock}`,
  );

  // Try selling/buying with RETURNS warehouse id — must fail
  console.log('6) RETURNS blocked on sale/purchase pickers (API)');
  let blocked = false;
  try {
    await api('/sales', {
      method: 'POST',
      body: JSON.stringify({
        customerId: customer.id,
        warehouseId: returnsWh.id,
        confirm: true,
        lines: [{ productId: product.id, quantity: 1, unitPrice }],
      }),
    });
  } catch (e) {
    blocked = /مرتجع|تشغيلي|داخلي/.test(String(e.message));
  }
  assert(blocked, 'sale into RETURNS should be rejected');

  console.log('OK — all returns flow assertions passed');
  console.log(JSON.stringify({
    tag,
    purchase: purchase.number,
    sale: sale.number,
    salesReturn: sr.number,
    purchaseReturn: pr.number,
    mainWh: mainWh.name,
    product: product.name,
  }, null, 2));
}

main().catch((err) => {
  console.error('FAIL', err.message || err);
  process.exit(1);
});
