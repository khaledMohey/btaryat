import { Prisma, PrismaClient, StockMovement, StockMovementType } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

const EPS = 0.0001;
const CHUNK = 300;

export type LayerSource = StockMovementType | 'OPENING';

export type FifoConsumption = {
  movementId: string | null;
  type: StockMovementType | 'TRIM';
  reference: string | null;
  date: Date;
  quantity: number;
};

export type FifoLayer = {
  key: string;
  movementId: string | null;
  warehouseId: string;
  type: LayerSource;
  /** مرجع المستند اللي دخّل الدفعة (فاتورة شراء / مرتجع / تسوية…) */
  reference: string | null;
  /** لو الدفعة جاية بتحويل: رقم التحويل */
  viaTransfer: string | null;
  note: string | null;
  date: Date;
  unitCost: number;
  quantity: number;
  remaining: number;
  consumed: FifoConsumption[];
};

export type FifoAllocation = {
  layerKey: string | null;
  type: LayerSource | 'NONE';
  reference: string | null;
  viaTransfer: string | null;
  date: Date;
  unitCost: number;
  quantity: number;
  /** كمية اتسحبت من غير دفعة مسجلة — اتحسبت بتكلفة الصنف الحالية */
  fallback?: boolean;
};

export type FifoOut = {
  movementId: string;
  productId: string;
  warehouseId: string;
  type: StockMovementType;
  reference: string | null;
  quantity: number;
  storedCost: number;
  unitCost: number;
  allocations: FifoAllocation[];
  createdAt: Date;
};

export type FifoProduct = {
  productId: string;
  layers: FifoLayer[];
  outs: FifoOut[];
};

function round4(value: number) {
  return Math.round(value * 10000) / 10000;
}

