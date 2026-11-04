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

async function hasIndex(name) {
  const rows = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    args: [name],
  });
  return rows.rows.length > 0;
}

const columns = [
  ['salesReturnId', 'TEXT'],
  ['loanerProductId', 'TEXT'],
  ['loanerWarehouseId', 'TEXT'],
  ['loanerUnitCost', 'REAL'],
  ['loanerIssuedAt', 'DATETIME'],
  ['loanerReturnedAt', 'DATETIME'],
];

for (const [column, type] of columns) {
  if (await hasColumn('OldBattery', column)) {
    console.log(`OldBattery.${column} exists`);
  } else {
    await db.execute(`ALTER TABLE OldBattery ADD COLUMN ${column} ${type}`);
    console.log(`added OldBattery.${column}`);
  }
}

if (!(await hasIndex('OldBattery_salesReturnId_idx'))) {
  await db.execute(`CREATE INDEX "OldBattery_salesReturnId_idx" ON "OldBattery"("salesReturnId")`);
  console.log('added OldBattery_salesReturnId_idx');
} else {
  console.log('OldBattery_salesReturnId_idx exists');
}

console.log('done');
