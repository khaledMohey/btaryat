import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { pageResult, readPage } from '../common/paging';
import { partyWarehouseWhere } from '../common/warehouse-scope';

@Injectable()
export class SuppliersService {
  constructor(private prisma: PrismaService) {}

  private async syncWarehouses(supplierId: string, warehouseIds?: string[]) {
    if (warehouseIds === undefined) return;
    const unique = [...new Set(warehouseIds.map((id) => id.trim()).filter(Boolean))];
    await this.prisma.supplierWarehouse.deleteMany({ where: { supplierId } });
    if (unique.length) {
      await this.prisma.supplierWarehouse.createMany({
        data: unique.map((warehouseId) => ({ supplierId, warehouseId })),
      });
    }
  }

  async findAll(query?: { search?: string; page?: string; pageSize?: string; balance?: string; warehouseIds?: string[] | null }) {
    const page = readPage(query);
    const scope = partyWarehouseWhere(query?.warehouseIds || undefined);
    const searchWhere = query?.search
      ? { OR: [{ name: { contains: query.search } }, { code: { contains: query.search } }] }
      : undefined;
    const balanceWhere = query?.balance === 'debit'
      ? { balance: { gt: 0 } }
      : query?.balance === 'credit'
        ? { balance: { lt: 0 } }
        : undefined;
    const parts = [scope, searchWhere, balanceWhere].filter(Boolean) as Prisma.SupplierWhereInput[];
    const where: Prisma.SupplierWhereInput = parts.length > 1 ? { AND: parts } : parts[0] || {};
    const include = { warehouses: { include: { warehouse: true } } };
    if (!page) return this.prisma.supplier.findMany({ where, include, orderBy: { name: 'asc' } });
    const [total, items, all] = await Promise.all([
      this.prisma.supplier.count({ where }),
      this.prisma.supplier.findMany({ where, include, orderBy: { name: 'asc' }, skip: page.skip, take: page.take }),
      this.prisma.supplier.findMany({ where: scope || {}, select: { balance: true } }),
    ]);
    return pageResult(items, total, page, {
      summary: {
        debitCount: all.filter((row) => row.balance > 0).length,
        creditCount: all.filter((row) => row.balance < 0).length,
      },
    });
  }

  async findOne(id: string) {
    const s = await this.prisma.supplier.findUnique({
      where: { id },
      include: { warehouses: { include: { warehouse: true } } },
    });
    if (!s) throw new NotFoundException('المورد غير موجود');
    return s;
  }

  async create(data: {
    code: string;
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    notes?: string;
    warehouseIds?: string[];
  }) {
    const { warehouseIds, ...rest } = data;
    const unique = [...new Set((warehouseIds || []).map((id) => id.trim()).filter(Boolean))];
    return this.prisma.supplier.create({
      data: {
        ...rest,
        warehouses: unique.length ? { create: unique.map((warehouseId) => ({ warehouseId })) } : undefined,
      },
      include: { warehouses: { include: { warehouse: true } } },
    });
  }

  async update(id: string, data: Partial<{
    code: string; name: string; phone: string; email: string; address: string; notes: string; isActive: boolean;
    warehouseIds: string[];
  }>) {
    const { warehouseIds, ...rest } = data;
    await this.syncWarehouses(id, warehouseIds);
    return this.prisma.supplier.update({
      where: { id },
      data: rest,
      include: { warehouses: { include: { warehouse: true } } },
    });
  }

