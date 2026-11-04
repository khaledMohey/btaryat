import { replayFifo } from '../apps/api/src/common/fifo';

const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
const movements = [
  { id: 'm1', productId: 'P', warehouseId: 'A', type: 'PURCHASE', quantity: 10, unitCost: 100, reference: 'PUR-1', note: null, createdAt: t(1) },
  { id: 'm2', productId: 'P', warehouseId: 'A', type: 'PURCHASE', quantity: 5, unitCost: 120, reference: 'PUR-2', note: null, createdAt: t(2) },
  { id: 'm3', productId: 'P', warehouseId: 'A', type: 'SALE', quantity: -12, unitCost: 120, reference: 'SAL-1', note: null, createdAt: t(3) },
  { id: 'm4', productId: 'P', warehouseId: 'A', type: 'TRANSFER_OUT', quantity: -2, unitCost: 0, reference: 'TR-1', note: null, createdAt: t(4) },
  { id: 'm5', productId: 'P', warehouseId: 'B', type: 'TRANSFER_IN', quantity: 2, unitCost: 0, reference: 'TR-1', note: null, createdAt: t(4) },
  { id: 'm6', productId: 'P', warehouseId: 'B', type: 'SALE', quantity: -1, unitCost: 0, reference: 'SAL-2', note: null, createdAt: t(5) },
];
const db = {
  product: { findMany: async () => [{ id: 'P', costPrice: 120 }] },
  stockBalance: { findMany: async () => [{ productId: 'P', warehouseId: 'A', quantity: 1 }, { productId: 'P', warehouseId: 'B', quantity: 1 }] },
  stockMovement: { findMany: async () => movements },
} as any;

(async () => {
  const res = (await replayFifo(db, ['P'])).get('P')!;
  for (const out of res.outs) {
    console.log(out.reference, out.type, 'qty', out.quantity, 'cost', out.unitCost,
      out.allocations.map((a) => `${a.quantity}@${a.unitCost} from ${a.reference}${a.viaTransfer ? ' via ' + a.viaTransfer : ''}`).join(' + '));
  }
  for (const l of res.layers) console.log('layer', l.warehouseId, l.reference, l.viaTransfer || '', 'qty', l.quantity, 'left', l.remaining, '@', l.unitCost);
  const sale1 = res.outs.find((o) => o.reference === 'SAL-1')!;
  const expected = (10 * 100 + 2 * 120) / 12;
  if (Math.abs(sale1.unitCost - Math.round(expected * 10000) / 10000) > 0.0001) throw new Error('SAL-1 cost wrong');
  const sale2 = res.outs.find((o) => o.reference === 'SAL-2')!;
  if (sale2.unitCost !== 120) throw new Error('SAL-2 cost wrong');
  console.log('OK');
})();
