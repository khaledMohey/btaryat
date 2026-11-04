import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InvoiceStatus, Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';
import { normalizeTenders, postCustomerTenders, reverseSaleMoney, sumTenders, syncSaleTenders, TenderInput } from '../cash/tenders';
import { assertPeriodsOpen } from '../settings/period-lock';
import { assertPaidFits, lineAmount, paidAmountOf, postStockLine, statusFromPayment, sumLineTotals, taxFromPercent } from '../common/invoice-post';
import { claimRequest, finishRequest, releaseRequest } from '../common/idempotency';
import { pageResult, readPage } from '../common/paging';
import { dueTone } from '../common/due';
import { salePriceHints } from '../common/price-hints';
import { mapSaleLines, previewFifo, recostProducts, replayFifo } from '../common/fifo';
import { syncSaleOldBatteries } from '../oldbatteries/oldbatteries.service';
type ScrapInput = {
  hasScrap?: boolean;
  scrapKg?: number;
  scrapPieces?: number;
  scrapPriceKg?: number;
  scrapAmount?: number;
  scrapKind?: string;
};

function scrapFields(data: ScrapInput) {
  const hasScrap = !!data.hasScrap;
  const scrapKg = hasScrap ? Math.max(0, data.scrapKg || 0) : 0;
  const scrapPieces = hasScrap ? Math.max(1, Math.round(data.scrapPieces || 0)) : 0;
  const scrapPriceKg = hasScrap ? Math.max(0, data.scrapPriceKg || 0) : 0;
  const computed = Math.round(scrapKg * scrapPriceKg * 100) / 100;
  const scrapAmount = hasScrap
    ? Math.max(0, Math.round((data.scrapAmount != null ? data.scrapAmount : computed) * 100) / 100)
    : 0;
  const scrapKind = hasScrap && data.scrapKind === 'WARRANTY_SWAP' ? 'WARRANTY_SWAP' : 'SCRAP';
  return { hasScrap, scrapKg, scrapPieces, scrapPriceKg, scrapAmount, scrapKind };
}

