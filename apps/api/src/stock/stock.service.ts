import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InvoiceStatus, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';
import { assertPeriodsOpen } from '../settings/period-lock';
import { pageResult, readPage } from '../common/paging';
import { FifoLayer, recostAll, recostProducts, replayFifo } from '../common/fifo';
const CONFIRMED: InvoiceStatus[] = [
  InvoiceStatus.CONFIRMED,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.PAID,
];

const FIFO_VERSION = '1';

@Injectable()
export class StockService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
  ) {}

  async onModuleInit() {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: 'fifo_version' } });
      if (row?.value === FIFO_VERSION) return;
      await recostAll(this.prisma);
      await this.prisma.setting.upsert({
        where: { key: 'fifo_version' },
        create: { key: 'fifo_version', value: FIFO_VERSION },
        update: { value: FIFO_VERSION },
      });
    } catch (error) {
      console.error('FIFO initial recost failed', error);
    }
  }

  balances(warehouseId?: string, search?: string, warehouseIds?: string[] | null) {
    const scopeIds = warehouseId ? [warehouseId] : warehouseIds || undefined;
    return this.prisma.stockBalance.findMany({
      where: {
        ...(scopeIds?.length ? { warehouseId: { in: scopeIds } } : {}),
        ...(search
          ? {
              OR: [
                { product: { name: { contains: search } } },
                { product: { sku: { contains: search } } },
                { warehouse: { name: { contains: search } } },
              ],
            }
          : {}),
      },
      include: {
        product: {
          include: { fieldValues: { include: { field: true } } },
        },
        warehouse: true,
      },
      orderBy: [{ warehouse: { name: 'asc' } }, { product: { name: 'asc' } }],
    });
  }

  /** بحث في كل المخازن لتوجيه العميل — عرض فقط */
  async lookup(search: string) {
    const q = search.trim();
    if (q.length < 1) return [];
    const rows = await this.prisma.stockBalance.findMany({
      where: {
        quantity: { gt: 0 },
        OR: [
          { product: { name: { contains: q } } },
          { product: { sku: { contains: q } } },
          { product: { barcode: { contains: q } } },
        ],
      },
      include: { product: true, warehouse: true },
      orderBy: [{ product: { name: 'asc' } }, { warehouse: { name: 'asc' } }],
      take: 40,
    });
    return rows.map((row) => ({
      productId: row.productId,
      warehouseId: row.warehouseId,
      quantity: row.quantity,
      sku: row.product.sku,
      name: row.product.name,
      warehouseName: row.warehouse.name,
    }));
  }

  /** أرصدة مع تكلفة وتفاصيل دفعات الشراء */
  async valuation(warehouseId?: string, search?: string, warehouseIds?: string[] | null) {
    const balances = await this.balances(warehouseId, search, warehouseIds);

    const productIds = [...new Set(balances.map((b) => b.productId))];
    const purchaseLines = productIds.length
      ? await this.prisma.purchaseInvoiceLine.findMany({
          where: {
            productId: { in: productIds },
            invoice: {
              status: { in: CONFIRMED },
              ...(warehouseId ? { warehouseId } : {}),
            },
          },
          include: {
            invoice: {
              include: { supplier: true, warehouse: true },
            },
          },
          orderBy: { invoice: { invoiceDate: 'desc' } },
        })
      : [];

    const batchesByKey = new Map<string, typeof purchaseLines>();
    for (const line of purchaseLines) {
      const key = `${line.productId}:${line.invoice.warehouseId}`;
      const list = batchesByKey.get(key) || [];
      list.push(line);
      batchesByKey.set(key, list);
    }

    const replay = await replayFifo(this.prisma, productIds);

    const items = balances.map((b) => {
      const open = (replay.get(b.productId)?.layers || [])
        .filter((l) => l.warehouseId === b.warehouseId && l.remaining > 0.0001);
      const fifoQty = open.reduce((s, l) => s + l.remaining, 0);
      const fifoValue = open.reduce((s, l) => s + l.remaining * l.unitCost, 0);
      const uncovered = Math.max(0, b.quantity - fifoQty);
      const totalCost = Math.round((fifoValue + uncovered * (b.product.costPrice || 0)) * 100) / 100;
      const unitCost = b.quantity > 0.0001
        ? Math.round((totalCost / b.quantity) * 10000) / 10000
        : (b.product.costPrice || 0);
      const rawBatches = batchesByKey.get(`${b.productId}:${b.warehouseId}`) || [];

      return {
        id: b.id,
        warehouseId: b.warehouseId,
        productId: b.productId,
        quantity: b.quantity,
        unitCost,
        totalCost,
        openLayers: open.length,
        nextCost: open[0]?.unitCost ?? null,
        product: b.product,
        warehouse: b.warehouse,
        batches: rawBatches.map((l) => ({
          id: l.id,
          invoiceId: l.invoiceId,
          invoiceNumber: l.invoice.number,
          invoiceDate: l.invoice.invoiceDate,
          supplierName: l.invoice.supplier.name,
          warehouseName: l.invoice.warehouse.name,
          quantity: l.quantity,
          unitCost: l.unitCost,
          total: l.total,
          batchNumber: l.batchNumber,
          expiryDate: l.expiryDate,
          discount: l.discount,
        })),
      };
    });

    const grandTotal = Math.round(items.reduce((s, i) => s + i.totalCost, 0) * 100) / 100;
    const totalQty = items.reduce((s, i) => s + i.quantity, 0);

    return { items, grandTotal, totalQty, count: items.length };
  }

  /** دفعات FIFO لصنف في مخزن: كل دفعة دخلت بكام، فاضل منها كام، واتسحب منها فين */
  async fifoDetail(productId: string, warehouseId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true, sku: true, name: true, unit: true, costPrice: true } });
    if (!product) throw new NotFoundException('الصنف غير موجود');
    const replay = await replayFifo(this.prisma, [productId]);
    const res = replay.get(productId);
    const layers = (res?.layers || [])
      .filter((l) => l.warehouseId === warehouseId)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const fallbackOuts = (res?.outs || [])
      .filter((o) => o.warehouseId === warehouseId)
      .flatMap((o) => o.allocations.filter((a) => a.fallback).map((a) => ({ reference: o.reference, type: o.type, date: o.createdAt, quantity: a.quantity, unitCost: a.unitCost })));

    const refs = new Set<string>();
    const add = (ref?: string | null) => { if (ref) refs.add(ref); };
    layers.forEach((l) => { add(l.reference); add(l.viaTransfer); l.consumed.forEach((c) => add(c.reference)); });
    fallbackOuts.forEach((o) => add(o.reference));
    const list = [...refs];
    const [purchases, sales, purchaseReturns, salesReturns, transfers] = list.length
      ? await Promise.all([
          this.prisma.purchaseInvoice.findMany({ where: { number: { in: list } }, select: { id: true, number: true, invoiceDate: true, supplier: { select: { name: true } } } }),
          this.prisma.salesInvoice.findMany({ where: { number: { in: list } }, select: { id: true, number: true, invoiceDate: true, customer: { select: { name: true } } } }),
          this.prisma.purchaseReturn.findMany({ where: { number: { in: list } }, select: { number: true, supplier: { select: { name: true } } } }),
          this.prisma.salesReturn.findMany({ where: { number: { in: list } }, select: { number: true, customerName: true, customer: { select: { name: true } } } }),
          this.prisma.stockTransfer.findMany({ where: { number: { in: list } }, select: { number: true, fromWarehouse: { select: { name: true } }, toWarehouse: { select: { name: true } } } }),
        ])
      : [[], [], [], [], []];
    const party = new Map<string, string>();
    purchases.forEach((p) => party.set(p.number, p.supplier.name));
    sales.forEach((s) => party.set(s.number, s.customer.name));
    purchaseReturns.forEach((r) => party.set(r.number, r.supplier.name));
    salesReturns.forEach((r) => party.set(r.number, r.customer?.name || r.customerName || 'مرتجع بيع'));
    transfers.forEach((t) => party.set(t.number, `${t.fromWarehouse.name} ← ${t.toWarehouse.name}`));
    const docId = new Map<string, { kind: 'purchase' | 'sale'; id: string }>();
    purchases.forEach((p) => docId.set(p.number, { kind: 'purchase', id: p.id }));
    sales.forEach((s) => docId.set(s.number, { kind: 'sale', id: s.id }));

    const shape = (l: FifoLayer) => ({
      key: l.key,
      type: l.type,
      reference: l.reference,
      viaTransfer: l.viaTransfer,
      partyName: (l.reference && party.get(l.reference)) || null,
      doc: (l.reference && docId.get(l.reference)) || null,
      note: l.note,
      date: l.date.getTime() === 0 ? null : l.date,
      unitCost: l.unitCost,
      quantity: l.quantity,
      remaining: l.remaining,
      used: Math.round((l.quantity - l.remaining) * 10000) / 10000,
      consumed: l.consumed.map((c) => ({
        ...c,
        partyName: (c.reference && party.get(c.reference)) || null,
        doc: (c.reference && docId.get(c.reference)) || null,
      })),
    });

    const open = layers.filter((l) => l.remaining > 0.0001);
    const qty = open.reduce((s, l) => s + l.remaining, 0);
    const value = open.reduce((s, l) => s + l.remaining * l.unitCost, 0);
    return {
      product,
      warehouseId,
      remainingQty: Math.round(qty * 10000) / 10000,
      remainingValue: Math.round(value * 100) / 100,
      avgCost: qty > 0.0001 ? Math.round((value / qty) * 10000) / 10000 : 0,
      nextCost: open[0]?.unitCost ?? null,
      layers: layers.map(shape),
      fallbackOuts: fallbackOuts.map((o) => ({ ...o, partyName: (o.reference && party.get(o.reference)) || null })),
    };
  }

  recostAll() {
    return recostAll(this.prisma);
  }

  async movements(params?: {
    warehouseId?: string;
    productId?: string;
    search?: string;
    limit?: number;
    page?: string;
    pageSize?: string;
    warehouseIds?: string[] | null;
  }) {
    const page = readPage(params);
    const scopeIds = params?.warehouseId
      ? [params.warehouseId]
      : params?.warehouseIds?.length
        ? params.warehouseIds
        : undefined;
    const where = {
      ...(scopeIds?.length ? { warehouseId: { in: scopeIds } } : {}),
      productId: params?.productId || undefined,
      ...(params?.search
        ? {
            OR: [
              { product: { name: { contains: params.search } } },
              { product: { sku: { contains: params.search } } },
              { reference: { contains: params.search } },
              { note: { contains: params.search } },
            ],
          }
        : {}),
    };
    if (!page) {
      return this.prisma.stockMovement.findMany({
        where,
        include: { product: true, warehouse: true },
        orderBy: { createdAt: 'desc' },
        take: params?.limit || 200,
      });
    }
    const [total, items] = await Promise.all([
      this.prisma.stockMovement.count({ where }),
      this.prisma.stockMovement.findMany({
        where,
        include: { product: true, warehouse: true },
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
    ]);
    return pageResult(items, total, page);
  }

  async updateMovement(
    id: string,
    data: { quantity?: number; unitCost?: number; note?: string; reference?: string },
  ) {
    const mov = await this.prisma.stockMovement.findUnique({ where: { id } });
    if (!mov) throw new NotFoundException('الحركة غير موجودة');
    await assertPeriodsOpen(this.prisma, mov.createdAt);

    return this.withRecost([mov.productId], this.prisma.$transaction(async (tx) => {
      if (data.quantity !== undefined && data.quantity !== mov.quantity) {
        const delta = data.quantity - mov.quantity;
        const bal = await tx.stockBalance.findUnique({
          where: {
            warehouseId_productId: {
              warehouseId: mov.warehouseId,
              productId: mov.productId,
            },
          },
        });
        if (!bal) throw new BadRequestException('لا يوجد رصيد لهذا الصنف');
        const nextQty = bal.quantity + delta;
        if (nextQty < 0) throw new BadRequestException('الكمية الناتجة سالبة');
        await tx.stockBalance.update({
          where: { id: bal.id },
          data: { quantity: nextQty },
        });
      }

      return tx.stockMovement.update({
        where: { id },
        data: {
          ...(data.quantity !== undefined ? { quantity: data.quantity } : {}),
          ...(data.unitCost !== undefined ? { unitCost: data.unitCost } : {}),
          ...(data.note !== undefined ? { note: data.note } : {}),
          ...(data.reference !== undefined ? { reference: data.reference } : {}),
        },
        include: { product: true, warehouse: true },
      });
    }));
  }

  private async withRecost<T>(productIds: string[], work: Promise<T>) {
    const result = await work;
    await recostProducts(this.prisma, productIds);
    return result;
  }

  async deleteMovement(id: string) {
    const mov = await this.prisma.stockMovement.findUnique({ where: { id } });
    if (!mov) throw new NotFoundException('الحركة غير موجودة');
    await assertPeriodsOpen(this.prisma, mov.createdAt);

    return this.withRecost([mov.productId], this.prisma.$transaction(async (tx) => {
      const bal = await tx.stockBalance.findUnique({
        where: {
          warehouseId_productId: {
            warehouseId: mov.warehouseId,
            productId: mov.productId,
          },
        },
      });
      if (bal) {
        const nextQty = bal.quantity - mov.quantity;
        if (nextQty < 0) {
          throw new BadRequestException('لا يمكن حذف الحركة لأن الرصيد سيصبح سالباً');
        }
        await tx.stockBalance.update({
          where: { id: bal.id },
          data: { quantity: nextQty },
        });
      }
      return tx.stockMovement.delete({ where: { id } });
    }));
  }

  /** تعديل بيانات دفعة شراء (تشغيلة / صلاحية / تكلفة البند) */
  async updatePurchaseBatch(
    lineId: string,
    data: { batchNumber?: string; expiryDate?: string | null; unitCost?: number; note?: string },
  ) {
    const line = await this.prisma.purchaseInvoiceLine.findUnique({
      where: { id: lineId },
      include: { invoice: true },
    });
    if (!line) throw new NotFoundException('دفعة الشراء غير موجودة');
    await assertPeriodsOpen(this.prisma, line.invoice.invoiceDate);

    const unitCost = data.unitCost !== undefined ? data.unitCost : line.unitCost;
    const total = line.quantity * unitCost - line.discount;

    let expiryUpdate: Date | null | undefined = undefined;
    if (data.expiryDate !== undefined) {
      expiryUpdate = data.expiryDate ? new Date(data.expiryDate) : null;
    }

    const updated = await this.prisma.purchaseInvoiceLine.update({
      where: { id: lineId },
      data: {
        unitCost,
        total,
        batchNumber: data.batchNumber !== undefined ? (data.batchNumber.trim() || null) : undefined,
        ...(expiryUpdate !== undefined ? { expiryDate: expiryUpdate } : {}),
      },
      include: {
        invoice: { include: { supplier: true, warehouse: true } },
        product: true,
      },
    });

    // تحديث ملاحظة حركة المخزون المرتبطة بنفس الفاتورة والصنف إن وجدت
    const movements = await this.prisma.stockMovement.findMany({
      where: {
        productId: line.productId,
        warehouseId: line.invoice.warehouseId,
        type: StockMovementType.PURCHASE,
        reference: line.invoice.number,
      },
    });
    for (const m of movements) {
      const batch = updated.batchNumber;
      const exp = updated.expiryDate
        ? updated.expiryDate.toISOString().slice(0, 10)
        : null;
      await this.prisma.stockMovement.update({
        where: { id: m.id },
        data: {
          unitCost,
          note: [batch && `تشغيلة: ${batch}`, exp && `صلاحية: ${exp}`].filter(Boolean).join(' | ') || null,
        },
      });
    }

    // تحديث تكلفة الصنف من آخر شراء
    await this.prisma.product.update({
      where: { id: line.productId },
      data: { costPrice: unitCost },
    });

    await recostProducts(this.prisma, [line.productId]);
    return updated;
  }

  async deletePurchaseBatch(lineId: string) {
    const line = await this.prisma.purchaseInvoiceLine.findUnique({
      where: { id: lineId },
      include: { invoice: { include: { lines: true } } },
    });
    if (!line) throw new NotFoundException('دفعة الشراء غير موجودة');
    await assertPeriodsOpen(this.prisma, line.invoice.invoiceDate);
    if (line.invoice.lines.length <= 1) {
      throw new BadRequestException('لا يمكن حذف البند الوحيد في الفاتورة — احذف الفاتورة من المشتريات');
    }

    return this.withRecost([line.productId], this.prisma.$transaction(async (tx) => {
      const bal = await tx.stockBalance.findUnique({
        where: {
          warehouseId_productId: {
            warehouseId: line.invoice.warehouseId,
            productId: line.productId,
          },
        },
      });
      if (bal) {
        if (bal.quantity < line.quantity) {
          throw new BadRequestException('الكمية الحالية أقل من كمية الدفعة');
        }
        await tx.stockBalance.update({
          where: { id: bal.id },
          data: { quantity: { decrement: line.quantity } },
        });
      }

      // نشيل حركة استلام الدفعة نفسها (مش نسحب من أقدم دفعة)
      const own = await tx.stockMovement.findFirst({
        where: {
          reference: line.invoice.number,
          productId: line.productId,
          type: StockMovementType.PURCHASE,
          quantity: line.quantity,
        },
      });
      if (own) {
        await tx.stockMovement.delete({ where: { id: own.id } });
      } else {
        await tx.stockMovement.create({
          data: {
            warehouseId: line.invoice.warehouseId,
            productId: line.productId,
            type: StockMovementType.ADJUSTMENT,
            quantity: -line.quantity,
            unitCost: line.unitCost,
            reference: line.invoice.number,
            note: `حذف دفعة شراء${line.batchNumber ? ` (${line.batchNumber})` : ''}`,
          },
        });
      }

      await tx.purchaseInvoiceLine.delete({ where: { id: lineId } });

      const remaining = await tx.purchaseInvoiceLine.findMany({
        where: { invoiceId: line.invoiceId },
      });
      const subtotal = remaining.reduce((s, l) => s + l.total, 0);
      const total = subtotal - line.invoice.discount + line.invoice.tax - (line.invoice.scrapAmount || 0);
      await tx.purchaseInvoice.update({
        where: { id: line.invoiceId },
        data: { subtotal, total },
      });

      return { ok: true };
    }));
  }

  lowStock() {
    return this.prisma.$queryRawUnsafe<
      { id: string; sku: string; name: string; minStock: number; quantity: number; warehouseName: string }[]
    >(`
      SELECT p.id, p.sku, p.name, p.minStock, sb.quantity, w.name as warehouseName
      FROM StockBalance sb
      JOIN Product p ON p.id = sb.productId
      JOIN Warehouse w ON w.id = sb.warehouseId
      WHERE p.minStock > 0 AND sb.quantity <= p.minStock AND p.isActive = 1
      ORDER BY sb.quantity ASC
    `);
  }

  async transfer(data: {
    fromWarehouseId: string;
    toWarehouseId: string;
    note?: string;
    lines: { productId: string; quantity: number }[];
  }) {
    if (data.fromWarehouseId === data.toWarehouseId) {
      throw new BadRequestException('المخزن المصدر والهدف يجب أن يختلفا');
    }
    if (!data.lines.length) throw new BadRequestException('أضف أصنافاً للتحويل');
    await assertPeriodsOpen(this.prisma, new Date());

    const number = await this.sequence.next('stock_transfer', 'TR');
    return this.withRecost(data.lines.map((l) => l.productId), this.prisma.$transaction(async (tx) => {
      for (const line of data.lines) {
        const bal = await tx.stockBalance.findUnique({
          where: {
            warehouseId_productId: {
              warehouseId: data.fromWarehouseId,
              productId: line.productId,
            },
          },
        });
        if (!bal || bal.quantity < line.quantity) {
          throw new BadRequestException('كمية غير كافية للتحويل');
        }
        await tx.stockBalance.update({
          where: { id: bal.id },
          data: { quantity: { decrement: line.quantity } },
        });
        await tx.stockBalance.upsert({
          where: {
            warehouseId_productId: {
              warehouseId: data.toWarehouseId,
              productId: line.productId,
            },
          },
          create: {
            warehouseId: data.toWarehouseId,
            productId: line.productId,
            quantity: line.quantity,
          },
          update: { quantity: { increment: line.quantity } },
        });
        await tx.stockMovement.createMany({
          data: [
            {
              warehouseId: data.fromWarehouseId,
              productId: line.productId,
              type: StockMovementType.TRANSFER_OUT,
              quantity: -line.quantity,
              reference: number,
            },
            {
              warehouseId: data.toWarehouseId,
              productId: line.productId,
              type: StockMovementType.TRANSFER_IN,
              quantity: line.quantity,
              reference: number,
            },
          ],
        });
      }
      return tx.stockTransfer.create({
        data: {
          number,
          fromWarehouseId: data.fromWarehouseId,
          toWarehouseId: data.toWarehouseId,
          note: data.note,
          lines: { create: data.lines },
        },
        include: {
          lines: { include: { product: true } },
          fromWarehouse: true,
          toWarehouse: true,
        },
      });
    }));
  }

  listTransfers() {
    return this.prisma.stockTransfer.findMany({
      include: {
        fromWarehouse: true,
        toWarehouse: true,
        lines: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adjust(data: {
    warehouseId: string;
    note?: string;
    mode: 'set' | 'delta';
    lines: { productId: string; quantity: number; unitCost?: number }[];
  }) {
    if (!data.lines?.length) throw new BadRequestException('أضف أصنافاً');
    await assertPeriodsOpen(this.prisma, new Date());
    return this.withRecost(data.lines.map((l) => l.productId), this.prisma.$transaction(async (tx) => {
      let count = 0;
      for (const line of data.lines) {
        const bal = await tx.stockBalance.findUnique({
          where: { warehouseId_productId: { warehouseId: data.warehouseId, productId: line.productId } },
        });
        const current = bal?.quantity || 0;
        const delta = data.mode === 'set' ? line.quantity - current : line.quantity;
        const next = current + delta;
        if (next < -0.0001) throw new BadRequestException('التسوية تجعل الرصيد سالباً');
        if (!bal) {
          await tx.stockBalance.create({
            data: { warehouseId: data.warehouseId, productId: line.productId, quantity: Math.max(0, next) },
          });
        } else {
          await tx.stockBalance.update({ where: { id: bal.id }, data: { quantity: next } });
        }
        if (Math.abs(delta) > 0.0001) {
          const product = await tx.product.findUnique({ where: { id: line.productId } });
          const unitCost = line.unitCost !== undefined && line.unitCost !== null
            ? Math.max(0, line.unitCost)
            : (product?.costPrice || 0);
          await tx.stockMovement.create({
            data: {
              warehouseId: data.warehouseId,
              productId: line.productId,
              type: StockMovementType.ADJUSTMENT,
              quantity: delta,
              unitCost,
              note: data.note || (data.mode === 'set' ? 'جرد / رصيد افتتاحي' : 'تسوية'),
            },
          });
          if (line.unitCost !== undefined && line.unitCost !== null && line.unitCost >= 0) {
            await tx.product.update({
              where: { id: line.productId },
              data: { costPrice: unitCost },
            });
          }
          count += 1;
        }
      }
      return { ok: true, count };
    }));
  }

  async expiring(days = 30) {
    const until = new Date();
    until.setDate(until.getDate() + days);
    const lines = await this.prisma.purchaseInvoiceLine.findMany({
      where: {
        expiryDate: { not: null, lte: until },
        invoice: { status: { in: CONFIRMED } },
      },
      include: { product: true, invoice: { include: { supplier: true, warehouse: true } } },
      orderBy: { expiryDate: 'asc' },
    });
    const now = new Date();
    return lines.map((line) => ({
      lineId: line.id,
      productId: line.productId,
      sku: line.product.sku,
      name: line.product.name,
      quantity: line.quantity,
      batchNumber: line.batchNumber,
      expiryDate: line.expiryDate,
      warehouseName: line.invoice.warehouse.name,
      supplierName: line.invoice.supplier.name,
      invoiceNumber: line.invoice.number,
      expired: !!line.expiryDate && line.expiryDate < now,
    }));
  }

  listLocations(warehouseId: string) {
    return this.prisma.warehouseLocation.findMany({
      where: { warehouseId },
      orderBy: { code: 'asc' },
    });
  }

  createLocation(data: { warehouseId: string; code: string; name: string }) {
    return this.prisma.warehouseLocation.create({ data });
  }

  async removeLocation(id: string) {
    await this.prisma.productLocation.deleteMany({ where: { locationId: id } });
    return this.prisma.warehouseLocation.delete({ where: { id } });
  }

  assignLocation(data: { productId: string; warehouseId: string; locationId: string }) {
    return this.prisma.productLocation.upsert({
      where: { productId_warehouseId: { productId: data.productId, warehouseId: data.warehouseId } },
      create: data,
      update: { locationId: data.locationId },
      include: { location: true, product: true },
    });
  }

  listProductLocations(warehouseId?: string) {
    return this.prisma.productLocation.findMany({
      where: warehouseId ? { warehouseId } : undefined,
      include: { product: true, location: true, warehouse: true },
      orderBy: { product: { name: 'asc' } },
    });
  }
}
