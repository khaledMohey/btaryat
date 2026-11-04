import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** نسبة المياه اللي بتتخصم من وزن الخردة المبلولة */
export const WATER_PERCENT = 15;

export type ScrapInput = { withWater?: boolean; grossKg?: number; priceKg?: number; notes?: string | null };

export function scrapCalc(input?: ScrapInput | null) {
  const grossKg = Math.max(0, Number(input?.grossKg) || 0);
  const priceKg = Math.max(0, Number(input?.priceKg) || 0);
  const withWater = !!input?.withWater;
  const waterPercent = withWater ? WATER_PERCENT : 0;
  const netKg = Math.round(grossKg * (1 - waterPercent / 100) * 1000) / 1000;
  const amount = Math.round(netKg * priceKg * 100) / 100;
  return { withWater, waterPercent, grossKg, netKg, priceKg, amount };
}

export type ScrapCalc = ReturnType<typeof scrapCalc>;

/** خردة جوه فاتورة شراء: سجل بيع خردة مربوط بالفاتورة (أو يتشال لو مفيش خردة) */
export async function syncInvoiceScrap(tx: Tx, opts: {
  purchaseInvoiceId: string;
  supplierId: string;
  saleDate: Date;
  calc: ScrapCalc;
  number?: string;
  notes?: string | null;
}) {
  const existing = await tx.scrapSale.findUnique({ where: { purchaseInvoiceId: opts.purchaseInvoiceId } });
  if (opts.calc.amount <= 0.009) {
    if (existing) await tx.scrapSale.delete({ where: { id: existing.id } });
    return null;
  }
  const data = {
    supplierId: opts.supplierId,
    saleDate: opts.saleDate,
    withWater: opts.calc.withWater,
    waterPercent: opts.calc.waterPercent,
    grossKg: opts.calc.grossKg,
    netKg: opts.calc.netKg,
    priceKg: opts.calc.priceKg,
    amount: opts.calc.amount,
    settlement: 'INVOICE',
    cashAccountId: null,
    paymentMethod: '',
    ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
  };
  if (existing) return tx.scrapSale.update({ where: { id: existing.id }, data });
  if (!opts.number) throw new Error('scrap number missing');
  return tx.scrapSale.create({ data: { ...data, number: opts.number, purchaseInvoiceId: opts.purchaseInvoiceId } });
}
