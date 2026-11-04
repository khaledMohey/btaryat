import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { CashDirection, InvoiceStatus, OldBattery, PayMethodKind, Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';
import { recostProducts } from '../common/fifo';

type Tx = Prisma.TransactionClient;

export type Decision = 'PENDING' | 'SCRAP' | 'USED' | 'SERVICE' | 'WARRANTY';
const DECISIONS: Decision[] = ['PENDING', 'SCRAP', 'USED', 'SERVICE', 'WARRANTY'];
const YEAR_MS = 365 * 24 * 3600 * 1000;

const round2 = (v: number) => Math.round(v * 100) / 100;

export const USED_WAREHOUSE_CODE = 'USED';
export const USED_WAREHOUSE_NAME = 'مستعمل/سيرفس';

@Injectable()
export class OldBatteriesService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private sequence: SequenceService,
  ) {}

  async onModuleInit() {
    await this.ensureUsedWarehouse().catch((error) => console.error('used warehouse', error));
  }

  /** مخزن ثابت للبطاريات المستعملة والسيرفس */
  ensureUsedWarehouse() {
    return this.prisma.warehouse.upsert({
      where: { code: USED_WAREHOUSE_CODE },
      create: { code: USED_WAREHOUSE_CODE, name: USED_WAREHOUSE_NAME, description: 'البطاريات القديمة اللي اتفرزت مستعمل للبيع أو سيرفس' },
      update: { isActive: true },
    });
  }

  async config() {
    const used = await this.ensureUsedWarehouse();
    return { usedWarehouse: { id: used.id, name: used.name } };
  }

  /** فرز مجموعة مرة واحدة بنفس القرار — اللي يفشل بيرجع في errors والباقي يتنفذ */
  async sortBulk(data: { ids: string[] } & Parameters<OldBatteriesService['sort']>[1]) {
    if (!data.ids?.length) throw new BadRequestException('اختار البطاريات');
    const { ids, ...rest } = data;
    if (rest.decision === 'SERVICE') rest.decision = 'USED';
    if (rest.decision === 'USED' && !rest.stockWarehouseId) {
      rest.stockWarehouseId = (await this.ensureUsedWarehouse()).id;
    }
    const errors: { id: string; number: string; message: string }[] = [];
    let done = 0;
    for (const id of ids) {
      try {
        const row = await this.prisma.oldBattery.findUnique({ where: { id }, select: { productId: true } });
        await this.sort(id, { ...rest, productId: rest.productId || row?.productId || undefined });
        done += 1;
      } catch (error) {
        const row = await this.prisma.oldBattery.findUnique({ where: { id }, select: { number: true } });
        errors.push({ id, number: row?.number || id, message: error instanceof Error ? error.message : 'خطأ' });
      }
    }
    return { ok: errors.length === 0, done, errors };
  }

  private include() {
    return {
      product: { select: { id: true, sku: true, name: true } },
      stockProduct: { select: { id: true, sku: true, name: true } },
      replacementProduct: { select: { id: true, sku: true, name: true } },
      stockWarehouse: { select: { id: true, name: true } },
      replacementWarehouse: { select: { id: true, name: true } },
      salesInvoice: { select: { id: true, number: true } },
      supplier: { select: { id: true, name: true } },
      scrapSale: { select: { id: true, number: true } },
    } satisfies Prisma.OldBatteryInclude;
  }

  async list(query: { view?: string; supplierId?: string; q?: string }) {
    const where: Prisma.OldBatteryWhereInput = {};
    if (query.view === 'sort') where.decision = 'PENDING';
    else if (query.view === 'scrap') where.decision = 'SCRAP';
    else if (query.view === 'stock') where.decision = { in: ['USED', 'SERVICE'] };
    else if (query.view === 'warranty') where.decision = 'WARRANTY';
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { number: { contains: q } },
        { label: { contains: q } },
        { customerName: { contains: q } },
        { customerPhone: { contains: q } },
        { receiverName: { contains: q } },
        { product: { name: { contains: q } } },
        { supplier: { name: { contains: q } } },
      ];
    }
    return this.prisma.oldBattery.findMany({
      where,
      include: this.include(),
      orderBy: query.view === 'warranty' ? [{ sentAt: 'desc' }, { createdAt: 'desc' }] : { receivedAt: 'desc' },
      take: 500,
    });
  }

  async summary() {
    const rows = await this.prisma.oldBattery.findMany({
      select: { decision: true, claimStatus: true, scrapSaleId: true, intakeValue: true, weightKg: true, ownership: true },
    });
    const pile = rows.filter((r) => r.decision === 'SCRAP' && !r.scrapSaleId);
    return {
      toSort: rows.filter((r) => r.decision === 'PENDING').length,
      scrapPile: pile.length,
      scrapPileValue: round2(pile.reduce((s, r) => s + r.intakeValue, 0)),
      scrapPileKg: round2(pile.reduce((s, r) => s + (r.weightKg || 0), 0)),
      inShop: rows.filter((r) => r.decision === 'WARRANTY' && r.claimStatus === 'IN_SHOP').length,
      withSupplier: rows.filter((r) => r.decision === 'WARRANTY' && r.claimStatus === 'SENT').length,
      waitingCustomer: rows.filter((r) => r.ownership === 'CUSTOMER' && r.claimStatus === 'RECEIVED').length,
    };
  }

  async findOne(id: string) {
    const row = await this.prisma.oldBattery.findUnique({ where: { id }, include: this.include() });
    if (!row) throw new NotFoundException('البطارية غير موجودة');
    return row;
  }

  /** بطارية قديمة يدوي أو ضمان زبون مستني البديل */
  async create(data: {
    kind: 'MANUAL' | 'WARRANTY_WAIT';
    quantity?: number;
    productId?: string;
    label?: string;
    customerName?: string;
    customerPhone?: string;
    intakeValue?: number;
    productionDate?: string;
    ageBand?: string;
    supplierId?: string;
    notes?: string;
  }) {
    const count = Math.max(1, Math.min(50, Math.round(data.quantity || 1)));
    const wait = data.kind === 'WARRANTY_WAIT';
    if (wait && !data.customerName?.trim()) throw new BadRequestException('اكتب اسم الزبون');
    if (!data.productId && !data.label?.trim()) throw new BadRequestException('اختار نوع البطارية');
    const customer = data.customerName?.trim()
      ? await this.prisma.customer.findFirst({ where: { name: data.customerName.trim() }, select: { id: true } })
      : null;
    const age = this.ageOf(data.productionDate, data.ageBand);
    const numbers: string[] = [];
    for (let i = 0; i < count; i++) numbers.push(await this.sequence.next('old_battery', 'OB'));
    await this.prisma.oldBattery.createMany({
      data: numbers.map((number) => ({
        number,
        source: wait ? 'WARRANTY_WAIT' : 'MANUAL',
        ownership: wait ? 'CUSTOMER' : 'SHOP',
        productId: data.productId || null,
        label: data.label?.trim() || null,
        customerId: customer?.id || null,
        customerName: data.customerName?.trim() || null,
        customerPhone: data.customerPhone?.trim() || null,
        intakeValue: wait ? 0 : Math.max(0, data.intakeValue || 0),
        productionDate: age.productionDate,
        ageBand: age.ageBand,
        decision: wait ? 'WARRANTY' : 'PENDING',
        claimStatus: wait ? 'IN_SHOP' : null,
        supplierId: wait ? data.supplierId || null : null,
        sortedAt: wait ? new Date() : null,
        notes: data.notes?.trim() || null,
      })),
    });
    return this.prisma.oldBattery.findMany({ where: { number: { in: numbers } }, include: this.include() });
  }

  async update(id: string, data: { productId?: string | null; label?: string | null; customerName?: string | null; customerPhone?: string | null; intakeValue?: number; notes?: string | null }) {
    const row = await this.findOne(id);
    if (data.intakeValue !== undefined && ['USED', 'SERVICE'].includes(row.decision)) {
      throw new BadRequestException('رجّع البطارية للفرز الأول عشان تعدّل قيمتها');
    }
    await this.prisma.oldBattery.update({
      where: { id },
      data: {
        ...(data.productId !== undefined ? { productId: data.productId || null } : {}),
        ...(data.label !== undefined ? { label: data.label?.trim() || null } : {}),
        ...(data.customerName !== undefined ? { customerName: data.customerName?.trim() || null } : {}),
        ...(data.customerPhone !== undefined ? { customerPhone: data.customerPhone?.trim() || null } : {}),
        ...(data.intakeValue !== undefined ? { intakeValue: Math.max(0, data.intakeValue) } : {}),
        ...(data.notes !== undefined ? { notes: data.notes?.trim() || null } : {}),
      },
    });
    return this.findOne(id);
  }

  private ageOf(productionDate?: string | null, ageBand?: string | null) {
    if (productionDate) {
      const date = new Date(productionDate);
      if (!Number.isNaN(date.getTime())) {
        return { productionDate: date, ageBand: Date.now() - date.getTime() < YEAR_MS ? 'UNDER_YEAR' : 'OVER_YEAR' };
      }
    }
    return { productionDate: null, ageBand: ageBand === 'UNDER_YEAR' || ageBand === 'OVER_YEAR' ? ageBand : null };
  }

  private async stockIn(tx: Tx, opts: { warehouseId: string; productId: string; unitCost: number; reference: string; note: string }) {
    await tx.stockBalance.upsert({
      where: { warehouseId_productId: { warehouseId: opts.warehouseId, productId: opts.productId } },
      create: { warehouseId: opts.warehouseId, productId: opts.productId, quantity: 1 },
      update: { quantity: { increment: 1 } },
    });
    await tx.productWarehouse.upsert({
      where: { productId_warehouseId: { productId: opts.productId, warehouseId: opts.warehouseId } },
      create: { productId: opts.productId, warehouseId: opts.warehouseId },
      update: {},
    });
    await tx.stockMovement.create({
      data: {
        warehouseId: opts.warehouseId,
        productId: opts.productId,
        type: StockMovementType.ADJUSTMENT,
        quantity: 1,
        unitCost: round2(opts.unitCost),
        reference: opts.reference,
        note: opts.note,
      },
    });
  }

  private async stockOut(tx: Tx, reference: string) {
    const movements = await tx.stockMovement.findMany({ where: { reference, type: StockMovementType.ADJUSTMENT } });
    for (const mov of movements) {
      const bal = await tx.stockBalance.findUnique({
        where: { warehouseId_productId: { warehouseId: mov.warehouseId, productId: mov.productId } },
      });
      if (!bal || bal.quantity < mov.quantity - 0.0001) {
        throw new BadRequestException('البطارية دي اتباعت أو اتنقلت من المخزن — مينفعش ترجع الخطوة');
      }
      await tx.stockBalance.update({ where: { id: bal.id }, data: { quantity: { decrement: mov.quantity } } });
    }
    await tx.stockMovement.deleteMany({ where: { reference, type: StockMovementType.ADJUSTMENT } });
    return movements.map((m) => m.productId);
  }

  /** الفرز: نوع البطارية + حالتها + مصيرها */
  async sort(id: string, data: {
    productId?: string;
    label?: string;
    productionDate?: string | null;
    ageBand?: string | null;
    condition?: string | null;
    decision: Decision;
    stockProductId?: string;
    stockWarehouseId?: string;
    weightKg?: number | null;
    supplierId?: string | null;
    notes?: string | null;
  }) {
    if (!DECISIONS.includes(data.decision)) throw new BadRequestException('اختار مصير البطارية');
    // المستعمل والسيرفس مصير واحد بيروح مخزن مستعمل/سيرفس
    if (data.decision === 'SERVICE') data.decision = 'USED';
    const row = await this.findOne(id);
    if (row.ownership === 'CUSTOMER' && data.decision !== 'WARRANTY') {
      throw new BadRequestException('بطارية الزبون في الضمان مصيرها مرتجع للمورد بس');
    }
    if (row.decision === 'SCRAP' && row.scrapSaleId && data.decision !== 'SCRAP') {
      throw new BadRequestException(`البطارية اتباعت خردة في ${row.scrapSale?.number} — شيلها من بيع الخردة الأول`);
    }
    const backInShop = !row.claimStatus || row.claimStatus === 'IN_SHOP' || row.claimStatus === 'REJECTED';
    if (row.decision === 'WARRANTY' && !backInShop && data.decision !== 'WARRANTY') {
      throw new BadRequestException('البطارية اتبعتت للمورد — رجّع الإرسال الأول');
    }
    const toStock = data.decision === 'USED';
    if (toStock && !data.stockWarehouseId) data.stockWarehouseId = (await this.ensureUsedWarehouse()).id;
    if (toStock && !data.stockProductId) {
      throw new BadRequestException('اختار الصنف المستعمل/السيرفس اللي هتدخل بيه');
    }
    const age = data.productionDate !== undefined || data.ageBand !== undefined
      ? this.ageOf(data.productionDate, data.ageBand)
      : { productionDate: row.productionDate, ageBand: row.ageBand };
    const touched: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      const wasStock = row.decision === 'USED' || row.decision === 'SERVICE';
      const sameStock = wasStock && toStock
        && row.stockProductId === data.stockProductId && row.stockWarehouseId === data.stockWarehouseId;
      if (wasStock && !sameStock) touched.push(...await this.stockOut(tx, row.number));
      if (toStock && !sameStock) {
        await this.stockIn(tx, {
          warehouseId: data.stockWarehouseId!,
          productId: data.stockProductId!,
          unitCost: row.intakeValue,
          reference: row.number,
          note: `مستعمل/سيرفس من بطارية قديمة ${row.number}`,
        });
        touched.push(data.stockProductId!);
      }
      await tx.oldBattery.update({
        where: { id },
        data: {
          ...(data.productId !== undefined ? { productId: data.productId || null } : {}),
          ...(data.label !== undefined ? { label: data.label?.trim() || null } : {}),
          productionDate: age.productionDate,
          ageBand: age.ageBand,
          ...(data.condition !== undefined ? { condition: data.condition || null } : {}),
          decision: data.decision,
          sortedAt: data.decision === 'PENDING' ? null : new Date(),
          stockProductId: toStock ? data.stockProductId! : null,
          stockWarehouseId: toStock ? data.stockWarehouseId! : null,
          weightKg: data.decision === 'SCRAP' ? (data.weightKg ?? row.weightKg ?? null) : null,
          claimStatus: data.decision === 'WARRANTY'
            ? (!row.claimStatus || row.claimStatus === 'REJECTED' ? 'IN_SHOP' : row.claimStatus)
            : null,
          ...(data.decision !== 'WARRANTY' || row.claimStatus === 'REJECTED' ? { sentAt: null, receiverName: null } : {}),
          ...(data.decision === 'WARRANTY' && data.supplierId !== undefined ? { supplierId: data.supplierId || null } : {}),
          ...(data.decision !== 'WARRANTY' && row.ownership === 'SHOP' ? { supplierId: null } : {}),
          ...(data.notes !== undefined ? { notes: data.notes?.trim() || null } : {}),
        },
      });
    });
    await recostProducts(this.prisma, touched);
    return this.findOne(id);
  }

  /** إرسال مجموعة بطاريات ضمان للمورد */
  async send(data: { ids: string[]; supplierId: string; sentAt?: string; receiverName?: string }) {
    if (!data.ids?.length) throw new BadRequestException('اختار البطاريات');
    if (!data.supplierId) throw new BadRequestException('اختار المورد');
    const rows = await this.prisma.oldBattery.findMany({ where: { id: { in: data.ids } } });
    for (const row of rows) {
      if (row.decision !== 'WARRANTY') throw new BadRequestException(`${row.number} مش متفرزة مرتجع ضمان`);
      if (row.claimStatus !== 'IN_SHOP' && row.claimStatus !== 'SENT') {
        throw new BadRequestException(`${row.number} البديل بتاعها وصل بالفعل`);
      }
    }
    await this.prisma.oldBattery.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: {
        supplierId: data.supplierId,
        claimStatus: 'SENT',
        sentAt: data.sentAt ? new Date(data.sentAt) : new Date(),
        receiverName: data.receiverName?.trim() || null,
      },
    });
    return { ok: true, count: rows.length };
  }

  async unsend(id: string) {
    const row = await this.findOne(id);
    if (row.claimStatus !== 'SENT') throw new BadRequestException('البطارية مش عند المورد');
    await this.prisma.oldBattery.update({ where: { id }, data: { claimStatus: 'IN_SHOP', sentAt: null, receiverName: null } });
    return this.findOne(id);
  }

  /** وصل البديل من المورد */
  async receive(id: string, data: {
    replacementProductId?: string;
    replacementWarehouseId?: string;
    consumptionFee?: number;
    feeSettlement?: 'BALANCE' | 'CASH';
    methodId?: string;
    replacementAt?: string;
  }) {
    const row = await this.findOne(id);
    if (row.decision !== 'WARRANTY' || row.claimStatus !== 'SENT') throw new BadRequestException('البطارية لازم تكون عند المورد');
    if (!row.supplierId) throw new BadRequestException('حدد المورد الأول');
    const shop = row.ownership === 'SHOP';
    const fee = round2(Math.max(0, data.consumptionFee || 0));
    if (shop && (!data.replacementProductId || !data.replacementWarehouseId)) {
      throw new BadRequestException('اختار صنف البطارية الجديدة والمخزن اللي هتدخله');
    }
    if (fee > 0 && data.feeSettlement !== 'BALANCE' && data.feeSettlement !== 'CASH') {
      throw new BadRequestException('اختار هتدفع الاستهلاك إزاي');
    }
    if (fee > 0 && data.feeSettlement === 'CASH' && !data.methodId) throw new BadRequestException('اختار طريقة دفع الاستهلاك');

    await this.prisma.$transaction(async (tx) => {
      let cashAccountId: string | null = null;
      if (fee > 0 && data.feeSettlement === 'BALANCE') {
        await tx.supplier.update({ where: { id: row.supplierId! }, data: { balance: { increment: fee } } });
      }
      if (fee > 0 && data.feeSettlement === 'CASH') {
        const method = await tx.payMethod.findUnique({ where: { id: data.methodId! } });
        if (!method || method.kind !== PayMethodKind.IMMEDIATE || !method.cashAccountId) {
          throw new BadRequestException('اختار طريقة دفع فورية مربوطة بخزنة');
        }
        cashAccountId = method.cashAccountId;
        await tx.cashAccount.update({ where: { id: cashAccountId }, data: { balance: { decrement: fee } } });
        await tx.cashTransaction.create({
          data: {
            accountId: cashAccountId,
            direction: CashDirection.OUT,
            amount: fee,
            description: `استهلاك ضمان ${row.number} — ${row.supplier?.name || ''}`,
            paymentMethod: method.id,
            reference: `${row.number}-FEE`,
          },
        });
      }
      if (shop) {
        await this.stockIn(tx, {
          warehouseId: data.replacementWarehouseId!,
          productId: data.replacementProductId!,
          unitCost: row.intakeValue + fee,
          reference: `${row.number}-RPL`,
          note: `بديل ضمان ${row.number} من ${row.supplier?.name || 'المورد'} (خردة ${round2(row.intakeValue)} + استهلاك ${fee})`,
        });
      }
      await tx.oldBattery.update({
        where: { id },
        data: {
          claimStatus: 'RECEIVED',
          replacementAt: data.replacementAt ? new Date(data.replacementAt) : new Date(),
          replacementProductId: data.replacementProductId || row.productId || null,
          replacementWarehouseId: shop ? data.replacementWarehouseId! : null,
          consumptionFee: fee,
          feeSettlement: fee > 0 ? data.feeSettlement! : null,
          feeMethodId: fee > 0 && data.feeSettlement === 'CASH' ? data.methodId! : null,
          feeCashAccountId: cashAccountId,
        },
      });
    });
    if (shop) await recostProducts(this.prisma, [data.replacementProductId!]);
    return this.findOne(id);
  }

  private async reverseReceive(tx: Tx, row: OldBattery) {
    const touched: string[] = [];
    if (row.ownership === 'SHOP') touched.push(...await this.stockOut(tx, `${row.number}-RPL`));
    if (row.consumptionFee > 0 && row.feeSettlement === 'BALANCE' && row.supplierId) {
      await tx.supplier.update({ where: { id: row.supplierId }, data: { balance: { decrement: row.consumptionFee } } });
    }
    if (row.consumptionFee > 0 && row.feeSettlement === 'CASH' && row.feeCashAccountId) {
      await tx.cashAccount.update({ where: { id: row.feeCashAccountId }, data: { balance: { increment: row.consumptionFee } } });
      await tx.cashTransaction.deleteMany({ where: { reference: `${row.number}-FEE` } });
    }
    return touched;
  }

  async undoReceive(id: string) {
    const row = await this.prisma.oldBattery.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('البطارية غير موجودة');
    if (row.claimStatus !== 'RECEIVED' && row.claimStatus !== 'DELIVERED') throw new BadRequestException('البديل لسه موصلش');
    const touched = await this.prisma.$transaction(async (tx) => {
      const ids = await this.reverseReceive(tx, row);
      await tx.oldBattery.update({
        where: { id },
        data: {
          claimStatus: 'SENT',
          replacementAt: null,
          replacementProductId: null,
          replacementWarehouseId: null,
          consumptionFee: 0,
          feeSettlement: null,
          feeMethodId: null,
          feeCashAccountId: null,
          deliveredAt: null,
        },
      });
      return ids;
    });
    await recostProducts(this.prisma, touched);
    return this.findOne(id);
  }

  async deliver(id: string, undo = false) {
    const row = await this.findOne(id);
    if (row.ownership !== 'CUSTOMER') throw new BadRequestException('البطارية دي ملك المحل');
    if (undo) {
      if (row.claimStatus !== 'DELIVERED') throw new BadRequestException('البطارية مش متسلّمة');
      await this.prisma.oldBattery.update({ where: { id }, data: { claimStatus: 'RECEIVED', deliveredAt: null } });
    } else {
      if (row.claimStatus !== 'RECEIVED') throw new BadRequestException('البديل لسه موصلش');
      await this.prisma.oldBattery.update({ where: { id }, data: { claimStatus: 'DELIVERED', deliveredAt: new Date() } });
    }
    return this.findOne(id);
  }

  /** المورد رفض الضمان: ترجع المحل (ولو ملك المحل ممكن تتحول خردة) */
  async reject(id: string, data: { toScrap?: boolean }) {
    const row = await this.findOne(id);
    if (row.claimStatus !== 'SENT' && row.claimStatus !== 'IN_SHOP') throw new BadRequestException('البديل وصل بالفعل');
    await this.prisma.oldBattery.update({
      where: { id },
      data: row.ownership === 'SHOP' && data.toScrap
        ? { decision: 'SCRAP', claimStatus: null, sortedAt: new Date(), notes: [row.notes, 'المورد رفض الضمان'].filter(Boolean).join(' — ') }
        : { claimStatus: 'REJECTED' },
    });
    return this.findOne(id);
  }

  async remove(id: string) {
    const row = await this.prisma.oldBattery.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('البطارية غير موجودة');
    if (row.scrapSaleId) throw new BadRequestException('البطارية اتباعت خردة — شيلها من بيع الخردة الأول');
    if (row.claimStatus === 'RECEIVED' || row.claimStatus === 'DELIVERED') throw new BadRequestException('ألغِ استلام البديل الأول');
    const touched = await this.prisma.$transaction(async (tx) => {
      const ids = row.decision === 'USED' || row.decision === 'SERVICE' ? await this.stockOut(tx, row.number) : [];
      await tx.oldBattery.delete({ where: { id } });
      return ids;
    });
    await recostProducts(this.prisma, touched);
    return { ok: true };
  }
}

