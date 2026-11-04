import { CashDirection, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Range = { gte?: Date; lte?: Date } | undefined;

export type JournalRow = {
  key: string;
  date: string;
  kind: string;
  group: 'sales' | 'purchases' | 'returns' | 'oldBatteries' | 'scrap' | 'cash' | 'stock' | 'expenses';
  reference: string | null;
  party: string | null;
  description: string;
  value: number | null;
  cashIn: number;
  cashOut: number;
  goodsIn: number;
  goodsOut: number;
  accounts: string[];
  products: string[];
};

const round = (v: number) => Math.round(v * 100) / 100;

const MOVE_LABEL: Record<StockMovementType, string> = {
  PURCHASE: 'شراء',
  SALE: 'بيع',
  PURCHASE_RETURN: 'مرتجع شراء',
  SALE_RETURN: 'مرتجع بيع',
  TRANSFER_IN: 'تحويل وارد',
  TRANSFER_OUT: 'تحويل صادر',
  ADJUSTMENT: 'تسوية',
};

const DECISION_LABEL: Record<string, string> = {
  SCRAP: 'خردة',
  USED: 'مستعمل/سيرفس',
  SERVICE: 'مستعمل/سيرفس',
  WARRANTY: 'مرتجع ضمان للمورد',
};

const SOURCE_LABEL: Record<string, string> = {
  SALE_SCRAP: 'خردة من فاتورة بيع',
  WARRANTY_SWAP: 'ضمان — الزبون دفع فرق',
  WARRANTY_WAIT: 'ضمان زبون مستني البديل',
  MANUAL: 'إدخال يدوي',
};

/** الأصل بتاع المرجع (من غير لاحقة -RST / -FEE / -RPL) */
function baseRef(ref: string) {
  return ref.replace(/-(RST|FEE|RPL)$/, '');
}

/**
 * دفتر الحركة: كل اللي حصل في الفترة.
 * الفلوس والبضاعة محسوبين من حركات الخزنة وحركات المخزون نفسها — فالإجماليات بتطابق تقرير الخزنة والمخزون.
 * وفوقهم الأحداث اللي مالهاش فلوس ولا بضاعة (فرز، إرسال ضمان، تسوية على الحساب…).
 */
export async function buildJournal(prisma: PrismaService, range: Range) {
  const [cash, moves] = await Promise.all([
    prisma.cashTransaction.findMany({
      where: range ? { createdAt: range } : undefined,
      include: { account: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.stockMovement.findMany({
      where: range ? { createdAt: range } : undefined,
      include: { product: { select: { name: true } }, warehouse: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const rows = new Map<string, JournalRow>();
  const rowFor = (key: string, date: Date, init: Partial<JournalRow>) => {
    let row = rows.get(key);
    if (!row) {
      row = {
        key, date: date.toISOString(), kind: 'حركة', group: 'cash', reference: null, party: null, description: '',
        value: null, cashIn: 0, cashOut: 0, goodsIn: 0, goodsOut: 0, accounts: [], products: [], ...init,
      };
      rows.set(key, row);
    } else if (date.toISOString() < row.date) {
      row.date = date.toISOString();
    }
    return row;
  };

  for (const tx of cash) {
    const key = tx.reference ? `ref:${tx.reference}` : `tx:${tx.id}`;
    const row = rowFor(key, tx.createdAt, { reference: tx.reference, description: tx.description });
    if (tx.direction === CashDirection.IN) row.cashIn += tx.amount;
    else row.cashOut += tx.amount;
    if (!row.accounts.includes(tx.account.name)) row.accounts.push(tx.account.name);
    if (!row.description) row.description = tx.description;
  }
  for (const mov of moves) {
    const key = mov.reference ? `ref:${mov.reference}` : `mv:${mov.id}`;
    const row = rowFor(key, mov.createdAt, { reference: mov.reference, group: 'stock', kind: MOVE_LABEL[mov.type] });
    if (mov.quantity > 0) row.goodsIn += mov.quantity;
    else row.goodsOut += -mov.quantity;
    const label = `${mov.product.name} (${mov.warehouse.name}) ${mov.quantity > 0 ? '+' : ''}${mov.quantity}`;
    row.products.push(label);
    if (!row.reference) row.description = mov.note || `${MOVE_LABEL[mov.type]} ${mov.product.name}`;
  }

  // ربط كل مرجع بالمستند بتاعه
  const refs = [...new Set([...rows.values()].map((r) => r.reference).filter((r): r is string => !!r).map(baseRef))];
  const byNumber = <T extends { number: string }>(list: T[]) => new Map(list.map((x) => [x.number, x]));
  const [sales, purchases, receipts, payments, salesReturns, purchaseReturns, scrapSales, olds, transfers] = refs.length
    ? await Promise.all([
        prisma.salesInvoice.findMany({ where: { number: { in: refs } }, select: { number: true, total: true, scrapAmount: true, customer: { select: { name: true } } } }),
        prisma.purchaseInvoice.findMany({ where: { number: { in: refs } }, select: { number: true, total: true, scrapAmount: true, supplier: { select: { name: true } } } }),
        prisma.receipt.findMany({ where: { number: { in: refs } }, select: { number: true, amount: true, customer: { select: { name: true } }, salesInvoice: { select: { number: true } } } }),
        prisma.payment.findMany({ where: { number: { in: refs } }, select: { number: true, amount: true, supplier: { select: { name: true } }, purchaseInvoice: { select: { number: true } } } }),
        prisma.salesReturn.findMany({ where: { number: { in: refs } }, select: { number: true, customerName: true, consumptionAmount: true, customer: { select: { name: true } } } }),
        prisma.purchaseReturn.findMany({ where: { number: { in: refs } }, select: { number: true, total: true, consumptionFee: true, supplier: { select: { name: true } } } }),
        prisma.scrapSale.findMany({ where: { number: { in: refs } }, select: { number: true, amount: true, netKg: true, supplier: { select: { name: true } } } }),
        prisma.oldBattery.findMany({ where: { number: { in: refs } }, select: { number: true, intakeValue: true, consumptionFee: true, ownership: true, customerName: true, supplier: { select: { name: true } } } }),
        prisma.stockTransfer.findMany({ where: { number: { in: refs } }, select: { number: true, fromWarehouse: { select: { name: true } }, toWarehouse: { select: { name: true } } } }),
      ])
    : [[], [], [], [], [], [], [], [], []];
  const maps = {
    sales: byNumber(sales), purchases: byNumber(purchases), receipts: byNumber(receipts), payments: byNumber(payments),
    salesReturns: byNumber(salesReturns), purchaseReturns: byNumber(purchaseReturns), scrapSales: byNumber(scrapSales),
    olds: byNumber(olds), transfers: byNumber(transfers),
  };

  for (const row of rows.values()) {
    if (!row.reference) {
      if (row.group === 'cash') row.kind = row.cashIn > 0 ? 'وارد خزنة' : 'مصروف / صادر خزنة';
      if (row.group === 'cash' && /مصروف/.test(row.description)) row.group = 'expenses';
      continue;
    }
    const ref = row.reference;
    const base = baseRef(ref);
    const suffix = ref.slice(base.length);
    const s = maps.sales.get(base);
    const p = maps.purchases.get(base);
    const rc = maps.receipts.get(base);
    const pay = maps.payments.get(base);
    const sr = maps.salesReturns.get(base);
    const pr = maps.purchaseReturns.get(base);
    const sc = maps.scrapSales.get(base);
    const ob = maps.olds.get(base);
    const tr = maps.transfers.get(base);
    if (s) Object.assign(row, { kind: 'فاتورة بيع', group: 'sales', party: s.customer.name, value: s.total, description: s.scrapAmount > 0 ? `+ خردة مستلمة ${round(s.scrapAmount)}` : 'بيع' });
    else if (p) Object.assign(row, { kind: 'فاتورة شراء', group: 'purchases', party: p.supplier.name, value: round(p.total + p.scrapAmount), description: p.scrapAmount > 0 ? `− خردة مخصومة ${round(p.scrapAmount)}` : 'شراء' });
    else if (rc) Object.assign(row, { kind: 'تحصيل من عميل', group: 'sales', party: rc.customer.name, value: rc.amount, description: rc.salesInvoice ? `على فاتورة ${rc.salesInvoice.number}` : 'تحصيل' });
    else if (pay) Object.assign(row, { kind: 'سداد لمورد', group: 'purchases', party: pay.supplier.name, value: pay.amount, description: pay.purchaseInvoice ? `على فاتورة ${pay.purchaseInvoice.number}` : 'سداد' });
    else if (sr) Object.assign(row, { kind: 'مرتجع بيع', group: 'returns', party: sr.customer?.name || sr.customerName || null, value: sr.consumptionAmount || null, description: sr.consumptionAmount > 0 ? 'مرتجع + استهلاك' : 'مرتجع لمخزن المرتجعات' });
    else if (pr && suffix === '-RST') Object.assign(row, { kind: 'استلام بديل مرتجع شراء', group: 'returns', party: pr.supplier.name, description: `بديل ${pr.number}` });
    else if (pr && suffix === '-FEE') Object.assign(row, { kind: 'استهلاك مرتجع شراء', group: 'returns', party: pr.supplier.name, value: pr.consumptionFee, description: 'استهلاك مدفوع للمورد' });
    else if (pr) Object.assign(row, { kind: 'مرتجع شراء', group: 'returns', party: pr.supplier.name, value: pr.total, description: pr.consumptionFee > 0 ? `استهلاك ${pr.consumptionFee}` : 'مرتجع للمورد' });
    else if (sc) Object.assign(row, { kind: 'بيع خردة', group: 'scrap', party: sc.supplier.name, value: sc.amount, description: `${sc.netKg} كجم` });
    else if (ob && suffix === '-RPL') Object.assign(row, { kind: 'وصل بديل ضمان', group: 'oldBatteries', party: ob.supplier?.name || null, value: round(ob.intakeValue + ob.consumptionFee), description: `تكلفة البديل = خردة ${round(ob.intakeValue)} + استهلاك ${round(ob.consumptionFee)}` });
    else if (ob && suffix === '-FEE') Object.assign(row, { kind: 'استهلاك ضمان', group: 'oldBatteries', party: ob.supplier?.name || null, value: ob.consumptionFee, description: 'استهلاك مدفوع فوري' });
    else if (ob) Object.assign(row, { kind: 'دخول مستعمل/سيرفس', group: 'oldBatteries', value: ob.intakeValue, description: 'من بطارية قديمة' });
    else if (tr) Object.assign(row, { kind: 'تحويل بين مخازن', group: 'stock', description: `${tr.fromWarehouse.name} ← ${tr.toWarehouse.name}` });
    else if (row.group === 'cash') row.kind = row.cashIn > 0 ? 'وارد خزنة' : 'صادر خزنة';
  }

  // أحداث مالهاش فلوس ولا بضاعة في الفترة
  const [olds2, scrapOnAccount, feesOnAccount] = await Promise.all([
    prisma.oldBattery.findMany({
      where: range
        ? { OR: [{ receivedAt: range }, { sortedAt: range }, { sentAt: range }, { replacementAt: range }, { deliveredAt: range }] }
        : undefined,
      include: {
        product: { select: { name: true } },
        supplier: { select: { name: true } },
        salesInvoice: { select: { number: true } },
        replacementProduct: { select: { name: true } },
      },
    }),
    prisma.scrapSale.findMany({
      where: { settlement: { not: 'CASH' }, ...(range ? { saleDate: range } : {}) },
      include: { supplier: { select: { name: true } }, purchaseInvoice: { select: { number: true } } },
    }),
    prisma.purchaseReturn.findMany({
      where: { consumptionFee: { gt: 0 }, feeSettlement: 'BALANCE', ...(range ? { returnDate: range } : {}) },
      include: { supplier: { select: { name: true } } },
    }),
  ]);
  const inRange = (d: Date | null) => !!d && (!range || ((!range.gte || d >= range.gte) && (!range.lte || d <= range.lte)));
  const add = (key: string, date: Date, init: Partial<JournalRow>) => rowFor(key, date, init);
  for (const b of olds2) {
    const what = b.product?.name || b.label || 'بطارية';
    const owner = b.ownership === 'CUSTOMER' ? `ملك ${b.customerName}` : 'ملك المحل';
    if (inRange(b.receivedAt)) {
      add(`ob:${b.id}:in`, b.receivedAt, {
        kind: 'استلام بطارية قديمة', group: 'oldBatteries', reference: b.number, party: b.customerName,
        value: b.intakeValue || null, description: `${SOURCE_LABEL[b.source] || b.source}${b.salesInvoice ? ` ${b.salesInvoice.number}` : ''} · ${what} · ${owner}`,
      });
    }
    if (b.sortedAt && inRange(b.sortedAt) && b.decision !== 'PENDING' && b.source !== 'WARRANTY_WAIT') {
      add(`ob:${b.id}:sort`, b.sortedAt, {
        kind: 'فرز بطارية', group: 'oldBatteries', reference: b.number,
        description: `${what} → ${DECISION_LABEL[b.decision] || b.decision}${b.condition ? ` · ${b.condition === 'GOOD' ? 'سليمة' : 'بايظة'}` : ''}`,
      });
    }
    if (b.sentAt && inRange(b.sentAt)) {
      add(`ob:${b.id}:sent`, b.sentAt, {
        kind: 'إرسال ضمان للمورد', group: 'oldBatteries', reference: b.number, party: b.supplier?.name || null,
        description: `${what} · ${owner}${b.receiverName ? ` · المستلم ${b.receiverName}` : ''}`,
      });
    }
    if (b.replacementAt && inRange(b.replacementAt) && (b.ownership === 'CUSTOMER' || b.feeSettlement === 'BALANCE')) {
      add(`ob:${b.id}:rcv`, b.replacementAt, {
        kind: b.ownership === 'CUSTOMER' ? 'وصل بديل ضمان زبون' : 'استهلاك ضمان على حساب المورد',
        group: 'oldBatteries', reference: b.number, party: b.supplier?.name || null,
        value: b.consumptionFee || null,
        description: `${b.replacementProduct?.name || what}${b.consumptionFee > 0 ? ` · استهلاك ${b.consumptionFee}` : ''}`,
      });
    }
    if (b.deliveredAt && inRange(b.deliveredAt)) {
      add(`ob:${b.id}:dlv`, b.deliveredAt, { kind: 'تسليم بديل للزبون', group: 'oldBatteries', reference: b.number, party: b.customerName, description: what });
    }
  }
  for (const s of scrapOnAccount) {
    const row = add(`ref:${s.number}`, s.saleDate, { reference: s.number });
    Object.assign(row, {
      kind: 'بيع خردة', group: 'scrap', party: s.supplier.name, value: s.amount,
      description: `${s.netKg} كجم · ${s.settlement === 'INVOICE' ? `مخصومة من فاتورة ${s.purchaseInvoice?.number || ''}` : 'خصم من حساب المورد'}`,
    });
  }
  for (const r of feesOnAccount) {
    add(`prfee:${r.id}`, r.returnDate, {
      kind: 'استهلاك مرتجع شراء', group: 'returns', reference: r.number, party: r.supplier.name,
      value: r.consumptionFee, description: 'على حساب المورد',
    });
  }

  const list = [...rows.values()]
    .map((r) => ({ ...r, cashIn: round(r.cashIn), cashOut: round(r.cashOut), goodsIn: round(r.goodsIn), goodsOut: round(r.goodsOut) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byKind = new Map<string, { kind: string; count: number; cashIn: number; cashOut: number; goodsIn: number; goodsOut: number; value: number }>();
  for (const r of list) {
    const k = byKind.get(r.kind) || { kind: r.kind, count: 0, cashIn: 0, cashOut: 0, goodsIn: 0, goodsOut: 0, value: 0 };
    k.count += 1;
    k.cashIn += r.cashIn;
    k.cashOut += r.cashOut;
    k.goodsIn += r.goodsIn;
    k.goodsOut += r.goodsOut;
    k.value += r.value || 0;
    byKind.set(r.kind, k);
  }
  const totals = {
    cashIn: round(list.reduce((s, r) => s + r.cashIn, 0)),
    cashOut: round(list.reduce((s, r) => s + r.cashOut, 0)),
    goodsIn: round(list.reduce((s, r) => s + r.goodsIn, 0)),
    goodsOut: round(list.reduce((s, r) => s + r.goodsOut, 0)),
    count: list.length,
  };
  return {
    rows: list,
    totals: { ...totals, cashNet: round(totals.cashIn - totals.cashOut), goodsNet: round(totals.goodsIn - totals.goodsOut) },
    byKind: [...byKind.values()].map((k) => ({ ...k, cashIn: round(k.cashIn), cashOut: round(k.cashOut), goodsIn: round(k.goodsIn), goodsOut: round(k.goodsOut), value: round(k.value) })),
  };
}

/** تقرير البطاريات القديمة: دخل كام، اتفرز إزاي، الضمان فين، والخردة اتباعت بكام وكسبت كام */
export async function oldBatteriesReport(prisma: PrismaService, range: Range) {
  const inRange = (d: Date | null) => !!d && (!range || ((!range.gte || d >= range.gte) && (!range.lte || d <= range.lte)));
  const [all, scrapSales] = await Promise.all([
    prisma.oldBattery.findMany({
      include: {
        product: { select: { name: true } },
        supplier: { select: { id: true, name: true } },
        stockProduct: { select: { name: true } },
        replacementProduct: { select: { name: true } },
      },
    }),
    prisma.scrapSale.findMany({
      where: range ? { saleDate: range } : undefined,
      include: { supplier: { select: { name: true } }, oldBatteries: { select: { intakeValue: true } } },
      orderBy: { saleDate: 'asc' },
    }),
  ]);
  const now = Date.now();
  const intake = all.filter((b) => inRange(b.receivedAt));
  const bySource = (source: string) => {
    const rows = intake.filter((b) => b.source === source);
    return { count: rows.length, value: round(rows.reduce((s, b) => s + b.intakeValue, 0)) };
  };
  const sorted = all.filter((b) => b.sortedAt && inRange(b.sortedAt) && b.decision !== 'PENDING');
  const byDecision = (d: string[]) => sorted.filter((b) => d.includes(b.decision)).length;
  const replaced = all.filter((b) => b.replacementAt && inRange(b.replacementAt) && (b.claimStatus === 'RECEIVED' || b.claimStatus === 'DELIVERED'));
  const shopReplaced = replaced.filter((b) => b.ownership === 'SHOP');

  const pendingClaims = all.filter((b) => b.decision === 'WARRANTY' && b.claimStatus === 'SENT');
  const bySupplier = new Map<string, { supplier: string; count: number; oldestDays: number; shop: number; customer: number }>();
  for (const b of pendingClaims) {
    const key = b.supplier?.id || 'none';
    const row = bySupplier.get(key) || { supplier: b.supplier?.name || '—', count: 0, oldestDays: 0, shop: 0, customer: 0 };
    row.count += 1;
    if (b.ownership === 'SHOP') row.shop += 1;
    else row.customer += 1;
    if (b.sentAt) row.oldestDays = Math.max(row.oldestDays, Math.floor((now - b.sentAt.getTime()) / 86400000));
    bySupplier.set(key, row);
  }

  const scrapRows = scrapSales.map((s) => {
    const cost = round(s.oldBatteries.reduce((x, b) => x + b.intakeValue, 0));
    return {
      number: s.number, date: s.saleDate, supplier: s.supplier.name, netKg: s.netKg, amount: s.amount,
      batteries: s.oldBatteries.length, cost, profit: round(s.amount - cost), settlement: s.settlement,
    };
  });
  const pile = all.filter((b) => b.decision === 'SCRAP' && !b.scrapSaleId);

  return {
    intake: {
      count: intake.length,
      value: round(intake.reduce((s, b) => s + b.intakeValue, 0)),
      saleScrap: bySource('SALE_SCRAP'),
      warrantySwap: bySource('WARRANTY_SWAP'),
      warrantyWait: bySource('WARRANTY_WAIT'),
      manual: bySource('MANUAL'),
    },
    sorted: {
      count: sorted.length,
      scrap: byDecision(['SCRAP']),
      used: byDecision(['USED', 'SERVICE']),
      warranty: byDecision(['WARRANTY']),
    },
    now: {
      toSort: all.filter((b) => b.decision === 'PENDING').length,
      scrapPile: pile.length,
      scrapPileValue: round(pile.reduce((s, b) => s + b.intakeValue, 0)),
      scrapPileKg: round(pile.reduce((s, b) => s + (b.weightKg || 0), 0)),
      usedInStock: all.filter((b) => b.decision === 'USED' || b.decision === 'SERVICE').length,
      warrantyInShop: all.filter((b) => b.decision === 'WARRANTY' && b.claimStatus === 'IN_SHOP').length,
      warrantyWithSupplier: pendingClaims.length,
      customerWaitingPickup: all.filter((b) => b.ownership === 'CUSTOMER' && b.claimStatus === 'RECEIVED').length,
      rejected: all.filter((b) => b.claimStatus === 'REJECTED').length,
    },
    warranty: {
      sent: all.filter((b) => b.sentAt && inRange(b.sentAt)).length,
      replaced: replaced.length,
      shopReplaced: shopReplaced.length,
      fees: round(replaced.reduce((s, b) => s + b.consumptionFee, 0)),
      replacementCost: round(shopReplaced.reduce((s, b) => s + b.intakeValue + b.consumptionFee, 0)),
      delivered: all.filter((b) => b.deliveredAt && inRange(b.deliveredAt)).length,
      pendingBySupplier: [...bySupplier.values()].sort((a, b) => b.oldestDays - a.oldestDays),
    },
    scrapSales: {
      count: scrapRows.length,
      netKg: round(scrapRows.reduce((s, r) => s + r.netKg, 0)),
      revenue: round(scrapRows.reduce((s, r) => s + r.amount, 0)),
      cost: round(scrapRows.reduce((s, r) => s + r.cost, 0)),
      profit: round(scrapRows.reduce((s, r) => s + r.profit, 0)),
      rows: scrapRows,
    },
  };
}
