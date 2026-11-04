/**
 * Wipes all business data from Turso (production) then seeds a clean baseline:
 * admin / admin123, main warehouse, returns warehouse, used warehouse, cash, walk-in customer.
 *
 * Usage: node scripts/wipe-all-data.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import bcrypt from 'bcryptjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const envFile of [join(root, '.env.local'), join(root, 'apps', 'api', '.env')]) {
  if (!existsSync(envFile)) continue;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) throw new Error('Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN');

const db = createClient({ url, authToken });

function cuid() {
  return `c${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
}

async function main() {
  const tables = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`);
  const names = tables.rows.map((r) => String(r.name));
  console.log(`wiping ${names.length} tables...`);

  // Prefer child→parent order; disable FK in the same connection when supported.
  const preferred = [
    'IdempotencyKey', 'AutomationRun', 'AutomationRule', 'Attachment', 'FileBlob', 'RecordNote', 'TaskComment', 'WorkTask',
    'SavedReport', 'SavedView', 'AppNotification', 'AuditLog', 'TradeDocumentLine', 'TradeDocument',
    'BankCheck', 'Expense', 'ExpenseCategory', 'CashierShift', 'CashTransaction', 'Receipt', 'Payment',
    'OldBattery', 'ScrapSale', 'SalesReturnLine', 'SalesReturn', 'PurchaseReturnLine', 'PurchaseReturn',
    'SalesInvoiceLine', 'SalesInvoice', 'PurchaseInvoiceLine', 'PurchaseInvoice',
    'StockTransferLine', 'StockTransfer', 'StockMovement', 'StockBalance', 'ProductLocation', 'WarehouseLocation',
    'ProductFieldValue', 'ProductCustomField', 'ProductWarehouse', 'CustomerWarehouse', 'SupplierWarehouse', 'UserWarehouse',
    'CustomerPrice', 'FiscalPeriodLog', 'FiscalPeriod', 'Sequence', 'PayMethod', 'CashAccount',
    'Product', 'Category', 'Customer', 'Supplier', 'Warehouse', 'Setting', 'User', 'OrgNode',
  ];
  const ordered = [...preferred.filter((n) => names.includes(n)), ...names.filter((n) => !preferred.includes(n))];
  try {
    await db.execute('PRAGMA foreign_keys = OFF');
  } catch {
    /* remote may ignore */
  }
  for (const name of ordered) {
    await db.execute({ sql: `DELETE FROM "${name}"`, args: [] });
    console.log(`cleared ${name}`);
  }
  try {
    await db.execute('PRAGMA foreign_keys = ON');
  } catch {
    /* remote may ignore */
  }

  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash('admin123', 10);

  const adminId = cuid();
  const whMain = cuid();
  const whReturns = cuid();
  const whUsed = cuid();
  const cashId = cuid();
  const cashMethodId = cuid();
  const walkInId = cuid();
  const companySetting = cuid();

  await db.batch([
    {
      sql: `INSERT INTO "User" (id, username, passwordHash, fullName, role, isActive, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, 'ADMIN', 1, ?, ?)`,
      args: [adminId, 'admin', passwordHash, 'مدير النظام', now, now],
    },
    {
      sql: `INSERT INTO "Setting" (id, key, value) VALUES (?, 'companyName', ?)`,
      args: [companySetting, 'نظام AK Tech لإدارة المخازن'],
    },
    {
      sql: `INSERT INTO "Warehouse" (id, code, name, location, description, isActive, createdAt, updatedAt)
            VALUES (?, 'WH01', 'المخزن الرئيسي', 'القاهرة', 'المخزن الافتراضي', 1, ?, ?)`,
      args: [whMain, now, now],
    },
    {
      sql: `INSERT INTO "Warehouse" (id, code, name, location, description, isActive, createdAt, updatedAt)
            VALUES (?, 'RETURNS', 'مخزن المرتجعات', NULL, 'مخزن ثابت لاستلام مرتجعات البيع', 1, ?, ?)`,
      args: [whReturns, now, now],
    },
    {
      sql: `INSERT INTO "Warehouse" (id, code, name, location, description, isActive, createdAt, updatedAt)
            VALUES (?, 'USED', 'مستعمل/سيرفس', NULL, 'البطاريات القديمة اللي اتفرزت مستعمل للبيع أو سيرفس', 1, ?, ?)`,
      args: [whUsed, now, now],
    },
    {
      sql: `INSERT INTO "CashAccount" (id, code, name, balance, accountType, isActive, createdAt, updatedAt)
            VALUES (?, 'CASH01', 'الخزنة الرئيسية', 0, 'CASH', 1, ?, ?)`,
      args: [cashId, now, now],
    },
    {
      sql: `INSERT INTO "PayMethod" (id, code, name, kind, cashAccountId, isActive, sortOrder, createdAt)
            VALUES (?, 'CASH', 'نقدي', 'IMMEDIATE', ?, 1, 1, ?)`,
      args: [cashMethodId, cashId, now],
    },
    {
      sql: `INSERT INTO "Customer" (id, code, name, notes, balance, creditLimit, priceList, isActive, createdAt, updatedAt)
            VALUES (?, 'WALKIN', 'عميل سريع', 'عميل نقدي يشتري مرة ويمشي', 0, 0, 'RETAIL', 1, ?, ?)`,
      args: [walkInId, now, now],
    },
  ], 'write');

  console.log('seeded clean baseline');
  console.log('login: admin / admin123');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
