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

async function hasTable(table) {
  const rows = await db.execute({ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, args: [table] });
  return rows.rows.length > 0;
}

if (!(await hasColumn('PurchaseInvoice', 'scrapAmount'))) {
  await db.execute(`ALTER TABLE PurchaseInvoice ADD COLUMN scrapAmount REAL NOT NULL DEFAULT 0`);
  console.log('added PurchaseInvoice.scrapAmount');
} else {
  console.log('PurchaseInvoice.scrapAmount exists');
}

if (!(await hasTable('ScrapSale'))) {
  await db.batch([
    `CREATE TABLE "ScrapSale" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "number" TEXT NOT NULL,
      "supplierId" TEXT NOT NULL,
      "saleDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "withWater" BOOLEAN NOT NULL DEFAULT false,
      "waterPercent" REAL NOT NULL DEFAULT 15,
      "grossKg" REAL NOT NULL,
      "netKg" REAL NOT NULL,
      "priceKg" REAL NOT NULL,
      "amount" REAL NOT NULL,
      "settlement" TEXT NOT NULL,
      "purchaseInvoiceId" TEXT,
      "cashAccountId" TEXT,
      "paymentMethod" TEXT NOT NULL DEFAULT '',
      "notes" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ScrapSale_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "ScrapSale_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "PurchaseInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "ScrapSale_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    )`,
    `CREATE UNIQUE INDEX "ScrapSale_number_key" ON "ScrapSale"("number")`,
    `CREATE UNIQUE INDEX "ScrapSale_purchaseInvoiceId_key" ON "ScrapSale"("purchaseInvoiceId")`,
    `CREATE INDEX "ScrapSale_supplierId_idx" ON "ScrapSale"("supplierId")`,
    `CREATE INDEX "ScrapSale_saleDate_idx" ON "ScrapSale"("saleDate")`,
  ], 'write');
  console.log('created ScrapSale');
} else {
  console.log('ScrapSale exists');
}

console.log('turso scrap schema ready');
