import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CashDirection, InvoiceStatus, PayMethodKind, Prisma, ScrapSale } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';
import { assertPeriodsOpen } from '../settings/period-lock';
import { statusFromPayment } from '../common/invoice-post';
import { scrapCalc, WATER_PERCENT } from '../common/scrap';

type Tx = Prisma.TransactionClient;

export type ScrapSettlement = 'INVOICE' | 'CASH' | 'BALANCE';

export type ScrapPayload = {
  supplierId: string;
  saleDate?: string;
  withWater?: boolean;
  grossKg: number;
  priceKg: number;
  settlement: ScrapSettlement;
  purchaseInvoiceId?: string;
  methodId?: string;
  notes?: string;
  oldBatteryIds?: string[];
};

const SETTLEMENTS: ScrapSettlement[] = ['INVOICE', 'CASH', 'BALANCE'];

@Injectable()
export class ScrapService {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
  ) {}

  private include() {
    return {
      supplier: { select: { id: true, code: true, name: true } },
      purchaseInvoice: { select: { id: true, number: true, status: true, total: true, paidAmount: true } },
      cashAccount: { select: { id: true, name: true } },
      oldBatteries: { select: { id: true, number: true, intakeValue: true, label: true, product: { select: { name: true } } } },
    };
  }

  /** كوم الخردة: بطاريات اتفرزت خردة ولسه متباعتش */
  pile(scrapId?: string) {
    return this.prisma.oldBattery.findMany({
      where: { decision: 'SCRAP', OR: [{ scrapSaleId: null }, ...(scrapId ? [{ scrapSaleId: scrapId }] : [])] },
      select: { id: true, number: true, intakeValue: true, weightKg: true, label: true, receivedAt: true, scrapSaleId: true, product: { select: { name: true } } },
      orderBy: { receivedAt: 'asc' },
    });
  }

  private async linkBatteries(tx: Tx, scrapSaleId: string, ids?: string[]) {
    await tx.oldBattery.updateMany({ where: { scrapSaleId }, data: { scrapSaleId: null } });
    if (!ids?.length) return;
    const rows = await tx.oldBattery.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, decision: true, scrapSaleId: true } });
    for (const row of rows) {
      if (row.decision !== 'SCRAP') throw new BadRequestException(`${row.number} مش متفرزة خردة`);
      if (row.scrapSaleId && row.scrapSaleId !== scrapSaleId) throw new BadRequestException(`${row.number} اتباعت في بيع خردة تاني`);
    }
    await tx.oldBattery.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { scrapSaleId } });
  }

  config() {
    return { waterPercent: WATER_PERCENT };
  }

  suppliers() {
    return this.prisma.supplier.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  list(query: { supplierId?: string; from?: string; to?: string }) {
    const range: Prisma.DateTimeFilter = {};
    if (query.from) range.gte = new Date(`${query.from}T00:00:00`);
    if (query.to) range.lte = new Date(`${query.to}T23:59:59.999`);
    return this.prisma.scrapSale.findMany({
      where: {
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.from || query.to ? { saleDate: range } : {}),
      },
      include: this.include(),
      orderBy: { saleDate: 'desc' },
    });
  }

  async findOne(id: string) {
    const row = await this.prisma.scrapSale.findUnique({ where: { id }, include: this.include() });
    if (!row) throw new NotFoundException('بيع الخردة غير موجود');
    return row;
  }

  /** فواتير شراء مفتوحة للمورد ينفع تتخصم منها الخردة */
  async openInvoices(supplierId: string, scrapId?: string) {
    const rows = await this.prisma.purchaseInvoice.findMany({
      where: {
        supplierId,
        status: { in: [InvoiceStatus.CONFIRMED, InvoiceStatus.PARTIAL, InvoiceStatus.PAID] },
        OR: [{ scrapSale: null }, ...(scrapId ? [{ scrapSale: { id: scrapId } }] : [])],
      },
      select: { id: true, number: true, invoiceDate: true, total: true, paidAmount: true, scrapAmount: true, scrapSale: { select: { id: true } } },
      orderBy: { invoiceDate: 'desc' },
      take: 100,
    });
    return rows
      .map((row) => {
        const own = row.scrapSale?.id === scrapId ? row.scrapAmount : 0;
        return { id: row.id, number: row.number, invoiceDate: row.invoiceDate, total: row.total + own, paidAmount: row.paidAmount, due: Math.round((row.total + own - row.paidAmount) * 100) / 100 };
      })
      .filter((row) => row.due > 0.009);
  }

  private normalize(data: ScrapPayload) {
    if (!data.supplierId) throw new BadRequestException('اختار المورد');
    if (!SETTLEMENTS.includes(data.settlement)) throw new BadRequestException('اختار طريقة التسوية');
    const calc = scrapCalc(data);
    if (calc.grossKg <= 0) throw new BadRequestException('أدخل وزن الخردة');
    if (calc.priceKg <= 0) throw new BadRequestException('أدخل سعر الكيلو');
    if (data.settlement === 'INVOICE' && !data.purchaseInvoiceId) throw new BadRequestException('اختار فاتورة الشراء اللي هتتخصم منها الخردة');
    if (data.settlement === 'CASH' && !data.methodId) throw new BadRequestException('اختار طريقة استلام الفلوس');
    return {
      ...calc,
      supplierId: data.supplierId,
      saleDate: data.saleDate ? new Date(data.saleDate) : new Date(),
      settlement: data.settlement,
      purchaseInvoiceId: data.settlement === 'INVOICE' ? data.purchaseInvoiceId! : null,
      methodId: data.settlement === 'CASH' ? data.methodId! : '',
      notes: data.notes?.trim() || null,
    };
  }

  private async apply(tx: Tx, row: ScrapSale) {
    if (row.settlement === 'INVOICE') {
      const inv = await tx.purchaseInvoice.findUnique({ where: { id: row.purchaseInvoiceId! } });
      if (!inv) throw new BadRequestException('فاتورة الشراء غير موجودة');
      if (inv.supplierId !== row.supplierId) throw new BadRequestException('الفاتورة مش لنفس المورد');
      if (inv.status === InvoiceStatus.CANCELLED) throw new BadRequestException('الفاتورة ملغية');
      if (inv.scrapAmount > 0.009) throw new BadRequestException('الفاتورة عليها خردة بالفعل');
      const posted = inv.status !== InvoiceStatus.DRAFT;
      if (posted && row.amount > inv.total - inv.paidAmount + 0.009) {
        throw new BadRequestException(`قيمة الخردة أكبر من المتبقي على الفاتورة (${Math.round((inv.total - inv.paidAmount) * 100) / 100})`);
      }
      if (!posted && row.amount > inv.total + 0.009) throw new BadRequestException('قيمة الخردة أكبر من إجمالي الفاتورة');
      const total = Math.round((inv.total - row.amount) * 100) / 100;
      await tx.purchaseInvoice.update({
        where: { id: inv.id },
        data: {
          scrapAmount: row.amount,
          total,
          ...(posted ? { status: statusFromPayment(total, inv.paidAmount, true, 0.009) } : {}),
        },
      });
      if (posted) await tx.supplier.update({ where: { id: row.supplierId }, data: { balance: { decrement: row.amount } } });
      return;
    }
    if (row.settlement === 'CASH') {
      const method = await tx.payMethod.findUnique({ where: { id: row.paymentMethod } });
      if (!method || !method.isActive) throw new BadRequestException('طريقة الدفع غير موجودة');
      if (method.kind !== PayMethodKind.IMMEDIATE || !method.cashAccountId) {
        throw new BadRequestException('اختار طريقة دفع فورية مربوطة بخزنة/حساب');
      }
      const supplier = await tx.supplier.findUnique({ where: { id: row.supplierId }, select: { name: true } });
      await tx.cashAccount.update({ where: { id: method.cashAccountId }, data: { balance: { increment: row.amount } } });
      await tx.cashTransaction.create({
        data: {
          accountId: method.cashAccountId,
          direction: CashDirection.IN,
          amount: row.amount,
          description: `بيع خردة ${row.number} — ${supplier?.name || ''} (${row.netKg} كجم)`,
          paymentMethod: method.id,
          reference: row.number,
        },
      });
      await tx.scrapSale.update({ where: { id: row.id }, data: { cashAccountId: method.cashAccountId } });
      return;
    }
    await tx.supplier.update({ where: { id: row.supplierId }, data: { balance: { decrement: row.amount } } });
  }

  private async reverse(tx: Tx, row: ScrapSale) {
    if (row.settlement === 'INVOICE' && row.purchaseInvoiceId) {
      const inv = await tx.purchaseInvoice.findUnique({ where: { id: row.purchaseInvoiceId } });
      if (!inv) return;
      const posted = inv.status !== InvoiceStatus.DRAFT && inv.status !== InvoiceStatus.CANCELLED;
      const total = Math.round((inv.total + inv.scrapAmount) * 100) / 100;
      await tx.purchaseInvoice.update({
        where: { id: inv.id },
        data: {
          scrapAmount: 0,
          total,
          ...(posted ? { status: statusFromPayment(total, inv.paidAmount, true, 0.009) } : {}),
        },
      });
      if (posted) await tx.supplier.update({ where: { id: row.supplierId }, data: { balance: { increment: inv.scrapAmount } } });
      return;
    }
    if (row.settlement === 'CASH') {
      if (row.cashAccountId) {
        const account = await tx.cashAccount.findUnique({ where: { id: row.cashAccountId } });
        if (account && account.balance < row.amount - 0.009) {
          throw new BadRequestException('رصيد الخزنة غير كافٍ لعكس بيع الخردة');
        }
        await tx.cashAccount.update({ where: { id: row.cashAccountId }, data: { balance: { decrement: row.amount } } });
      }
      await tx.cashTransaction.deleteMany({ where: { reference: row.number } });
      return;
    }
    await tx.supplier.update({ where: { id: row.supplierId }, data: { balance: { increment: row.amount } } });
  }

  async create(data: ScrapPayload) {
    const n = this.normalize(data);
    await assertPeriodsOpen(this.prisma, n.saleDate);
    const number = await this.sequence.next('scrap', 'SCR');
    const id = await this.prisma.$transaction(async (tx) => {
      const row = await tx.scrapSale.create({
        data: {
          number,
          supplierId: n.supplierId,
          saleDate: n.saleDate,
          withWater: n.withWater,
          waterPercent: n.waterPercent,
          grossKg: n.grossKg,
          netKg: n.netKg,
          priceKg: n.priceKg,
          amount: n.amount,
          settlement: n.settlement,
          purchaseInvoiceId: n.purchaseInvoiceId,
          paymentMethod: n.methodId,
          notes: n.notes,
        },
      });
      await this.apply(tx, row);
      await this.linkBatteries(tx, row.id, data.oldBatteryIds);
      return row.id;
    });
    return this.findOne(id);
  }

  async update(id: string, data: ScrapPayload) {
    const existing = await this.prisma.scrapSale.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('بيع الخردة غير موجود');
    const n = this.normalize(data);
    await assertPeriodsOpen(this.prisma, existing.saleDate, n.saleDate);
    await this.prisma.$transaction(async (tx) => {
      await this.reverse(tx, existing);
      const row = await tx.scrapSale.update({
        where: { id },
        data: {
          supplierId: n.supplierId,
          saleDate: n.saleDate,
          withWater: n.withWater,
          waterPercent: n.waterPercent,
          grossKg: n.grossKg,
          netKg: n.netKg,
          priceKg: n.priceKg,
          amount: n.amount,
          settlement: n.settlement,
          purchaseInvoiceId: n.purchaseInvoiceId,
          cashAccountId: null,
          paymentMethod: n.methodId,
          notes: n.notes,
        },
      });
      await this.apply(tx, row);
      if (data.oldBatteryIds !== undefined) await this.linkBatteries(tx, id, data.oldBatteryIds);
    });
    return this.findOne(id);
  }

  async remove(id: string) {
    const existing = await this.prisma.scrapSale.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('بيع الخردة غير موجود');
    await assertPeriodsOpen(this.prisma, existing.saleDate);
    await this.prisma.$transaction(async (tx) => {
      await this.reverse(tx, existing);
      await tx.scrapSale.delete({ where: { id } });
    });
    return { ok: true };
  }
}