@Injectable()
export class SalesService {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
  ) {}

  priceHints(customerId?: string, excludeInvoiceId?: string) {
    return salePriceHints(this.prisma, customerId, excludeInvoiceId);
  }

  async findAll(query?: { status?: InvoiceStatus; page?: string; pageSize?: string; q?: string; due?: string; warehouseIds?: string[] | null }) {
    const page = readPage(query);
    const where: Prisma.SalesInvoiceWhereInput = {};
    if (query?.warehouseIds?.length) where.warehouseId = { in: query.warehouseIds };
    if (query?.due === '1') where.status = { in: [InvoiceStatus.CONFIRMED, InvoiceStatus.PARTIAL] };
    else if (query?.status) where.status = query.status;
    if (query?.q) {
      where.OR = [
        { number: { contains: query.q } },
        { customer: { name: { contains: query.q } } },
        { warehouse: { name: { contains: query.q } } },
      ];
    }
    const include = {
      customer: true,
      warehouse: true,
      lines: { include: { product: true } },
      receipts: { orderBy: { receivedAt: 'asc' as const } },
    };
    if (!page) {
      return this.prisma.salesInvoice.findMany({ where, include, orderBy: { createdAt: 'desc' } });
    }
    const [total, items, all] = await Promise.all([
      this.prisma.salesInvoice.count({ where }),
      this.prisma.salesInvoice.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.take }),
      this.prisma.salesInvoice.findMany({ where, select: { status: true, total: true, paidAmount: true, invoiceDate: true } }),
    ]);
    const live = all.filter((row) => row.status !== InvoiceStatus.CANCELLED && row.status !== InvoiceStatus.DRAFT);
    const summary = { count: all.length, total: 0, paid: 0, due: 0, red: 0, yellow: 0, green: 0 };
    for (const row of live) {
      summary.total += row.total;
      summary.paid += row.paidAmount;
      summary.due += Math.max(0, row.total - row.paidAmount);
    }
    for (const row of all) {
      if (row.status === InvoiceStatus.CANCELLED) continue;
      const tone = dueTone(row.invoiceDate, row.total - row.paidAmount);
      if (tone === 'red' || tone === 'yellow' || tone === 'green') summary[tone] += 1;
    }
    return pageResult(items, total, page, { summary });
  }

  dues(warehouseIds?: string[] | null) {
    return this.prisma.salesInvoice.findMany({
      where: {
        status: { in: [InvoiceStatus.CONFIRMED, InvoiceStatus.PARTIAL] },
        ...(warehouseIds?.length ? { warehouseId: { in: warehouseIds } } : {}),
      },
      select: { invoiceDate: true, total: true, paidAmount: true, customerId: true },
    });
  }

  async findOne(id: string) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        customer: true,
        warehouse: true,
        lines: { include: { product: true } },
        receipts: { orderBy: { receivedAt: 'asc' } },
        createdBy: { select: { fullName: true } },
      },
    });
    if (!inv) throw new NotFoundException('فاتورة البيع غير موجودة');
    return inv;
  }

  async create(data: {
    customerId: string;
    warehouseId: string;
    invoiceDate?: string;
    discount?: number;
    tax?: number;
    notes?: string;
    paidAmount?: number;
    payments?: TenderInput[];
    taxRate?: number;
    shiftId?: string | null;
    confirm?: boolean;
    createdById?: string;
    idempotencyKey?: string;
    hasScrap?: boolean;
    scrapKg?: number;
    scrapPieces?: number;
    scrapPriceKg?: number;
    scrapAmount?: number;
    lines: { productId: string; quantity: number; unitPrice: number; discount?: number }[];
  }) {
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً للفاتورة');
    const claim = await claimRequest(this.prisma, { key: data.idempotencyKey, scope: 'sales', userId: data.createdById });
    if (claim.status === 'replay') return this.findOne(claim.resourceId);
    try {
      const invoice = await this.insertSale(data);
      await finishRequest(this.prisma, claim.key, invoice.id);
      if (data.confirm) {
        await recostProducts(this.prisma, data.lines.map((l) => l.productId));
        await syncSaleOldBatteries(this.prisma, this.sequence, invoice.id);
      }
      return invoice;
    } catch (error) {
      await releaseRequest(this.prisma, claim.key);
      throw error;
    }
  }

  private async insertSale(data: {
    customerId: string;
    warehouseId: string;
    invoiceDate?: string;
    discount?: number;
    tax?: number;
    notes?: string;
    paidAmount?: number;
    payments?: TenderInput[];
    taxRate?: number;
    shiftId?: string | null;
    confirm?: boolean;
    createdById?: string;
    hasScrap?: boolean;
    scrapKg?: number;
    scrapPieces?: number;
    scrapPriceKg?: number;
    scrapAmount?: number;
    lines: { productId: string; quantity: number; unitPrice: number; discount?: number }[];
  }) {
    await assertPeriodsOpen(this.prisma, data.invoiceDate || new Date());
    if (data.shiftId) await this.assertOpenShift(data.shiftId);
    const number = await this.sequence.next('sales', 'SAL');
    const parts = normalizeTenders(data.payments);
    const products = await this.prisma.product.findMany({
      where: { id: { in: data.lines.map((l) => l.productId) } },
    });
    const costOf = (productId: string) => products.find((p) => p.id === productId)?.costPrice || 0;
    const lines = data.lines.map((l) => ({
      ...l,
      discount: l.discount || 0,
      total: lineAmount(l.quantity, l.unitPrice, l.discount),
      unitCost: costOf(l.productId),
    }));
    const scrap = scrapFields(data);
    const subtotal = sumLineTotals(lines);
    const discount = data.discount || 0;
    const taxRate = data.taxRate ?? 0;
    const tax = data.taxRate != null ? taxFromPercent(subtotal, discount, taxRate) : (data.tax || 0);
    // الخردة اللي العميل بيسلّمها جزء من إيراد الفاتورة وربحها، مش مبلغ مطلوب منه
    const total = subtotal - discount + tax;
    const paidAmount = paidAmountOf(parts, data.paidAmount || 0);
    assertPaidFits(paidAmount, total, !!data.confirm, parts.length);
    const receiptNumbers: string[] = [];
    if (data.confirm) {
      for (let i = 0; i < parts.length; i++) receiptNumbers.push(await this.sequence.next('receipts', 'RCP'));
    }
    return this.prisma.$transaction(async (tx) => {
      let status: InvoiceStatus = InvoiceStatus.DRAFT;
      if (data.confirm) {
        status = statusFromPayment(total, paidAmount);
        for (const line of lines) {
          await postStockLine(tx, {
            warehouseId: data.warehouseId,
            productId: line.productId,
            quantity: line.quantity,
            unitCost: line.unitCost,
            type: StockMovementType.SALE,
            reference: number,
            direction: 'out',
          });
        }
        await tx.customer.update({
          where: { id: data.customerId },
          data: { balance: { increment: total - paidAmount } },
        });
      }

      const invoice = await tx.salesInvoice.create({
        data: {
          number,
          customerId: data.customerId,
          warehouseId: data.warehouseId,
          status,
          invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : new Date(),
          subtotal,
          discount,
          tax,
          taxRate,
          total,
          paidAmount,
          paymentMethod: parts.length === 1 ? parts[0].methodId : '',
          shiftId: data.shiftId || null,
          notes: data.notes,
          createdById: data.createdById,
          ...scrap,
          lines: { create: lines },
        },
        include: { customer: true, warehouse: true, lines: { include: { product: true } } },
      });

      if (data.confirm && parts.length) {
        await postCustomerTenders(tx, {
          parts,
          customerId: data.customerId,
          salesInvoiceId: invoice.id,
          invoiceNumber: number,
          shiftId: data.shiftId,
          createdById: data.createdById,
          receiptNumbers,
        });
      }

      return invoice;
    });
  }

  async confirm(id: string, payments?: TenderInput[]) {
    const inv = await this.findOne(id);
    if (inv.status !== InvoiceStatus.DRAFT) {
      throw new BadRequestException('الفاتورة ليست مسودة');
    }
    await assertPeriodsOpen(this.prisma, inv.invoiceDate);
    const parts = normalizeTenders(payments);
    const paidAmount = parts.length ? sumTenders(parts) : 0;
    if (paidAmount > inv.total + 0.009) throw new BadRequestException('المدفوع أكبر من إجمالي الفاتورة');
    const receiptNumbers: string[] = [];
    for (let i = 0; i < parts.length; i++) receiptNumbers.push(await this.sequence.next('receipts', 'RCP'));
    const result = await this.prisma.$transaction(async (tx) => {
      for (const line of inv.lines) {
        await postStockLine(tx, {
          warehouseId: inv.warehouseId,
          productId: line.productId,
          quantity: line.quantity,
          unitCost: line.unitCost || line.product.costPrice,
          type: StockMovementType.SALE,
          reference: inv.number,
          direction: 'out',
          productName: line.product.name,
        });
      }
      await tx.customer.update({
        where: { id: inv.customerId },
        data: { balance: { increment: inv.total - paidAmount } },
      });
      if (parts.length) {
        await postCustomerTenders(tx, {
          parts,
          customerId: inv.customerId,
          salesInvoiceId: inv.id,
          invoiceNumber: inv.number,
          shiftId: inv.shiftId,
          receiptNumbers,
        });
      }
      const status = statusFromPayment(inv.total, paidAmount);
      return tx.salesInvoice.update({
        where: { id },
        data: { status, paidAmount, paymentMethod: parts.length === 1 ? parts[0].methodId : '' },
        include: { customer: true, warehouse: true, lines: { include: { product: true } } },
      });
    });
    await recostProducts(this.prisma, inv.lines.map((l) => l.productId));
    await syncSaleOldBatteries(this.prisma, this.sequence, id);
    return result;
  }

  /** قبل الحفظ: كل بند هيتسحب من أنهي دفعات وتكلفته كام */
  async fifoPreview(query: { warehouseId: string; lines: string; excludeInvoiceId?: string }) {
    if (!query.warehouseId) return [];
    const lines = (query.lines || '')
      .split(',')
      .map((part) => {
        const [productId, qty] = part.split(':');
        return { productId, quantity: Number(qty) || 0 };
      })
      .filter((l) => l.productId);
    if (!lines.length) return [];
    const exclude = query.excludeInvoiceId
      ? await this.prisma.salesInvoice.findUnique({ where: { id: query.excludeInvoiceId }, select: { number: true, status: true } })
      : null;
    const rows = await previewFifo(this.prisma, {
      warehouseId: query.warehouseId,
      lines,
      excludeReference: exclude && exclude.status !== InvoiceStatus.DRAFT ? exclude.number : undefined,
    });
    const refs = [...new Set(rows.flatMap((r) => r.allocations.map((a) => a.reference)).filter((r): r is string => !!r))];
    const purchases = refs.length
      ? await this.prisma.purchaseInvoice.findMany({ where: { number: { in: refs } }, select: { number: true, supplier: { select: { name: true } } } })
      : [];
    const supplierOf = new Map(purchases.map((p) => [p.number, p.supplier.name]));
    return rows.map((row) => ({
      ...row,
      allocations: row.allocations.map((a) => ({ ...a, supplierName: a.reference ? supplierOf.get(a.reference) || null : null })),
    }));
  }

  /** من أنهي دفعة اتسحب كل بند في الفاتورة (FIFO) */
  async fifo(id: string) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: { lines: { orderBy: { id: 'asc' }, include: { product: true } } },
    });
    if (!inv) throw new NotFoundException('فاتورة البيع غير موجودة');
    const replay = await replayFifo(this.prisma, inv.lines.map((l) => l.productId));
    const outs = [...replay.values()].flatMap((row) => row.outs.filter((o) => o.reference === inv.number));
    const mapped = mapSaleLines(outs, inv.lines);
    const refs = [...new Set([...mapped.values()].flatMap((row) => row.allocations.map((a) => a.reference)).filter((r): r is string => !!r))];
    const purchases = refs.length
      ? await this.prisma.purchaseInvoice.findMany({ where: { number: { in: refs } }, select: { number: true, supplier: { select: { name: true } } } })
      : [];
    const supplierOf = new Map(purchases.map((p) => [p.number, p.supplier.name]));
    return {
      number: inv.number,
      lines: inv.lines.map((line) => {
        const row = mapped.get(line.id);
        return {
          lineId: line.id,
          productId: line.productId,
          sku: line.product.sku,
          name: line.product.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          total: line.total,
          unitCost: row?.unitCost ?? line.unitCost,
          allocations: (row?.allocations || []).map((a) => ({
            ...a,
            supplierName: a.reference ? supplierOf.get(a.reference) || null : null,
          })),
        };
      }),
    };
  }

  private async assertOpenShift(shiftId: string) {
    const shift = await this.prisma.cashierShift.findUnique({ where: { id: shiftId } });
    if (!shift || shift.status !== 'OPEN') {
      throw new BadRequestException('الوردية غير مفتوحة');
    }
  }

  async update(id: string, data: {
    customerId: string;
    warehouseId: string;
    invoiceDate?: string;
    discount?: number;
    taxRate?: number;
    notes?: string;
    paidAmount?: number;
    payments?: TenderInput[];
    confirm?: boolean;
    shiftId?: string | null;
    hasScrap?: boolean;
    scrapKg?: number;
    scrapPieces?: number;
    scrapPriceKg?: number;
    scrapAmount?: number;
    lines: { id?: string; productId: string; quantity: number; unitPrice: number; discount?: number }[];
  }) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: { lines: true, receipts: true, returns: true },
    });
    if (!inv) throw new NotFoundException('فاتورة البيع غير موجودة');
    await assertPeriodsOpen(this.prisma, inv.invoiceDate, data.invoiceDate);
    if (inv.returns.length) throw new BadRequestException('لا يمكن تعديل فاتورة عليها مرتجعات');
    if (!data.lines?.length) throw new BadRequestException('أضف بنوداً للفاتورة');
    if (data.shiftId) await this.assertOpenShift(data.shiftId);

    const products = await this.prisma.product.findMany({
      where: { id: { in: data.lines.map((l) => l.productId) } },
    });
    const costOf = (productId: string) => products.find((p) => p.id === productId)?.costPrice || 0;
    const lines = data.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      unitCost: costOf(l.productId),
      discount: l.discount || 0,
      total: l.quantity * l.unitPrice - (l.discount || 0),
    }));
    const scrap = scrapFields(data);
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const discount = data.discount || 0;
    const taxRate = data.taxRate ?? inv.taxRate ?? 0;
    const tax = Math.round((subtotal - discount) * taxRate * 100) / 10000;
    const total = subtotal - discount + tax;
    const parts = data.payments ? normalizeTenders(data.payments) : [];
    const paidAmount = data.payments ? sumTenders(parts) : (data.paidAmount ?? inv.paidAmount);
    if (paidAmount > total + 0.009) throw new BadRequestException('المدفوع أكبر من إجمالي الفاتورة');
    const alreadyPosted = inv.status !== InvoiceStatus.DRAFT;
    const posting = alreadyPosted || !!data.confirm;
    if (posting && paidAmount > 0 && !parts.length) throw new BadRequestException('قسّم المدفوع على طرق الدفع');
    const touched = [...inv.lines.map((l) => l.productId), ...lines.map((l) => l.productId)];
    if (alreadyPosted) {
      const revised = await this.revisePostedSale(id, inv, data, lines, parts, subtotal, discount, tax, taxRate, total, scrap);
      await recostProducts(this.prisma, touched);
      await syncSaleOldBatteries(this.prisma, this.sequence, id);
      return revised;
    }

    const receiptNumbers: string[] = [];
    if (posting) {
      for (let i = 0; i < parts.length; i++) receiptNumbers.push(await this.sequence.next('receipts', 'RCP'));
    }

    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });

      if (posting) {
        for (const line of lines) {
          const bal = await tx.stockBalance.findUnique({
            where: { warehouseId_productId: { warehouseId: data.warehouseId, productId: line.productId } },
          });
          if (!bal || bal.quantity < line.quantity) throw new BadRequestException('كمية غير كافية في المخزن');
          await tx.stockBalance.update({ where: { id: bal.id }, data: { quantity: { decrement: line.quantity } } });
          await tx.stockMovement.create({
            data: {
              warehouseId: data.warehouseId,
              productId: line.productId,
              type: StockMovementType.SALE,
              quantity: -line.quantity,
              unitCost: line.unitCost,
              reference: inv.number,
            },
          });
        }
        await tx.customer.update({
          where: { id: data.customerId },
          data: { balance: { increment: total - paidAmount } },
        });
        if (parts.length) {
          await postCustomerTenders(tx, {
            parts,
            customerId: data.customerId,
            salesInvoiceId: id,
            invoiceNumber: inv.number,
            shiftId: data.shiftId,
            receiptNumbers,
          });
        }
      }

      const status = !posting
        ? InvoiceStatus.DRAFT
        : paidAmount >= total
          ? InvoiceStatus.PAID
          : paidAmount > 0
            ? InvoiceStatus.PARTIAL
            : InvoiceStatus.CONFIRMED;

      return tx.salesInvoice.update({
        where: { id },
        data: {
          customerId: data.customerId,
          warehouseId: data.warehouseId,
          invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : inv.invoiceDate,
          subtotal,
          discount,
          tax,
          taxRate,
          total,
          paidAmount,
          paymentMethod: parts.length === 1 ? parts[0].methodId : (parts.length ? '' : inv.paymentMethod),
          shiftId: data.shiftId === undefined ? inv.shiftId : (data.shiftId || null),
          notes: data.notes,
          status,
          ...scrap,
          lines: { create: lines },
        },
        include: { customer: true, warehouse: true, lines: { include: { product: true } }, receipts: true },
      });
    });
    if (posting) await recostProducts(this.prisma, touched);
    await syncSaleOldBatteries(this.prisma, this.sequence, id);
    return saved;
  }

  private async revisePostedSale(
    id: string,
    inv: {
      number: string;
      customerId: string;
      warehouseId: string;
      total: number;
      paidAmount: number;
      invoiceDate: Date;
      shiftId: string | null;
      lines: { id: string; productId: string; quantity: number; unitCost: number }[];
      receipts: { id: string; number: string; amount: number; cashAccountId: string | null; paymentMethod: string; referenceNo: string | null }[];
    },
    data: { customerId: string; warehouseId: string; invoiceDate?: string; notes?: string; shiftId?: string | null },
    lines: { id?: string; productId: string; quantity: number; unitPrice: number; unitCost: number; discount: number; total: number }[],
    parts: TenderInput[],
    subtotal: number,
    discount: number,
    tax: number,
    taxRate: number,
    total: number,
    scrap: ReturnType<typeof scrapFields>,
  ) {
    const replacements = parts.filter((part) => {
      if (!part.id) return true;
      const row = inv.receipts.find((receipt) => receipt.id === part.id);
      return !row || row.paymentMethod !== part.methodId;
    }).length;
    const newNumbers: string[] = [];
    for (let i = 0; i < replacements; i++) newNumbers.push(await this.sequence.next('receipts', 'RCP'));

    return this.prisma.$transaction(async (tx) => {
      await this.applySaleStockDelta(tx, inv.warehouseId, data.warehouseId, inv.number, inv.lines, lines);
      const paidAmount = await syncSaleTenders(tx, {
        existing: inv.receipts,
        parts,
        customerId: data.customerId,
        salesInvoiceId: id,
        invoiceNumber: inv.number,
        shiftId: data.shiftId === undefined ? inv.shiftId : data.shiftId,
        newNumbers,
      });
      if (paidAmount > total + 0.009) throw new BadRequestException('المدفوع أكبر من إجمالي الفاتورة');
      const oldDue = inv.total - inv.paidAmount;
      const newDue = total - paidAmount;
      if (data.customerId === inv.customerId) {
        const delta = newDue - oldDue;
        if (Math.abs(delta) >= 0.009) {
          await tx.customer.update({ where: { id: inv.customerId }, data: { balance: { increment: delta } } });
        }
      } else {
        if (Math.abs(oldDue) >= 0.009) {
          await tx.customer.update({ where: { id: inv.customerId }, data: { balance: { decrement: oldDue } } });
        }
        if (Math.abs(newDue) >= 0.009) {
          await tx.customer.update({ where: { id: data.customerId }, data: { balance: { increment: newDue } } });
        }
      }
      const kept = new Set(lines.map((line) => line.id).filter((lineId): lineId is string => !!lineId));
      for (const old of inv.lines) {
        if (!kept.has(old.id)) await tx.salesInvoiceLine.delete({ where: { id: old.id } });
      }
      for (const line of lines) {
        const previous = line.id ? inv.lines.find((row) => row.id === line.id) : undefined;
        const unitCost = previous && previous.productId === line.productId ? previous.unitCost : line.unitCost;
        const row = {
          productId: line.productId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          unitCost,
          discount: line.discount,
          total: line.total,
        };
        if (previous) await tx.salesInvoiceLine.update({ where: { id: previous.id }, data: row });
        else await tx.salesInvoiceLine.create({ data: { invoiceId: id, ...row } });
      }
      const methods = await tx.receipt.findMany({ where: { salesInvoiceId: id }, select: { paymentMethod: true } });
      const status = paidAmount >= total - 0.009
        ? InvoiceStatus.PAID
        : paidAmount > 0
          ? InvoiceStatus.PARTIAL
          : InvoiceStatus.CONFIRMED;
      return tx.salesInvoice.update({
        where: { id },
        data: {
          customerId: data.customerId,
          warehouseId: data.warehouseId,
          invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : inv.invoiceDate,
          subtotal,
          discount,
          tax,
          taxRate,
          total,
          paidAmount,
          paymentMethod: methods.length === 1 ? methods[0].paymentMethod : '',
          shiftId: data.shiftId === undefined ? inv.shiftId : (data.shiftId || null),
          notes: data.notes,
          status,
          ...scrap,
        },
        include: { customer: true, warehouse: true, lines: { include: { product: true } }, receipts: true },
      });
    });
  }

  private async applySaleStockDelta(
    tx: Prisma.TransactionClient,
    oldWarehouse: string,
    newWarehouse: string,
    reference: string,
    oldLines: { productId: string; quantity: number; unitCost: number }[],
    newLines: { productId: string; quantity: number; unitCost: number }[],
  ) {
    // صافي التغيير لكل (مخزن، صنف): الكمية المرتجعة للمخزن القديم − المسحوبة من الجديد
    const delta = new Map<string, number>();
    const bump = (wh: string, productId: string, qty: number) => {
      const key = `${wh}|${productId}`;
      delta.set(key, (delta.get(key) || 0) + qty);
    };
    for (const line of oldLines) bump(oldWarehouse, line.productId, line.quantity);
    for (const line of newLines) bump(newWarehouse, line.productId, -line.quantity);
    for (const [key, qty] of delta) {
      if (Math.abs(qty) < 0.0001) continue;
      const [warehouseId, productId] = key.split('|');
      if (qty < 0) {
        const bal = await tx.stockBalance.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });
        if (!bal || bal.quantity < -qty - 0.0001) throw new BadRequestException('كمية غير كافية في المخزن');
        await tx.stockBalance.update({ where: { id: bal.id }, data: { quantity: { increment: qty } } });
      } else {
        await tx.stockBalance.upsert({
          where: { warehouseId_productId: { warehouseId, productId } },
          create: { warehouseId, productId, quantity: qty },
          update: { quantity: { increment: qty } },
        });
      }
    }
    // نعيد كتابة حركات البيع بنفس وقت الترحيل الأصلي عشان ترتيب FIFO يفضل صح
    const first = await tx.stockMovement.findFirst({
      where: { reference, type: StockMovementType.SALE },
      orderBy: { createdAt: 'asc' },
    });
    const postedAt = first?.createdAt || new Date();
    await tx.stockMovement.deleteMany({
      where: { reference, type: { in: [StockMovementType.SALE, StockMovementType.ADJUSTMENT] } },
    });
    for (const line of newLines) {
      await tx.stockMovement.create({
        data: {
          warehouseId: newWarehouse,
          productId: line.productId,
          type: StockMovementType.SALE,
          quantity: -line.quantity,
          unitCost: line.unitCost,
          reference,
          createdAt: postedAt,
        },
      });
    }
  }

  async remove(id: string) {
    const inv = await this.prisma.salesInvoice.findUnique({
      where: { id },
      include: { lines: true, receipts: true, returns: true },
    });
    if (!inv) throw new NotFoundException('فاتورة البيع غير موجودة');
    await assertPeriodsOpen(this.prisma, inv.invoiceDate);
    if (inv.returns.length) {
      throw new BadRequestException('لا يمكن حذف فاتورة عليها مرتجعات');
    }

    await this.prisma.oldBattery.deleteMany({ where: { salesInvoiceId: id, decision: 'PENDING' } });
    const removed = await this.prisma.$transaction(async (tx) => {
      if (inv.status !== InvoiceStatus.DRAFT) {
        for (const line of inv.lines) {
          await tx.stockBalance.upsert({
            where: {
              warehouseId_productId: {
                warehouseId: inv.warehouseId,
                productId: line.productId,
              },
            },
            create: {
              warehouseId: inv.warehouseId,
              productId: line.productId,
              quantity: line.quantity,
            },
            update: { quantity: { increment: line.quantity } },
          });
        }
        await tx.stockMovement.deleteMany({
          where: {
            reference: inv.number,
            type: { in: [StockMovementType.SALE, StockMovementType.ADJUSTMENT] },
          },
        });
        const due = inv.total - inv.paidAmount;
        if (due !== 0) {
          await tx.customer.update({
            where: { id: inv.customerId },
            data: { balance: { decrement: due } },
          });
        }
        await reverseSaleMoney(tx, id, inv.receipts);
      } else {
        await tx.receipt.deleteMany({ where: { salesInvoiceId: id } });
      }
      await tx.salesInvoice.delete({ where: { id } });
      return { ok: true };
    });
    if (inv.status !== InvoiceStatus.DRAFT) await recostProducts(this.prisma, inv.lines.map((l) => l.productId));
    return removed;
  }
}
