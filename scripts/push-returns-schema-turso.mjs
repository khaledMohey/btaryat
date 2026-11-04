import { existsSync, readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envLocal = join(root, '.env.local');
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) throw new Error('Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN');

const db = createClient({ url, authToken });

async function hasColumn(table, column) {
  const rows = await db.execute(`PRAGMA table_info(${table})`);
  return rows.rows.some((r) => String(r.name) === column);
}

if (!(await hasColumn('SalesReturn', 'customerName'))) {
  await db.execute(`ALTER TABLE SalesReturn ADD COLUMN customerName TEXT`);
  console.log('added SalesReturn.customerName');
} else {
  console.log('SalesReturn.customerName exists');
}

if (!(await hasColumn('PurchaseReturnLine', 'restockedQty'))) {
  await db.execute(`ALTER TABLE PurchaseReturnLine ADD COLUMN restockedQty REAL NOT NULL DEFAULT 0`);
  console.log('added PurchaseReturnLine.restockedQty');
} else {
  console.log('PurchaseReturnLine.restockedQty exists');
}

const existing = await db.execute({
  sql: `SELECT id FROM Warehouse WHERE code = ?`,
  args: ['RETURNS'],
});
if (existing.rows.length) {
  await db.execute({
    sql: `UPDATE Warehouse SET name = ?, description = ?, isActive = 1, updatedAt = CURRENT_TIMESTAMP WHERE code = ?`,
    args: ['مخزن المرتجعات', 'مخزن ثابت لاستلام مرتجعات البيع', 'RETURNS'],
  });
  console.log('updated RETURNS warehouse');
} else {
  const id = `wh_returns_${Date.now().toString(36)}`;
  await db.execute({
    sql: `INSERT INTO Warehouse (id, code, name, description, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: [id, 'RETURNS', 'مخزن المرتجعات', 'مخزن ثابت لاستلام مرتجعات البيع'],
  });
  console.log('created RETURNS warehouse', id);
}

console.log('turso schema ready');
