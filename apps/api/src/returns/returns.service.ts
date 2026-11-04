import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { CashDirection, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';
import { assertPeriodsOpen } from '../settings/period-lock';
import { pageResult, readPage } from '../common/paging';
import { RETURNS_WAREHOUSE_CODE, RETURNS_WAREHOUSE_NAME } from '../common/returns-warehouse';
import { recostProducts } from '../common/fifo';
import { syncSalesReturnOldBatteries } from '../oldbatteries/oldbatteries.service';

function sliceCost(
  lines: { productId: string; quantity: number; unitCost: number }[],
  productId: string,
  skip: number,
  quantity: number,
) {
  let leftSkip = skip;
  let left = quantity;
  let costSum = 0;
  let taken = 0;
  for (const line of lines) {
    if (line.productId !== productId) continue;
    let available = line.quantity;
    if (leftSkip > 0) {
      const used = Math.min(leftSkip, available);
      leftSkip -= used;
      available -= used;
    }
    if (available <= 0) continue;
    const take = Math.min(available, left);
    costSum += take * (line.unitCost || 0);
    taken += take;
    left -= take;
    if (left <= 0.0001) break;
  }
  if (taken <= 0.0001 || costSum <= 0) return null;
  return Math.round((costSum / taken) * 10000) / 10000;
}

type SalesReturnPayload = {
  customerName?: string;
  productId?: string;
  scrapKg?: number;
  scrapPieces?: number;
  consumptionAmount?: number;
  cashAccountId?: string;
  giveReplacement?: boolean;
  replacementProductId?: string;
  replacementWarehouseId?: string;
  replacementQty?: number;
  notes?: string;
};

type PurchaseReturnLineInput = { productId: string; quantity: number; unitCost: number };
type PurchaseReturnFeeInput = { consumptionFee?: number; feeSettlement?: string; methodId?: string };

@Injectable()
export class ReturnsService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
  ) {}

  async onModuleInit() {
    const returnsWh = await this.ensureReturnsWarehouse();
    const stocked = await this.prisma.stockBalance.findMany({
      where: { warehouseId: returnsWh.id, quantity: { gt: 0 } },
      select: { productId: true },
    });
    for (const row of stocked) {
      await this.prisma.productWarehouse.upsert({
        where: { productId_warehouseId: { productId: row.productId, warehouseId: returnsWh.id } },
        create: { productId: row.productId, warehouseId: returnsWh.id },
        update: {},
      });
    }
    const pending = await this.prisma.salesReturnLine.findFirst({
      where: { OR: [{ unitCost: null }, { unitCost: 0 }], salesReturn: { salesInvoiceId: { not: null } } },
      select: { id: true },
    });
    if (!pending) return;
    const returns = await this.prisma.salesReturn.findMany({
      where: { salesInvoiceId: { not: null } },
      include: { lines: true, salesInvoice: { include: { lines: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const products = await this.prisma.product.findMany({
      where: { id: { in: [...new Set(returns.flatMap((row) => row.lines.map((line) => line.productId)))] } },
      select: { id: true, costPrice: true },
    });
    const currentCost = new Map(products.map((product) => [product.id, product.costPrice || 0]));
    const skip = new Map<string, number>();
    for (const row of returns) {
      for (const line of row.lines) {
        const key = `${row.salesInvoiceId}:${line.productId}`;
        const computed = sliceCost(row.salesInvoice?.lines || [], line.productId, skip.get(key) || 0, line.quantity) ?? currentCost.get(line.productId) ?? 0;
        const unitCost = line.unitCost && line.unitCost > 0 ? line.unitCost : computed;
        skip.set(key, (skip.get(key) || 0) + line.quantity);
        if (line.unitCost === unitCost) continue;
        await this.prisma.salesReturnLine.update({ where: { id: line.id }, data: { unitCost } });
        await this.prisma.stockMovement.updateMany({
          where: { reference: row.number, productId: line.productId, type: StockMovementType.SALE_RETURN },
          data: { unitCost },
        });
      }
    }
  }

  async ensureReturnsWarehouse() {
    return this.prisma.warehouse.upsert({
      where: { code: RETURNS_WAREHOUSE_CODE },
      create: {
        code: RETURNS_WAREHOUSE_CODE,
        name: RETURNS_WAREHOUSE_NAME,
        description: 'مخزن ثابت لاستلام مرتجعات البيع',
      },
      update: { name: RETURNS_WAREHOUSE_NAME, isActive: true },
    });
  }

  private salesInclude() {
    return {
      customer: true,
      warehouse: true,
      salesInvoice: true,
      cashAccount: true,
      replacementProduct: true,
      replacementWarehouse: true,
      lines: { include: { product: true } },
    } as const;
  }

  private purchaseInclude() {
    return {
      supplier: true,
      warehouse: true,
      purchaseInvoice: true,
      lines: { include: { product: true } },
    } as const;
  }

  async listSalesReturns(query?: { page?: string; pageSize?: string; q?: string }) {
    const page = readPage(query);
    const where = query?.q
      ? {
          OR: [
            { number: { contains: query.q } },
            { customerName: { contains: query.q } },
            { warehouse: { name: { contains: query.q } } },
            { notes: { contains: query.q } },
            { lines: { some: { product: { name: { contains: query.q } } } } },
          ],
        }
      : undefined;
    const include = this.salesInclude();
    if (!page) return this.prisma.salesReturn.findMany({ where, include, orderBy: { createdAt: 'desc' } });
    const monthKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    const [total, items, all] = await Promise.all([
      this.prisma.salesReturn.count({ where }),
      this.prisma.salesReturn.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.take }),
      this.prisma.salesReturn.findMany({ select: { total: true, returnDate: true, consumptionAmount: true } }),
    ]);
    const month = all.filter((row) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit' }).format(row.returnDate).slice(0, 7) === monthKey);
    const amountOf = (row: { total: number; consumptionAmount: number }) => row.consumptionAmount || row.total || 0;
    return pageResult(items, total, page, {
      summary: {
        count: all.length,
        amount: all.reduce((sum, row) => sum + amountOf(row), 0),
        monthCount: month.length,
        monthAmount: month.reduce((sum, row) => sum + amountOf(row), 0),
      },
    });
  }

  async listPurchaseReturns(query?: { page?: string; pageSize?: string; q?: string }) {
    const page = readPage(query);
    const where = query?.q
      ? { OR: [{ number: { contains: query.q } }, { supplier: { name: { contains: query.q } } }, { warehouse: { name: { contains: query.q } } }, { purchaseInvoice: { number: { contains: query.q } } }] }
      : undefined;
    const include = this.purchaseInclude();
    if (!page) return this.prisma.purchaseReturn.findMany({ where, include, orderBy: { createdAt: 'desc' } });
    const [total, items, all] = await Promise.all([
      this.prisma.purchaseReturn.count({ where }),
      this.prisma.purchaseReturn.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.take }),
      this.prisma.purchaseReturn.findMany({ select: { total: true } }),
    ]);
    return pageResult(items, total, page, {
      summary: { count: all.length, amount: all.reduce((sum, row) => sum + row.total, 0) },
    });
  }

  async salesReturnable(customerId: string) {
    const invoices = await this.prisma.salesInvoice.findMany({
      where: {
        customerId,
        status: { in: ['CONFIRMED', 'PARTIAL', 'PAID'] },
      },
      include: {
        lines: { include: { product: true } },
        warehouse: true,
      },
      orderBy: { invoiceDate: 'asc' },
    });

    const returns = await this.prisma.salesReturn.findMany({
      where: { customerId },
      include: { lines: true },
    });

    const linked = new Map<string, number>();
    const unlinked = new Map<string, number>();
    for (const r of returns) {
      for (const line of r.lines) {
        if (r.salesInvoiceId) {
          const key = `${r.salesInvoiceId}:${line.productId}`;
          linked.set(key, (linked.get(key) || 0) + line.quantity);
        } else {
          unlinked.set(line.productId, (unlinked.get(line.productId) || 0) + line.quantity);
        }
      }
    }

    const grouped = invoices.map((inv) => {
      const byProduct = new Map<string, {
        productId: string; sku: string; name: string; unit: string;
        quantity: number; unitPrice: number;
      }>();
      for (const line of inv.lines) {
        const existing = byProduct.get(line.productId);
        if (!existing) {
          byProduct.set(line.productId, {
            productId: line.productId,
            sku: line.product.sku,
            name: line.product.name,
            unit: line.product.unit,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
          });
        } else {
          existing.quantity += line.quantity;
        }
      }

      const lines = Array.from(byProduct.values()).map((line) => {
        let returnedQty = linked.get(`${inv.id}:${line.productId}`) || 0;
        const loose = unlinked.get(line.productId) || 0;
        const room = Math.max(0, line.quantity - returnedQty);
        const take = Math.min(room, loose);
        returnedQty += take;
        unlinked.set(line.productId, loose - take);
        const remainingQty = Math.max(0, line.quantity - returnedQty);
        return { ...line, returnedQty, remainingQty };
      }).filter((line) => line.remainingQty > 0);

      return {
        id: inv.id,
        number: inv.number,
        invoiceDate: inv.invoiceDate,
        warehouseId: inv.warehouseId,
        warehouseName: inv.warehouse.name,
        total: inv.total,
        lines,
      };
    }).filter((inv) => inv.lines.length > 0)
      .sort((a, b) => new Date(b.invoiceDate).getTime() - new Date(a.invoiceDate).getTime());

    return { customerId, invoices: grouped };
  }

  async purchasesReturnable(supplierId: string) {
    const invoices = await this.prisma.purchaseInvoice.findMany({
      where: {
        supplierId,
        status: { in: ['CONFIRMED', 'PARTIAL', 'PAID'] },
      },
      include: {
        lines: { include: { product: true } },
        warehouse: true,
      },
      orderBy: { invoiceDate: 'asc' },
    });

    const returns = await this.prisma.purchaseReturn.findMany({
      where: { supplierId },
      include: { lines: true },
    });

    const linked = new Map<string, number>();
    const unlinked = new Map<string, number>();
    for (const r of returns) {
      for (const line of r.lines) {
        if (r.purchaseInvoiceId) {
          const key = `${r.purchaseInvoiceId}:${line.productId}`;
          linked.set(key, (linked.get(key) || 0) + line.quantity);
        } else {
          unlinked.set(line.productId, (unlinked.get(line.productId) || 0) + line.quantity);
        }
      }
    }

    const grouped = invoices.map((inv) => {
      const byProduct = new Map<string, {
        productId: string; sku: string; name: string; unit: string;
        quantity: number; unitCost: number;
      }>();
      for (const line of inv.lines) {
        const existing = byProduct.get(line.productId);
        if (!existing) {
          byProduct.set(line.productId, {
            productId: line.productId,
            sku: line.product.sku,
            name: line.product.name,
            unit: line.product.unit,
            quantity: line.quantity,
            unitCost: line.unitCost,
          });
        } else {
          existing.quantity += line.quantity;
        }
      }

      const lines = Array.from(byProduct.values()).map((line) => {
        let returnedQty = linked.get(`${inv.id}:${line.productId}`) || 0;
        const loose = unlinked.get(line.productId) || 0;
        const room = Math.max(0, line.quantity - returnedQty);
        const take = Math.min(room, loose);
        returnedQty += take;
        unlinked.set(line.productId, loose - take);
        const remainingQty = Math.max(0, line.quantity - returnedQty);
        return { ...line, returnedQty, remainingQty };
      }).filter((line) => line.remainingQty > 0);

      return {
        id: inv.id,
        number: inv.number,
        invoiceDate: inv.invoiceDate,
        warehouseId: inv.warehouseId,
        warehouseName: inv.warehouse.name,
        total: inv.total,
        lines,
      };
    }).filter((inv) => inv.lines.length > 0)
      .sort((a, b) => new Date(b.invoiceDate).getTime() - new Date(a.invoiceDate).getTime());

    return { supplierId, invoices: grouped };
  }

  /** أصناف المورد القابلة للإرجاع مجمّعة بدون فواتير */
  async purchasesProducts(supplierId: string, warehouseId?: string) {
    const returnsWh = await this.ensureReturnsWarehouse();
    const stockWarehouseId = warehouseId || returnsWh.id;
    const invoices = await this.prisma.purchaseInvoice.findMany({
      where: {
        supplierId,
        status: { in: ['CONFIRMED', 'PARTIAL', 'PAID'] },
      },
      include: { lines: { include: { product: true } } },
      orderBy: { invoiceDate: 'asc' },
    });
    const returns = await this.prisma.purchaseReturn.findMany({
      where: { supplierId },
      include: { lines: true },
    });

    type Acc = {
      productId: string; sku: string; name: string; unit: string;
      purchasedQty: number; returnedQty: number;
      costSum: number; costQty: number; unitCost: number;
    };
    const byProduct = new Map<string, Acc>();
    for (const inv of invoices) {
      for (const line of inv.lines) {
        const existing = byProduct.get(line.productId);
        if (!existing) {
          byProduct.set(line.productId, {
            productId: line.productId,
            sku: line.product.sku,
            name: line.product.name,
            unit: line.product.unit,
            purchasedQty: line.quantity,
            returnedQty: 0,
            costSum: line.unitCost * line.quantity,
            costQty: line.quantity,
            unitCost: line.unitCost,
          });
        } else {
          existing.purchasedQty += line.quantity;
          existing.costSum += line.unitCost * line.quantity;
          existing.costQty += line.quantity;
        }
      }
    }
    for (const row of returns) {
      for (const line of row.lines) {
        const existing = byProduct.get(line.productId);
        if (!existing) continue;
        existing.returnedQty += line.quantity;
      }
    }

    const productIds = [...byProduct.keys()];
    const balances = productIds.length
      ? await this.prisma.stockBalance.findMany({
          where: { warehouseId: stockWarehouseId, productId: { in: productIds } },
        })
      : [];
    const stockByProduct = new Map(balances.map((b) => [b.productId, b.quantity]));

    const products = Array.from(byProduct.values())
      .map((row) => {
        const purchaseRemaining = Math.max(0, row.purchasedQty - row.returnedQty);
        const warehouseStock = Math.max(0, stockByProduct.get(row.productId) || 0);
        const remainingQty = Math.min(purchaseRemaining, warehouseStock);
        return {
          productId: row.productId,
          sku: row.sku,
          name: row.name,
          unit: row.unit,
          purchasedQty: row.purchasedQty,
          returnedQty: row.returnedQty,
          purchaseRemaining,
          warehouseStock,
          returnsStock: warehouseStock,
          remainingQty,
          unitCost: row.costQty > 0 ? Math.round((row.costSum / row.costQty) * 10000) / 10000 : row.unitCost,
          warehouseId: stockWarehouseId,
        };
      })
      .filter((row) => row.purchaseRemaining > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return { supplierId, warehouseId: stockWarehouseId, products };
  }

  private normalizeSalesPayload(data: SalesReturnPayload) {
    const scrapKg = Math.max(0, data.scrapKg || 0);
    const scrapPieces = Math.max(0, data.scrapPieces || 0);
    const productId = data.productId?.trim() || '';
    const consumptionAmount = Math.max(0, data.consumptionAmount || 0);
    const giveReplacement = !!data.giveReplacement;
    const replacementProductId = data.replacementProductId?.trim() || '';
    const replacementWarehouseId = data.replacementWarehouseId?.trim() || '';
    const replacementQty = Math.max(0, data.replacementQty || 0);
    const customerName = data.customerName?.trim() || null;

    if (!productId && scrapKg <= 0 && scrapPieces <= 0) {
      throw new BadRequestException('اختَر صنفًا أو أدخل كيلوهات/قطع');
    }
    if (consumptionAmount > 0 && !data.cashAccountId) {
      throw new BadRequestException('اختَر الحساب لاستلام مبلغ الاستهلاك');
    }
    if (giveReplacement) {
      if (!replacementProductId) throw new BadRequestException('اختَر البطارية الجديدة للاستبدال');
      if (!replacementWarehouseId) throw new BadRequestException('اختَر مخزن البطارية الجديدة');
      if (replacementQty <= 0) throw new BadRequestException('أدخل كمية البطارية الجديدة');
    }

    return {
      scrapKg,
      scrapPieces,
      productId,
      consumptionAmount,
      giveReplacement,
      replacementProductId,
      replacementWarehouseId,
      replacementQty,
      customerName,
      cashAccountId: data.cashAccountId,
      notes: data.notes,
    };
  }

  private async applySalesReturnEffects(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    number: string,
    warehouseId: string,
    data: ReturnType<ReturnsService['normalizeSalesPayload']>,
  ) {
    // لو في قطع خردة/قديمة → بتروح طابور الفرز مش مخزن المرتجعات
    const toSorting = data.scrapPieces > 0 || data.scrapKg > 0;
    const stockQty = data.productId && !toSorting ? 1 : 0;
    let unitCost = 0;
    if (data.productId) {
      const product = await tx.product.findUnique({ where: { id: data.productId }, select: { costPrice: true } });
      if (!product) throw new BadRequestException('الصنف غير موجود');
      unitCost = product.costPrice || 0;
    }

    if (data.productId && stockQty > 0) {
      await tx.stockBalance.upsert({
        where: { warehouseId_productId: { warehouseId, productId: data.productId } },
        create: { warehouseId, productId: data.productId, quantity: stockQty },
        update: { quantity: { increment: stockQty } },
      });
      await tx.productWarehouse.upsert({
        where: { productId_warehouseId: { productId: data.productId, warehouseId } },
        create: { productId: data.productId, warehouseId },
        update: {},
      });
      await tx.stockMovement.create({
        data: {
          warehouseId,
          productId: data.productId,
          type: StockMovementType.SALE_RETURN,
          quantity: stockQty,
          unitCost,
          reference: number,
        },
      });
    }

    if (data.giveReplacement) {
      const bal = await tx.stockBalance.findUnique({
        where: {
          warehouseId_productId: {
            warehouseId: data.replacementWarehouseId,
            productId: data.replacementProductId,
          },
        },
      });
      if (!bal || bal.quantity < data.replacementQty) {
        throw new BadRequestException('كمية البطارية الجديدة غير كافية في المخزن');
      }
      const replacement = await tx.product.findUnique({
        where: { id: data.replacementProductId },
        select: { costPrice: true },
      });
      await tx.stockBalance.update({
        where: { id: bal.id },
        data: { quantity: { decrement: data.replacementQty } },
      });
      await tx.stockMovement.create({
        data: {
          warehouseId: data.replacementWarehouseId,
          productId: data.replacementProductId,
          type: StockMovementType.SALE,
          quantity: -data.replacementQty,
          unitCost: replacement?.costPrice || 0,
          reference: number,
        },
      });
    }

    if (data.consumptionAmount > 0 && data.cashAccountId) {
      const account = await tx.cashAccount.findUnique({ where: { id: data.cashAccountId } });
      if (!account) throw new BadRequestException('حساب الخزنة غير موجود');
      const method = await tx.payMethod.findUnique({ where: { cashAccountId: data.cashAccountId } });
      await tx.cashAccount.update({
        where: { id: data.cashAccountId },
        data: { balance: { increment: data.consumptionAmount } },
      });
      await tx.cashTransaction.create({
        data: {
          accountId: data.cashAccountId,
          direction: CashDirection.IN,
          amount: data.consumptionAmount,
          description: `إيراد استهلاك مرتجع ${number}`,
          paymentMethod: method?.id || '',
          reference: number,
        },
      });
    }

    return { stockQty, unitCost };
  }

  private async reverseSalesReturnEffects(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    row: {
      number: string;
      warehouseId: string;
      consumptionAmount: number;
      cashAccountId: string | null;
      giveReplacement: boolean;
      replacementProductId: string | null;
      replacementWarehouseId: string | null;
      replacementQty: number;
      lines: { productId: string; quantity: number }[];
    },
  ) {
    for (const line of row.lines) {
      const bal = await tx.stockBalance.findUnique({
        where: { warehouseId_productId: { warehouseId: row.warehouseId, productId: line.productId } },
      });
      if (!bal || bal.quantity < line.quantity) {
        throw new BadRequestException('لا يمكن عكس المرتجع: كمية مخزن المرتجعات غير كافية');
      }
      await tx.stockBalance.update({
        where: { id: bal.id },
        data: { quantity: { decrement: line.quantity } },
      });
    }
    await tx.stockMovement.deleteMany({
      where: { reference: row.number, type: { in: [StockMovementType.SALE_RETURN, StockMovementType.SALE] } },
    });

    if (row.giveReplacement && row.replacementProductId && row.replacementWarehouseId && row.replacementQty > 0) {
      await tx.stockBalance.upsert({
        where: {
          warehouseId_productId: {
            warehouseId: row.replacementWarehouseId,
            productId: row.replacementProductId,
          },
        },
        create: {
          warehouseId: row.replacementWarehouseId,
          productId: row.replacementProductId,
          quantity: row.replacementQty,
        },
        update: { quantity: { increment: row.replacementQty } },
      });
    }

    if (row.consumptionAmount > 0 && row.cashAccountId) {
      const account = await tx.cashAccount.findUnique({ where: { id: row.cashAccountId } });
      if (!account) throw new BadRequestException('حساب الخزنة غير موجود');
      if (account.balance < row.consumptionAmount) {
        throw new BadRequestException('رصيد الخزنة غير كافٍ لعكس إيراد الاستهلاك');
      }
      await tx.cashAccount.update({
        where: { id: row.cashAccountId },
        data: { balance: { decrement: row.consumptionAmount } },
      });
      await tx.cashTransaction.deleteMany({ where: { reference: row.number } });
    }
  }

  async createSalesReturn(data: SalesReturnPayload) {
    await assertPeriodsOpen(this.prisma, new Date());
    const normalized = this.normalizeSalesPayload(data);
    const warehouse = await this.ensureReturnsWarehouse();
    const number = await this.sequence.next('sales_return', 'SR');

    const created = await this.withRecost([normalized.productId, normalized.replacementProductId], this.prisma.$transaction(async (tx) => {
      const { stockQty, unitCost } = await this.applySalesReturnEffects(tx, number, warehouse.id, normalized);
      const pieceQty = normalized.scrapPieces > 0 ? normalized.scrapPieces : (normalized.productId && stockQty ? stockQty : (normalized.scrapKg > 0 ? 1 : 0));
      return tx.salesReturn.create({
        data: {
          number,
          warehouseId: warehouse.id,
          customerName: normalized.customerName,
          total: normalized.consumptionAmount,
          notes: normalized.notes,
          scrapKg: normalized.scrapKg,
          scrapPieces: normalized.scrapPieces,
          consumptionAmount: normalized.consumptionAmount,
          cashAccountId: normalized.consumptionAmount > 0 ? normalized.cashAccountId : null,
          giveReplacement: normalized.giveReplacement,
          replacementProductId: normalized.giveReplacement ? normalized.replacementProductId : null,
          replacementWarehouseId: normalized.giveReplacement ? normalized.replacementWarehouseId : null,
          replacementQty: normalized.giveReplacement ? normalized.replacementQty : 0,
          lines: normalized.productId
            ? {
                create: [{
                  productId: normalized.productId,
                  quantity: pieceQty || 1,
                  unitPrice: 0,
                  unitCost,
                  total: 0,
                }],
              }
            : undefined,
        },
        include: this.salesInclude(),
      });
    }));
    await syncSalesReturnOldBatteries(this.prisma, this.sequence, created.id);
    return this.prisma.salesReturn.findUnique({ where: { id: created.id }, include: this.salesInclude() });
  }

  private async withRecost<T>(productIds: (string | null | undefined)[], work: Promise<T>) {
    const result = await work;
    await recostProducts(this.prisma, productIds.filter((id): id is string => !!id));
    return result;
  }

  async updateSalesReturn(id: string, data: SalesReturnPayload) {
    await assertPeriodsOpen(this.prisma, new Date());
    const existing = await this.prisma.salesReturn.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!existing) throw new NotFoundException('مرتجع البيع غير موجود');
    const normalized = this.normalizeSalesPayload(data);
    const warehouse = await this.ensureReturnsWarehouse();
    const touched = [
      ...existing.lines.map((l) => l.productId),
      existing.replacementProductId,
      normalized.productId,
      normalized.replacementProductId,
    ];

    const updated = await this.withRecost(touched, this.prisma.$transaction(async (tx) => {
      await this.reverseSalesReturnEffects(tx, existing);
      const { stockQty, unitCost } = await this.applySalesReturnEffects(tx, existing.number, warehouse.id, normalized);
      await tx.salesReturnLine.deleteMany({ where: { returnId: id } });
      const pieceQty = normalized.scrapPieces > 0 ? normalized.scrapPieces : (normalized.productId && stockQty ? stockQty : (normalized.scrapKg > 0 ? 1 : 0));
      return tx.salesReturn.update({
        where: { id },
        data: {
          warehouseId: warehouse.id,
          customerName: normalized.customerName,
          total: normalized.consumptionAmount,
          notes: normalized.notes,
          scrapKg: normalized.scrapKg,
          scrapPieces: normalized.scrapPieces,
          consumptionAmount: normalized.consumptionAmount,
          cashAccountId: normalized.consumptionAmount > 0 ? normalized.cashAccountId : null,
          giveReplacement: normalized.giveReplacement,
          replacementProductId: normalized.giveReplacement ? normalized.replacementProductId : null,
          replacementWarehouseId: normalized.giveReplacement ? normalized.replacementWarehouseId : null,
          replacementQty: normalized.giveReplacement ? normalized.replacementQty : 0,
          lines: normalized.productId
            ? {
                create: [{
                  productId: normalized.productId,
                  quantity: pieceQty || 1,
                  unitPrice: 0,
                  unitCost,
                  total: 0,
                }],
              }
            : undefined,
        },
        include: this.salesInclude(),
      });
    }));
    await syncSalesReturnOldBatteries(this.prisma, this.sequence, id);
    return this.prisma.salesReturn.findUnique({ where: { id }, include: this.salesInclude() }) || updated;
  }

  async deleteSalesReturn(id: string) {
    await assertPeriodsOpen(this.prisma, new Date());
    const existing = await this.prisma.salesReturn.findUnique({
      where: { id },
      include: { lines: true, oldBatteries: { select: { id: true, decision: true, loanerReturnedAt: true } } },
    });
    if (!existing) throw new NotFoundException('مرتجع البيع غير موجود');
    if (existing.oldBatteries.some((b) => b.decision !== 'PENDING')) {
      throw new BadRequestException('في بطاريات من المرتجع اتفرزت بالفعل — رجّعها للفرز أو امسحها الأول');
    }
    if (existing.oldBatteries.some((b) => b.loanerReturnedAt)) {
      throw new BadRequestException('بطارية السيرفس اترجّعت للمخزن بالفعل — ألغي التسليم الأول');
    }

    await syncSalesReturnOldBatteries(this.prisma, this.sequence, id, { clear: true });
    return this.withRecost([...existing.lines.map((l) => l.productId), existing.replacementProductId], this.prisma.$transaction(async (tx) => {
      await this.reverseSalesReturnEffects(tx, existing);
      await tx.salesReturn.delete({ where: { id } });
      return { ok: true };
    }));
  }

  private async validatePurchaseLines(
    supplierId: string,
    warehouseId: string,
    lines: PurchaseReturnLineInput[],
    _purchaseInvoiceId?: string,
    excludeReturnId?: string,
  ) {
    if (!lines?.length) throw new BadRequestException('أضف بنوداً');
    if (!warehouseId) throw new BadRequestException('اختر المخزن');
    const { products } = await this.purchasesProducts(supplierId, warehouseId);
    const remainingByProduct = new Map(products.map((p) => [p.productId, p.remainingQty]));
    if (excludeReturnId) {
      const current = await this.prisma.purchaseReturn.findUnique({
        where: { id: excludeReturnId },
        include: { lines: true },
      });
      if (current && current.warehouseId === warehouseId) {
        for (const line of current.lines) {
          remainingByProduct.set(
            line.productId,
            (remainingByProduct.get(line.productId) || 0) + line.quantity,
          );
        }
      } else if (current) {
        // المرتجع القديم من مخزن تاني — رجّع بس حصة فاتورة المورد مش رصيد المخزن الحالي
        for (const line of current.lines) {
          const row = products.find((p) => p.productId === line.productId);
          const purchaseRem = (row?.purchaseRemaining || 0) + line.quantity;
          const stock = row?.warehouseStock || 0;
          remainingByProduct.set(line.productId, Math.min(purchaseRem, stock));
        }
      }
    }
    for (const line of lines) {
      if (line.quantity <= 0) throw new BadRequestException('كمية الإرجاع يجب أن تكون أكبر من صفر');
      const remaining = remainingByProduct.get(line.productId) || 0;
      if (line.quantity > remaining + 0.0001) {
        throw new BadRequestException(
          `المتاح للإرجاع ${remaining} فقط (رصيد المخزن المختار وحد شراء المورد)`,
        );
      }
    }
  }

  private async applyPurchaseReturnStock(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    warehouseId: string,
    number: string,
    lines: { productId: string; quantity: number; unitCost: number }[],
  ) {
    for (const line of lines) {
      const bal = await tx.stockBalance.findUnique({
        where: { warehouseId_productId: { warehouseId, productId: line.productId } },
      });
      if (!bal || bal.quantity < line.quantity) {
        throw new BadRequestException('كمية غير كافية لمرتجع الشراء');
      }
      await tx.stockBalance.update({
        where: { id: bal.id },
        data: { quantity: { decrement: line.quantity } },
      });
      await tx.stockMovement.create({
        data: {
          warehouseId,
          productId: line.productId,
          type: StockMovementType.PURCHASE_RETURN,
          quantity: -line.quantity,
          unitCost: line.unitCost,
          reference: number,
        },
      });
    }
  }

  private async reversePurchaseReturnStock(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    warehouseId: string,
    number: string,
    lines: { productId: string; quantity: number }[],
  ) {
    for (const line of lines) {
      await tx.stockBalance.upsert({
        where: { warehouseId_productId: { warehouseId, productId: line.productId } },
        create: { warehouseId, productId: line.productId, quantity: line.quantity },
        update: { quantity: { increment: line.quantity } },
      });
    }
    await tx.stockMovement.deleteMany({
      where: { reference: number, type: StockMovementType.PURCHASE_RETURN },
    });
  }

  private restockRef(number: string) {
    return `${number}-RST`;
  }

  private async reverseRestocks(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    number: string,
    supplierId?: string,
  ) {
    const movements = await tx.stockMovement.findMany({
      where: { reference: this.restockRef(number), type: StockMovementType.ADJUSTMENT },
    });
    let amount = 0;
    for (const mov of movements) {
      const bal = await tx.stockBalance.findUnique({
        where: { warehouseId_productId: { warehouseId: mov.warehouseId, productId: mov.productId } },
      });
      if (!bal || bal.quantity < mov.quantity) {
        throw new BadRequestException('لا يمكن عكس الاستلام البديل: الكمية غير كافية في المخزن');
      }
      await tx.stockBalance.update({
        where: { id: bal.id },
        data: { quantity: { decrement: mov.quantity } },
      });
      amount += mov.quantity * (mov.unitCost || 0);
    }
    if (movements.length) {
      await tx.stockMovement.deleteMany({ where: { reference: this.restockRef(number) } });
    }
    if (supplierId && amount > 0.0001) {
      await tx.supplier.update({
        where: { id: supplierId },
        data: { balance: { decrement: amount } },
      });
    }
  }

  private normalizeFee(data: PurchaseReturnFeeInput) {
    const fee = Math.round(Math.max(0, data.consumptionFee || 0) * 100) / 100;
    if (fee <= 0) return { fee: 0, settlement: null as string | null, methodId: null as string | null };
    if (data.feeSettlement !== 'BALANCE' && data.feeSettlement !== 'CASH') {
      throw new BadRequestException('اختار هتدفع الاستهلاك للمورد إزاي');
    }
    if (data.feeSettlement === 'CASH' && !data.methodId) throw new BadRequestException('اختار طريقة دفع الاستهلاك');
    return { fee, settlement: data.feeSettlement, methodId: data.feeSettlement === 'CASH' ? data.methodId! : null };
  }

  /** استهلاك على المرتجع: على حساب المورد (بيزود اللي عليك) أو دفع فوري من الخزنة */
  private async applyReturnFee(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    opts: { number: string; supplierId: string; fee: number; settlement: string | null; methodId: string | null },
  ) {
    if (opts.fee <= 0) return null;
    if (opts.settlement === 'BALANCE') {
      await tx.supplier.update({ where: { id: opts.supplierId }, data: { balance: { increment: opts.fee } } });
      return null;
    }
    const method = await tx.payMethod.findUnique({ where: { id: opts.methodId! } });
    if (!method || method.kind !== 'IMMEDIATE' || !method.cashAccountId) {
      throw new BadRequestException('اختار طريقة دفع فورية مربوطة بخزنة');
    }
    const supplier = await tx.supplier.findUnique({ where: { id: opts.supplierId }, select: { name: true } });
    await tx.cashAccount.update({ where: { id: method.cashAccountId }, data: { balance: { decrement: opts.fee } } });
    await tx.cashTransaction.create({
      data: {
        accountId: method.cashAccountId,
        direction: CashDirection.OUT,
        amount: opts.fee,
        description: `استهلاك مرتجع شراء ${opts.number} — ${supplier?.name || ''}`,
        paymentMethod: method.id,
        reference: `${opts.number}-FEE`,
      },
    });
    return method.cashAccountId;
  }

  private async reverseReturnFee(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    row: { number: string; supplierId: string; consumptionFee: number; feeSettlement: string | null; feeCashAccountId: string | null },
  ) {
    if (!(row.consumptionFee > 0)) return;
    if (row.feeSettlement === 'BALANCE') {
      await tx.supplier.update({ where: { id: row.supplierId }, data: { balance: { decrement: row.consumptionFee } } });
      return;
    }
    if (row.feeCashAccountId) {
      await tx.cashAccount.update({ where: { id: row.feeCashAccountId }, data: { balance: { increment: row.consumptionFee } } });
    }
    await tx.cashTransaction.deleteMany({ where: { reference: `${row.number}-FEE` } });
  }

  async createPurchaseReturn(data: {
    supplierId: string;
    warehouseId: string;
    purchaseInvoiceId?: string;
    notes?: string;
    lines: PurchaseReturnLineInput[];
  } & PurchaseReturnFeeInput) {
    await assertPeriodsOpen(this.prisma, new Date());
    if (!data.warehouseId) throw new BadRequestException('اختر المخزن');
    const fee = this.normalizeFee(data);
    await this.validatePurchaseLines(data.supplierId, data.warehouseId, data.lines, data.purchaseInvoiceId);

    const number = await this.sequence.next('purchase_return', 'PR');
    const lines = data.lines.map((l) => ({
      ...l,
      total: l.quantity * l.unitCost,
    }));
    const total = lines.reduce((s, l) => s + l.total, 0);

    return this.withRecost(lines.map((l) => l.productId), this.prisma.$transaction(async (tx) => {
      await this.applyPurchaseReturnStock(tx, data.warehouseId, number, lines);
      await tx.supplier.update({
        where: { id: data.supplierId },
        data: { balance: { decrement: total } },
      });
      const feeCashAccountId = await this.applyReturnFee(tx, { number, supplierId: data.supplierId, ...fee });
      return tx.purchaseReturn.create({
        data: {
          number,
          supplierId: data.supplierId,
          warehouseId: data.warehouseId,
          purchaseInvoiceId: data.purchaseInvoiceId || null,
          total,
          consumptionFee: fee.fee,
          feeSettlement: fee.settlement,
          feeMethodId: fee.methodId,
          feeCashAccountId,
          notes: data.notes,
          lines: { create: lines.map((l) => ({ ...l, restockedQty: 0 })) },
        },
        include: this.purchaseInclude(),
      });
    }));
  }

  async updatePurchaseReturn(id: string, data: {
    warehouseId: string;
    notes?: string;
    lines: PurchaseReturnLineInput[];
  } & PurchaseReturnFeeInput) {
    await assertPeriodsOpen(this.prisma, new Date());
    if (!data.warehouseId) throw new BadRequestException('اختر المخزن');
    const fee = this.normalizeFee(data);
    const existing = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!existing) throw new NotFoundException('مرتجع الشراء غير موجود');

    await this.validatePurchaseLines(existing.supplierId, data.warehouseId, data.lines, existing.purchaseInvoiceId || undefined, id);

    const lines = data.lines.map((l) => ({
      ...l,
      total: l.quantity * l.unitCost,
    }));
    const total = lines.reduce((s, l) => s + l.total, 0);

    return this.withRecost([...existing.lines.map((l) => l.productId), ...lines.map((l) => l.productId)], this.prisma.$transaction(async (tx) => {
      // عكس أي استلام بديل قبل تعديل المرتجع
      await this.reverseRestocks(tx, existing.number, existing.supplierId);
      await this.reversePurchaseReturnStock(tx, existing.warehouseId, existing.number, existing.lines);
      await tx.supplier.update({
        where: { id: existing.supplierId },
        data: { balance: { increment: existing.total } },
      });
      await this.applyPurchaseReturnStock(tx, data.warehouseId, existing.number, lines);
      await tx.supplier.update({
        where: { id: existing.supplierId },
        data: { balance: { decrement: total } },
      });
      await this.reverseReturnFee(tx, existing);
      const feeCashAccountId = await this.applyReturnFee(tx, { number: existing.number, supplierId: existing.supplierId, ...fee });
      await tx.purchaseReturnLine.deleteMany({ where: { returnId: id } });
      return tx.purchaseReturn.update({
        where: { id },
        data: {
          warehouseId: data.warehouseId,
          total,
          consumptionFee: fee.fee,
          feeSettlement: fee.settlement,
          feeMethodId: fee.methodId,
          feeCashAccountId,
          notes: data.notes,
          lines: { create: lines.map((l) => ({ ...l, restockedQty: 0 })) },
        },
        include: this.purchaseInclude(),
      });
    }));
  }

  async deletePurchaseReturn(id: string) {
    await assertPeriodsOpen(this.prisma, new Date());
    const existing = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!existing) throw new NotFoundException('مرتجع الشراء غير موجود');

    return this.withRecost(existing.lines.map((l) => l.productId), this.prisma.$transaction(async (tx) => {
      await this.reverseRestocks(tx, existing.number, existing.supplierId);
      await this.reversePurchaseReturnStock(tx, existing.warehouseId, existing.number, existing.lines);
      await tx.supplier.update({
        where: { id: existing.supplierId },
        data: { balance: { increment: existing.total } },
      });
      await this.reverseReturnFee(tx, existing);
      await tx.purchaseReturn.delete({ where: { id } });
      return { ok: true };
    }));
  }

  async getPurchaseReturn(id: string) {
    const row = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: this.purchaseInclude(),
    });
    if (!row) throw new NotFoundException('مرتجع الشراء غير موجود');
    return row;
  }

  async getSalesReturn(id: string) {
    const row = await this.prisma.salesReturn.findUnique({
      where: { id },
      include: this.salesInclude(),
    });
    if (!row) throw new NotFoundException('مرتجع البيع غير موجود');
    return row;
  }

  async restockPurchaseReturn(id: string, data: {
    warehouseId: string;
    lines: { productId: string; quantity: number }[];
  }) {
    await assertPeriodsOpen(this.prisma, new Date());
    if (!data.warehouseId) throw new BadRequestException('اختر المخزن الجديد');
    if (!data.lines?.length) throw new BadRequestException('حدد كميات الاستلام');

    const existing = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: { lines: { include: { product: true } } },
    });
    if (!existing) throw new NotFoundException('مرتجع الشراء غير موجود');

    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: data.warehouseId } });
    if (!warehouse || !warehouse.isActive) throw new BadRequestException('المخزن غير موجود');

    const byProduct = new Map(existing.lines.map((l) => [l.productId, l]));
    for (const line of data.lines) {
      if (line.quantity <= 0) throw new BadRequestException('كمية الاستلام يجب أن تكون أكبر من صفر');
      const src = byProduct.get(line.productId);
      if (!src) throw new BadRequestException('صنف غير موجود في المرتجع');
      const remaining = Math.max(0, src.quantity - src.restockedQty);
      if (line.quantity > remaining + 0.0001) {
        throw new BadRequestException(`الكمية أكبر من المتاح للاستلام (${remaining}) للصنف ${src.product.name}`);
      }
    }

    const restockAmount = data.lines.reduce((sum, line) => {
      const src = byProduct.get(line.productId)!;
      return sum + line.quantity * (src.unitCost || 0);
    }, 0);

    return this.withRecost(data.lines.map((l) => l.productId), this.prisma.$transaction(async (tx) => {
      for (const line of data.lines) {
        const src = byProduct.get(line.productId)!;
        await tx.stockBalance.upsert({
          where: { warehouseId_productId: { warehouseId: data.warehouseId, productId: line.productId } },
          create: { warehouseId: data.warehouseId, productId: line.productId, quantity: line.quantity },
          update: { quantity: { increment: line.quantity } },
        });
        await tx.productWarehouse.upsert({
          where: { productId_warehouseId: { productId: line.productId, warehouseId: data.warehouseId } },
          create: { productId: line.productId, warehouseId: data.warehouseId },
          update: {},
        });
        await tx.stockMovement.create({
          data: {
            warehouseId: data.warehouseId,
            productId: line.productId,
            type: StockMovementType.ADJUSTMENT,
            quantity: line.quantity,
            unitCost: src.unitCost,
            reference: this.restockRef(existing.number),
            note: `استلام بديل بعد مرتجع شراء ${existing.number}`,
          },
        });
        if (src.unitCost > 0) {
          await tx.product.update({
            where: { id: line.productId },
            data: { costPrice: src.unitCost },
          });
        }
        await tx.purchaseReturnLine.update({
          where: { id: src.id },
          data: { restockedQty: { increment: line.quantity } },
        });
      }
      // الاستلام البديل يعادل المرتجع في كشف المورد (مدين مقابل دائن المرتجع)
      if (restockAmount > 0.0001) {
        await tx.supplier.update({
          where: { id: existing.supplierId },
          data: { balance: { increment: restockAmount } },
        });
      }
      return tx.purchaseReturn.findUnique({
        where: { id },
        include: this.purchaseInclude(),
      });
    }));
  }
}