/**
 * بطاريات الخردة اللي العميل سلّمها مع فاتورة البيع → بطاريات قديمة ملك المحل مستنية الفرز.
 * القيمة = قيمة الخردة ÷ عدد القطع. البطاريات اللي اتفرزت بالفعل مبتتمسحش.
 */
export async function syncSaleOldBatteries(prisma: PrismaService, sequence: SequenceService, invoiceId: string) {
  try {
    const inv = await prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
      include: { customer: { select: { id: true, name: true, phone: true } }, oldBatteries: true },
    });
    if (!inv) return;
    const live = inv.status !== InvoiceStatus.DRAFT && inv.status !== InvoiceStatus.CANCELLED && inv.hasScrap;
    const desired = live ? Math.max(1, Math.round(inv.scrapPieces || 0)) : 0;
    const each = desired ? round2((inv.scrapAmount || 0) / desired) : 0;
    const source = inv.scrapKind === 'WARRANTY_SWAP' ? 'WARRANTY_SWAP' : 'SALE_SCRAP';
    const pending = inv.oldBatteries.filter((b) => b.decision === 'PENDING');
    const sorted = inv.oldBatteries.length - pending.length;
    const keepPending = Math.max(0, desired - sorted);
    const extra = pending.slice(keepPending);
    if (extra.length) await prisma.oldBattery.deleteMany({ where: { id: { in: extra.map((b) => b.id) } } });
    for (const b of pending.slice(0, keepPending)) {
      await prisma.oldBattery.update({ where: { id: b.id }, data: { intakeValue: each, source, receivedAt: inv.invoiceDate } });
    }
    for (let i = pending.length; i < keepPending; i++) {
      await prisma.oldBattery.create({
        data: {
          number: await sequence.next('old_battery', 'OB'),
          source,
          ownership: 'SHOP',
          salesInvoiceId: inv.id,
          customerId: inv.customer.id,
          customerName: inv.customer.name,
          customerPhone: inv.customer.phone,
          intakeValue: each,
          receivedAt: inv.invoiceDate,
        },
      });
    }
  } catch (error) {
    console.error('sync old batteries failed', error);
  }
}
