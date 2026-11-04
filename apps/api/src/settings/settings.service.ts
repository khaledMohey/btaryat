import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { periodLabel, periodParts } from './period-lock';

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  async getAll() {
    const settings = await this.prisma.setting.findMany();
    const map: Record<string, string> = {};
    for (const s of settings) {
      if (s.key === 'editPasswordHash') continue;
      map[s.key] = s.value;
    }
    return {
      companyName: map.companyName || 'نظام AK Tech لإدارة المخازن',
      apiUrl: map.apiUrl || '',
      ...map,
      editPasswordSet: settings.some((row) => row.key === 'editPasswordHash' && row.value) ? '1' : '0',
    };
  }

  async setEditPassword(password: string) {
    const editPasswordHash = await bcrypt.hash(password, 10);
    await this.upsert('editPasswordHash', editPasswordHash);
    return { ok: true };
  }

  async editPasswordHash() {
    const row = await this.prisma.setting.findUnique({ where: { key: 'editPasswordHash' } });
    return row?.value || '';
  }

  async upsert(key: string, value: string) {
    return this.prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async updateMany(data: Record<string, string>) {
    for (const [key, value] of Object.entries(data)) {
      if (/password/i.test(key)) continue;
      await this.upsert(key, value);
    }
    return this.getAll();
  }

  async backup() {
    const snapshot = await this.snapshot();
    const dir = this.backupDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `m5azen-${stamp}.json`;
    writeFileSync(join(dir, fileName), JSON.stringify(snapshot));
    const dbPath = this.sqlitePath();
    if (dbPath) copyFileSync(dbPath, join(dir, `m5azen-${stamp}.db`));
    return { ok: true, fileName, snapshot };
  }

  readBackup(fileName: string) {
    const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '');
    const path = join(this.backupDir(), safe);
    if (!existsSync(path)) throw new BadRequestException('النسخة غير موجودة');
    if (safe.endsWith('.json')) return JSON.parse(readFileSync(path, 'utf8'));
    return readFileSync(path);
  }

  async restore(snapshot: { version?: number; tables?: Record<string, unknown[]> }) {
    if (snapshot?.version !== 1 || !snapshot.tables) throw new BadRequestException('ملف النسخة غير صالح');
    const tables = reviveDates(snapshot.tables);
    await this.prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
    try {
      for (const name of [...SNAPSHOT_MODELS].reverse()) {
        const delegate = (this.prisma as unknown as Record<string, { deleteMany?: () => Promise<unknown> }>)[name];
        if (delegate?.deleteMany) await delegate.deleteMany();
      }
      for (const name of SNAPSHOT_MODELS) {
        const rows = tables[name];
        const delegate = (this.prisma as unknown as Record<string, { createMany?: (args: { data: unknown[] }) => Promise<unknown> }>)[name];
        if (!rows?.length || !delegate?.createMany) continue;
        for (let i = 0; i < rows.length; i += 200) {
          await delegate.createMany({ data: rows.slice(i, i + 200) });
        }
      }
    } finally {
      await this.prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON');
    }
    return { ok: true };
  }

  private async snapshot() {
    const tables: Record<string, unknown[]> = {};
    for (const name of SNAPSHOT_MODELS) {
      const delegate = (this.prisma as unknown as Record<string, { findMany?: () => Promise<unknown[]> }>)[name];
      if (!delegate?.findMany) continue;
      tables[name] = await delegate.findMany();
    }
    return { version: 1, createdAt: new Date().toISOString(), tables };
  }

  private backupDir() {
    if (process.env.TURSO_DATABASE_URL) return join(tmpdir(), 'm5azen-backups');
    return join(process.cwd(), 'backups');
  }

  private sqlitePath() {
    if (process.env.TURSO_DATABASE_URL) return '';
    const candidates = [
      join(process.cwd(), 'prisma', 'dev.db'),
      join(process.cwd(), 'apps', 'api', 'prisma', 'dev.db'),
      join(__dirname, '..', '..', 'prisma', 'dev.db'),
    ];
    return candidates.find((path) => existsSync(path)) || '';
  }

  async listPeriods() {
    const now = periodParts(new Date());
    const months: { year: number; month: number }[] = [];
    let year = now.year;
    let month = now.month;
    for (let i = 0; i < 18; i++) {
      months.push({ year, month });
      month -= 1;
      if (month === 0) {
        month = 12;
        year -= 1;
      }
    }
    const closed = await this.prisma.fiscalPeriod.findMany({
      where: { closedAt: { not: null } },
      include: { closedBy: { select: { fullName: true } } },
    });
    for (const row of closed) {
      if (!months.some((item) => item.year === row.year && item.month === row.month)) {
        months.push({ year: row.year, month: row.month });
      }
    }
    const closedMap = new Map(closed.map((row) => [`${row.year}-${row.month}`, row]));
    const log = await this.prisma.fiscalPeriodLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 40,
      include: { user: { select: { fullName: true } } },
    });
    return {
      periods: months.map((item) => {
        const row = closedMap.get(`${item.year}-${item.month}`);
        return {
          year: item.year,
          month: item.month,
          label: periodLabel(item.year, item.month),
          closed: !!row?.closedAt,
          closedAt: row?.closedAt || null,
          closedBy: row?.closedBy?.fullName || '',
        };
      }),
      log: log.map((row) => ({
        id: row.id,
        label: periodLabel(row.year, row.month),
        action: row.action,
        reason: row.reason || '',
        userName: row.user.fullName,
        createdAt: row.createdAt,
      })),
    };
  }

  async closePeriod(year: number, month: number, userId: string) {
    this.assertMonth(year, month);
    const now = periodParts(new Date());
    if (year > now.year || (year === now.year && month > now.month)) {
      throw new BadRequestException('الشهر لسه ما جاش');
    }
    const existing = await this.prisma.fiscalPeriod.findUnique({ where: { year_month: { year, month } } });
    if (existing?.closedAt) throw new BadRequestException('الشهر مقفول بالفعل');
    await this.prisma.$transaction([
      this.prisma.fiscalPeriod.upsert({
        where: { year_month: { year, month } },
        create: { year, month, closedAt: new Date(), closedById: userId },
        update: { closedAt: new Date(), closedById: userId },
      }),
      this.prisma.fiscalPeriodLog.create({
        data: { year, month, action: 'CLOSE', userId },
      }),
    ]);
    return this.listPeriods();
  }

  async reopenPeriod(year: number, month: number, reason: string, userId: string) {
    this.assertMonth(year, month);
    const text = reason.trim();
    if (text.length < 3) throw new BadRequestException('اكتب سبب فتح الشهر');
    const existing = await this.prisma.fiscalPeriod.findUnique({ where: { year_month: { year, month } } });
    if (!existing?.closedAt) throw new BadRequestException('الشهر مفتوح');
    await this.prisma.$transaction([
      this.prisma.fiscalPeriod.update({
        where: { year_month: { year, month } },
        data: { closedAt: null, closedById: null },
      }),
      this.prisma.fiscalPeriodLog.create({
        data: { year, month, action: 'REOPEN', reason: text, userId },
      }),
    ]);
    return this.listPeriods();
  }

  private assertMonth(year: number, month: number) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('الشهر غير صالح');
    }
  }

  listBackups() {
    const dir = this.backupDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json') || file.endsWith('.db'))
      .sort()
      .reverse();
  }

  /** External URL for the desktop installer (e.g. GitHub release / object storage). Never exposed without password check. */
  desktopDownloadUrl() {
    return (process.env.DESKTOP_DOWNLOAD_URL || '').trim();
  }

  resolveDesktopInstaller(): { path: string; fileName: string } | null {
    const configured = (process.env.DESKTOP_INSTALLER_PATH || '').trim();
    if (configured && existsSync(configured)) {
      return { path: configured, fileName: configured.split(/[/\\]/).pop() || 'm5azen-desktop-setup.exe' };
    }
    const dirs = [
      join(process.cwd(), 'desktop-releases'),
      join(process.cwd(), 'apps', 'api', 'desktop-releases'),
      join(__dirname, '..', '..', 'desktop-releases'),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir)
        .filter((file) => /\.(exe|msi|zip)$/i.test(file))
        .sort()
        .reverse();
      if (files[0]) return { path: join(dir, files[0]), fileName: files[0] };
    }
    return null;
  }

  readDesktopInstaller(fileNameHint?: string) {
    const resolved = this.resolveDesktopInstaller();
    if (!resolved) throw new BadRequestException('نسخة الديسكتوب غير متاحة حالياً');
    if (fileNameHint && resolved.fileName !== fileNameHint) {
      throw new BadRequestException('رابط التحميل غير صالح');
    }
    return {
      fileName: resolved.fileName,
      data: readFileSync(resolved.path),
    };
  }
}

const SNAPSHOT_MODELS = [
  'user', 'warehouse', 'productCustomField', 'category', 'product', 'productFieldValue', 'stockBalance', 'stockMovement',
  'stockTransfer', 'stockTransferLine', 'supplier', 'customer', 'cashAccount', 'payMethod', 'cashTransaction',
  'salesInvoice', 'salesInvoiceLine', 'purchaseInvoice', 'purchaseInvoiceLine', 'salesReturn', 'salesReturnLine',
  'purchaseReturn', 'purchaseReturnLine', 'payment', 'receipt', 'setting', 'fiscalPeriod', 'fiscalPeriodLog', 'sequence',
  'customerPrice', 'warehouseLocation', 'productLocation', 'userWarehouse', 'cashierShift', 'expenseCategory', 'expense',
  'bankCheck', 'tradeDocument', 'tradeDocumentLine', 'auditLog', 'appNotification', 'orgNode', 'recordNote', 'workTask',
  'taskComment', 'savedReport', 'savedView', 'attachment', 'fileBlob', 'automationRule', 'automationRun', 'idempotencyKey',
] as const;

function reviveDates(value: unknown): any {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
  if (Array.isArray(value)) return value.map(reviveDates);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = reviveDates(item);
    return out;
  }
  return value;
}