  async statement(id: string) {
    const methods = await this.prisma.payMethod.findMany();
    const methodName = (value?: string | null) => methods.find((m) => m.id === value)?.name || null;
    const supplier = await this.findOne(id);
    const purchases = await this.prisma.purchaseInvoice.findMany({
      where: { supplierId: id, status: { notIn: ['CANCELLED', 'DRAFT'] } },
      orderBy: { invoiceDate: 'asc' },
    });
    const warrantyFees = await this.prisma.oldBattery.findMany({
      where: { supplierId: id, consumptionFee: { gt: 0 }, claimStatus: { in: ['RECEIVED', 'DELIVERED'] } },
      include: { product: { select: { name: true } }, replacementProduct: { select: { name: true } } },
      orderBy: { replacementAt: 'asc' },
    });
    const scrapSales = await this.prisma.scrapSale.findMany({
      where: { supplierId: id },
      include: { purchaseInvoice: { select: { number: true, status: true } } },
      orderBy: { saleDate: 'asc' },
    });
    const payments = await this.prisma.payment.findMany({
      where: { supplierId: id },
      orderBy: { paidAt: 'asc' },
    });
    const returns = await this.prisma.purchaseReturn.findMany({
      where: { supplierId: id },
      include: { lines: true },
      orderBy: { returnDate: 'asc' },
    });
    const restockRefs = returns.map((r) => `${r.number}-RST`);
    const restockMovements = restockRefs.length
      ? await this.prisma.stockMovement.findMany({
          where: { reference: { in: restockRefs }, type: 'ADJUSTMENT' },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const returnByNumber = new Map(returns.map((r) => [r.number, r]));

    type Row = {
      date: Date;
      type: string;
      ref: string;
      debit: number;
      credit: number;
      method?: string | null;
      note?: string | null;
      kind: 'purchase' | 'payment' | 'purchase_return' | 'restock' | 'scrap' | 'warranty';
      id: string;
    };
    const rows: Row[] = [];
    for (const p of purchases) {
      rows.push({
        date: p.invoiceDate,
        type: 'فاتورة شراء',
        ref: p.number,
        debit: Math.round((p.total + (p.scrapAmount || 0)) * 100) / 100,
        credit: 0,
        method: methodName(p.paymentMethod),
        note: p.notes,
        kind: 'purchase',
        id: p.id,
      });
    }
    for (const p of payments) {
      rows.push({
        date: p.paidAt,
        type: 'سداد',
        ref: p.number,
        debit: 0,
        credit: p.amount,
        method: methodName(p.paymentMethod),
        note: p.note,
        kind: 'payment',
        id: p.id,
      });
    }
    for (const w of warrantyFees) {
      const date = w.replacementAt || w.updatedAt;
      const what = w.replacementProduct?.name || w.product?.name || w.label || 'بطارية';
      rows.push({ date, type: 'استهلاك ضمان', ref: w.number, debit: w.consumptionFee, credit: 0, note: `بديل ${what}`, kind: 'warranty', id: w.id });
      if (w.feeSettlement === 'CASH') {
        rows.push({ date, type: 'سداد استهلاك ضمان', ref: w.number, debit: 0, credit: w.consumptionFee, method: methodName(w.feeMethodId), kind: 'warranty', id: w.id });
      }
    }
    for (const s of scrapSales) {
      if (s.purchaseInvoice && ['DRAFT', 'CANCELLED'].includes(s.purchaseInvoice.status)) continue;
      const weight = `${s.netKg} كجم${s.withWater ? ` (بعد خصم ${s.waterPercent}% مياه من ${s.grossKg})` : ''} × ${s.priceKg}`;
      const type = s.settlement === 'INVOICE'
        ? `خردة مخصومة من فاتورة ${s.purchaseInvoice?.number || ''}`
        : s.settlement === 'CASH'
          ? 'بيع خردة'
          : 'بيع خردة (خصم من الحساب)';
      rows.push({ date: s.saleDate, type, ref: s.number, debit: 0, credit: s.amount, note: s.notes || weight, kind: 'scrap', id: s.id });
      if (s.settlement === 'CASH') {
        rows.push({ date: s.saleDate, type: 'استلام فلوس الخردة', ref: s.number, debit: s.amount, credit: 0, method: methodName(s.paymentMethod), note: weight, kind: 'scrap', id: s.id });
      }
    }
    for (const r of returns) {
      rows.push({
        date: r.returnDate,
        type: 'مرتجع شراء',
        ref: r.number,
        debit: 0,
        credit: r.total,
        note: r.notes,
        kind: 'purchase_return',
        id: r.id,
      });
      if (r.consumptionFee > 0) {
        rows.push({ date: r.returnDate, type: 'استهلاك مرتجع شراء', ref: r.number, debit: r.consumptionFee, credit: 0, kind: 'purchase_return', id: r.id });
        if (r.feeSettlement === 'CASH') {
          rows.push({ date: r.returnDate, type: 'سداد استهلاك المرتجع', ref: r.number, debit: 0, credit: r.consumptionFee, method: methodName(r.feeMethodId), kind: 'purchase_return', id: r.id });
        }
      }
    }
    const restockGroups = new Map<string, { date: Date; amount: number; returnId: string; ref: string; note: string }>();
    for (const mov of restockMovements) {
      const number = (mov.reference || '').replace(/-RST$/, '');
      const ret = returnByNumber.get(number);
      if (!ret) continue;
      const day = mov.createdAt.toISOString().slice(0, 10);
      const key = `${mov.reference}:${day}`;
      const amount = mov.quantity * (mov.unitCost || 0);
      const existing = restockGroups.get(key);
      if (existing) {
        existing.amount += amount;
        if (mov.createdAt > existing.date) existing.date = mov.createdAt;
      } else {
        restockGroups.set(key, {
          date: mov.createdAt,
          amount,
          returnId: ret.id,
          ref: mov.reference || `${ret.number}-RST`,
          note: mov.note || `استلام بديل بعد مرتجع ${ret.number}`,
        });
      }
    }
    for (const g of restockGroups.values()) {
      if (g.amount <= 0.0001) continue;
      rows.push({
        date: g.date,
        type: 'استلام بديل',
        ref: g.ref,
        debit: Math.round(g.amount * 100) / 100,
        credit: 0,
        note: g.note,
        kind: 'restock',
        id: g.returnId,
      });
    }
    rows.sort((a, b) => a.date.getTime() - b.date.getTime());
    let running = 0;
    const statement = rows.map((r) => {
      running += r.debit - r.credit;
      return { ...r, balance: Math.round(running * 100) / 100 };
    });
    const computed = statement.length ? statement[statement.length - 1].balance : 0;
    if (Math.abs(computed - supplier.balance) > 0.05) {
      await this.prisma.supplier.update({ where: { id }, data: { balance: computed } });
      supplier.balance = computed;
    }
    return { supplier, statement, balance: supplier.balance };
  }

  async movementDetail(kind: string, id: string) {
    if (kind === 'purchase') {
      const row = await this.prisma.purchaseInvoice.findUnique({
        where: { id },
        include: {
          supplier: true,
          warehouse: true,
          lines: { include: { product: true } },
          payments: true,
        },
      });
      if (!row) throw new NotFoundException('الفاتورة غير موجودة');
      return { kind, row };
    }
    if (kind === 'payment') {
      const row = await this.prisma.payment.findUnique({
        where: { id },
        include: {
          supplier: true,
          cashAccount: true,
          purchaseInvoice: true,
        },
      });
      if (!row) throw new NotFoundException('السداد غير موجود');
      return { kind, row };
    }
    if (kind === 'purchase_return' || kind === 'restock') {
      const row = await this.prisma.purchaseReturn.findUnique({
        where: { id },
        include: {
          supplier: true,
          warehouse: true,
          purchaseInvoice: true,
          lines: { include: { product: true } },
        },
      });
      if (!row) throw new NotFoundException('مرتجع الشراء غير موجود');
      const restocks = await this.prisma.stockMovement.findMany({
        where: { reference: `${row.number}-RST`, type: 'ADJUSTMENT' },
        include: { product: true, warehouse: true },
        orderBy: { createdAt: 'asc' },
      });
      return { kind, row, restocks };
    }
    if (kind === 'warranty') {
      const row = await this.prisma.oldBattery.findUnique({
        where: { id },
        include: { supplier: true, product: true, replacementProduct: true, replacementWarehouse: true },
      });
      if (!row) throw new NotFoundException('مرتجع الضمان غير موجود');
      return { kind, row };
    }
    if (kind === 'scrap') {
      const row = await this.prisma.scrapSale.findUnique({
        where: { id },
        include: { supplier: true, purchaseInvoice: true, cashAccount: true },
      });
      if (!row) throw new NotFoundException('بيع الخردة غير موجود');
      return { kind, row };
    }
    throw new NotFoundException('نوع الحركة غير معروف');
  }
}