function chunks<T>(rows: T[], size = CHUNK) {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const ORDER: Partial<Record<StockMovementType, number>> = {
  [StockMovementType.TRANSFER_OUT]: 0,
  [StockMovementType.TRANSFER_IN]: 2,
};

function insertByDate(list: FifoLayer[], layer: FifoLayer) {
  let i = list.length;
  while (i > 0 && list[i - 1].date.getTime() > layer.date.getTime()) i -= 1;
  list.splice(i, 0, layer);
}

function consume(
  list: FifoLayer[],
  quantity: number,
  fallbackCost: number,
  meta: Omit<FifoConsumption, 'quantity'>,
): FifoAllocation[] {
  let left = quantity;
  const out: FifoAllocation[] = [];
  for (const layer of list) {
    if (left <= EPS) break;
    if (layer.remaining <= EPS) continue;
    const take = Math.min(layer.remaining, left);
    layer.remaining = round4(layer.remaining - take);
    left = round4(left - take);
    layer.consumed.push({ ...meta, quantity: take });
    out.push({
      layerKey: layer.key,
      type: layer.type,
      reference: layer.reference,
      viaTransfer: layer.viaTransfer,
      date: layer.date,
      unitCost: layer.unitCost,
      quantity: take,
    });
  }
  if (left > EPS) {
    out.push({
      layerKey: null,
      type: 'NONE',
      reference: null,
      viaTransfer: null,
      date: meta.date,
      unitCost: fallbackCost,
      quantity: left,
      fallback: true,
    });
  }
  return out;
}

function weighted(allocations: FifoAllocation[]) {
  const qty = allocations.reduce((s, a) => s + a.quantity, 0);
  if (qty <= EPS) return 0;
  return round4(allocations.reduce((s, a) => s + a.quantity * a.unitCost, 0) / qty);
}

/**
 * FIFO بإعادة تشغيل حركات المخزون بالترتيب:
 * كل حركة داخلة = دفعة بتكلفتها، وكل حركة خارجة تسحب من أقدم دفعة في نفس المخزن.
 */
export async function replayFifo(db: Db, productIds: string[], opts: { excludeReference?: string } = {}) {
  const ids = [...new Set(productIds.filter(Boolean))];
  const result = new Map<string, FifoProduct>();
  if (!ids.length) return result;

  const products: { id: string; costPrice: number }[] = [];
  const balances: { productId: string; warehouseId: string; quantity: number }[] = [];
  const movements: StockMovement[] = [];
  for (const part of chunks(ids)) {
    const [p, b, m] = await Promise.all([
      db.product.findMany({ where: { id: { in: part } }, select: { id: true, costPrice: true } }),
      db.stockBalance.findMany({ where: { productId: { in: part } }, select: { productId: true, warehouseId: true, quantity: true } }),
      db.stockMovement.findMany({ where: { productId: { in: part } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    ]);
    products.push(...p);
    balances.push(...b);
    movements.push(...m);
  }

  const costOf = new Map(products.map((p) => [p.id, p.costPrice || 0]));
  const movesByProduct = new Map<string, typeof movements>();
  for (const mov of movements) {
    const list = movesByProduct.get(mov.productId) || [];
    list.push(mov);
    movesByProduct.set(mov.productId, list);
  }

  for (const productId of ids) {
    const fallbackCost = costOf.get(productId) || 0;
    const moves = (movesByProduct.get(productId) || []).slice().sort((a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime()
      || (ORDER[a.type] ?? 1) - (ORDER[b.type] ?? 1)
      || a.id.localeCompare(b.id),
    );
    const layersByWh = new Map<string, FifoLayer[]>();
    const allLayers: FifoLayer[] = [];
    const outs: FifoOut[] = [];
    const pendingTransfers = new Map<string, FifoAllocation[]>();
    const whList = (wh: string) => {
      let list = layersByWh.get(wh);
      if (!list) {
        list = [];
        layersByWh.set(wh, list);
      }
      return list;
    };

    const movedByWh = new Map<string, number>();
    for (const mov of moves) movedByWh.set(mov.warehouseId, (movedByWh.get(mov.warehouseId) || 0) + mov.quantity);
    for (const bal of balances.filter((row) => row.productId === productId)) {
      const opening = round4(bal.quantity - (movedByWh.get(bal.warehouseId) || 0));
      if (opening > EPS) {
        const layer: FifoLayer = {
          key: `opening:${bal.warehouseId}`,
          movementId: null,
          warehouseId: bal.warehouseId,
          type: 'OPENING',
          reference: null,
          viaTransfer: null,
          note: 'رصيد سابق بدون حركة مسجلة',
          date: new Date(0),
          unitCost: fallbackCost,
          quantity: opening,
          remaining: opening,
          consumed: [],
        };
        whList(bal.warehouseId).push(layer);
        allLayers.push(layer);
      }
    }

    for (const mov of moves) {
      if (Math.abs(mov.quantity) <= EPS) continue;
      if (opts.excludeReference && mov.reference === opts.excludeReference) continue;
      if (mov.quantity > 0) {
        if (mov.type === StockMovementType.TRANSFER_IN) {
          let left = mov.quantity;
          const carried = pendingTransfers.get(mov.reference || '') || [];
          let piece = 0;
          while (left > EPS && carried.length) {
            const head = carried[0];
            const take = Math.min(head.quantity, left);
            const layer: FifoLayer = {
              key: `${mov.id}:${piece++}`,
              movementId: mov.id,
              warehouseId: mov.warehouseId,
              type: head.type === 'NONE' ? StockMovementType.TRANSFER_IN : head.type,
              reference: head.reference,
              viaTransfer: mov.reference,
              note: mov.note,
              date: head.type === 'NONE' ? mov.createdAt : head.date,
              unitCost: head.unitCost,
              quantity: take,
              remaining: take,
              consumed: [],
            };
            insertByDate(whList(mov.warehouseId), layer);
            allLayers.push(layer);
            head.quantity = round4(head.quantity - take);
            left = round4(left - take);
            if (head.quantity <= EPS) carried.shift();
          }
          if (left > EPS) {
            const layer: FifoLayer = {
              key: `${mov.id}:${piece++}`,
              movementId: mov.id,
              warehouseId: mov.warehouseId,
              type: StockMovementType.TRANSFER_IN,
              reference: mov.reference,
              viaTransfer: mov.reference,
              note: mov.note,
              date: mov.createdAt,
              unitCost: mov.unitCost > 0 ? mov.unitCost : fallbackCost,
              quantity: left,
              remaining: left,
              consumed: [],
            };
            insertByDate(whList(mov.warehouseId), layer);
            allLayers.push(layer);
          }
          continue;
        }
        const layer: FifoLayer = {
          key: mov.id,
          movementId: mov.id,
          warehouseId: mov.warehouseId,
          type: mov.type,
          reference: mov.reference,
          viaTransfer: null,
          note: mov.note,
          date: mov.createdAt,
          unitCost: mov.unitCost > 0 ? mov.unitCost : fallbackCost,
          quantity: mov.quantity,
          remaining: mov.quantity,
          consumed: [],
        };
        insertByDate(whList(mov.warehouseId), layer);
        allLayers.push(layer);
        continue;
      }

      const qty = -mov.quantity;
      const allocations = consume(whList(mov.warehouseId), qty, fallbackCost, {
        movementId: mov.id,
        type: mov.type,
        reference: mov.reference,
        date: mov.createdAt,
      });
      if (mov.type === StockMovementType.TRANSFER_OUT) {
        const list = pendingTransfers.get(mov.reference || '') || [];
        list.push(...allocations.map((a) => ({ ...a })));
        pendingTransfers.set(mov.reference || '', list);
      }
      outs.push({
        movementId: mov.id,
        productId,
        warehouseId: mov.warehouseId,
        type: mov.type,
        reference: mov.reference,
        quantity: qty,
        storedCost: mov.unitCost,
        unitCost: weighted(allocations),
        allocations,
        createdAt: mov.createdAt,
      });
    }

    // لو الحركات المسجلة أكبر من الرصيد الفعلي: اسحب الفرق من الأقدم
    for (const bal of opts.excludeReference ? [] : balances.filter((row) => row.productId === productId)) {
      const list = whList(bal.warehouseId);
      const left = round4(list.reduce((s, l) => s + l.remaining, 0));
      const excess = round4(left - Math.max(0, bal.quantity));
      if (excess > EPS) {
        consume(list, excess, fallbackCost, { movementId: null, type: 'TRIM', reference: null, date: new Date() });
      }
    }

    result.set(productId, { productId, layers: allLayers, outs });
  }
  return result;
}

/**
 * معاينة قبل البيع: الكمية دي هتتسحب من أنهي دفعات وبكام.
 * lines بالترتيب — نفس الصنف في أكتر من بند بيكمّل من بعد البند اللي قبله.
 */
export async function previewFifo(db: Db, opts: {
  warehouseId: string;
  lines: { productId: string; quantity: number }[];
  excludeReference?: string;
}) {
  const replay = await replayFifo(db, opts.lines.map((l) => l.productId), { excludeReference: opts.excludeReference });
  const pools = new Map<string, FifoLayer[]>();
  const poolOf = (productId: string) => {
    let pool = pools.get(productId);
    if (!pool) {
      pool = (replay.get(productId)?.layers || [])
        .filter((l) => l.warehouseId === opts.warehouseId && l.remaining > EPS)
        .map((l) => ({ ...l, consumed: [] }));
      pools.set(productId, pool);
    }
    return pool;
  };
  const fallback = new Map<string, number>();
  for (const p of await db.product.findMany({ where: { id: { in: [...new Set(opts.lines.map((l) => l.productId))] } }, select: { id: true, costPrice: true } })) {
    fallback.set(p.id, p.costPrice || 0);
  }
  return opts.lines.map((line) => {
    if (!line.productId || !(line.quantity > 0)) return { productId: line.productId, quantity: line.quantity, unitCost: 0, totalCost: 0, allocations: [], shortage: 0 };
    const allocations = consume(poolOf(line.productId), line.quantity, fallback.get(line.productId) || 0, {
      movementId: null,
      type: StockMovementType.SALE,
      reference: null,
      date: new Date(),
    });
    const totalCost = Math.round(allocations.reduce((s, a) => s + a.quantity * a.unitCost, 0) * 100) / 100;
    return {
      productId: line.productId,
      quantity: line.quantity,
      unitCost: weighted(allocations),
      totalCost,
      allocations,
      shortage: allocations.filter((a) => a.fallback).reduce((s, a) => s + a.quantity, 0),
    };
  });
}

type SaleLineRef = { id: string; productId: string; quantity: number; unitCost: number };

/** يربط حركات البيع (بنفس رقم الفاتورة) ببنود الفاتورة بالترتيب */
export function mapSaleLines(outs: FifoOut[], lines: SaleLineRef[]) {
  const byLine = new Map<string, { unitCost: number; allocations: FifoAllocation[] }>();
  const productIds = [...new Set(lines.map((l) => l.productId))];
  for (const productId of productIds) {
    const productLines = lines.filter((l) => l.productId === productId);
    const productOuts = outs.filter((o) => o.type === StockMovementType.SALE && o.productId === productId);
    if (!productOuts.length) continue;
    const sameShape = productOuts.length === productLines.length
      && productOuts.every((o, i) => Math.abs(o.quantity - productLines[i].quantity) <= EPS);
    if (sameShape) {
      productLines.forEach((line, i) => byLine.set(line.id, { unitCost: productOuts[i].unitCost, allocations: productOuts[i].allocations }));
      continue;
    }
    // توزيع السحب على البنود بالترتيب لما الشكل مختلف (تعديلات قديمة)
    const pool = productOuts.flatMap((o) => o.allocations.map((a) => ({ ...a })));
    for (const line of productLines) {
      let left = line.quantity;
      const taken: FifoAllocation[] = [];
      while (left > EPS && pool.length) {
        const head = pool[0];
        const take = Math.min(head.quantity, left);
        taken.push({ ...head, quantity: take });
        head.quantity = round4(head.quantity - take);
        left = round4(left - take);
        if (head.quantity <= EPS) pool.shift();
      }
      if (taken.length) byLine.set(line.id, { unitCost: weighted(taken), allocations: taken });
    }
  }
  return byLine;
}

/**
 * يعيد حساب تكلفة كل حركة خارجة وكل بند بيع بنظام FIFO ويحفظها.
 * آمن يتنادى بعد أي عملية مخزون — مش بيغيّر كميات.
 */
export async function recostProducts(db: PrismaClient, productIds: Iterable<string>) {
  const ids = [...new Set([...productIds].filter(Boolean))];
  if (!ids.length) return { products: 0, movements: 0, lines: 0 };
  try {
    const replay = await replayFifo(db, ids);
    let movementUpdates = 0;
    let lineUpdates = 0;

    const saleOutsByRef = new Map<string, Map<string, FifoOut[]>>();
    for (const res of replay.values()) {
      for (const out of res.outs) {
        if (Math.abs(out.unitCost - out.storedCost) > 0.00005) {
          await db.stockMovement.update({ where: { id: out.movementId }, data: { unitCost: out.unitCost } });
          movementUpdates += 1;
        }
        if (out.type === StockMovementType.SALE && out.reference) {
          const byProduct = saleOutsByRef.get(out.reference) || new Map<string, FifoOut[]>();
          const list = byProduct.get(res.productId) || [];
          list.push(out);
          byProduct.set(res.productId, list);
          saleOutsByRef.set(out.reference, byProduct);
        }
      }
    }

    const refs = [...saleOutsByRef.keys()];
    for (const part of chunks(refs)) {
      const invoices = await db.salesInvoice.findMany({
        where: { number: { in: part } },
        select: { number: true, lines: { where: { productId: { in: ids } }, orderBy: { id: 'asc' }, select: { id: true, productId: true, quantity: true, unitCost: true } } },
      });
      for (const inv of invoices) {
        const byProduct = saleOutsByRef.get(inv.number);
        if (!byProduct) continue;
        for (const [productId, outs] of byProduct) {
          const lines = inv.lines.filter((l) => l.productId === productId);
          const mapped = mapSaleLines(outs, lines);
          for (const line of lines) {
            const next = mapped.get(line.id);
            if (!next) continue;
            if (Math.abs(next.unitCost - line.unitCost) > 0.00005) {
              await db.salesInvoiceLine.update({ where: { id: line.id }, data: { unitCost: next.unitCost } });
              lineUpdates += 1;
            }
          }
        }
      }
    }
    return { products: ids.length, movements: movementUpdates, lines: lineUpdates };
  } catch (error) {
    console.error('FIFO recost failed', error);
    return { products: ids.length, movements: 0, lines: 0, error: true };
  }
}

/** كل الأصناف اللي ليها حركات — لإعادة الحساب الكاملة */
export async function recostAll(db: PrismaClient) {
  const rows = await db.stockMovement.findMany({ distinct: ['productId'], select: { productId: true } });
  let movements = 0;
  let lines = 0;
  for (const part of chunks(rows.map((r) => r.productId), 100)) {
    const res = await recostProducts(db, part);
    movements += res.movements;
    lines += res.lines;
  }
  return { products: rows.length, movements, lines };
}
