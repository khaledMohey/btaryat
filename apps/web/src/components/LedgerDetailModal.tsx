import { api, formatDate, formatMoney } from '../lib/api';
import { useEffect, useState } from 'react';
import { Badge, Empty, Modal, Table, Td, Th } from './ui';

export type LedgerKind =
  | 'purchase'
  | 'payment'
  | 'purchase_return'
  | 'restock'
  | 'scrap'
  | 'warranty'
  | 'sale'
  | 'discount'
  | 'receipt'
  | 'sales_return';

type Props = {
  open: boolean;
  onClose: () => void;
  party: 'supplier' | 'customer';
  kind?: LedgerKind | string | null;
  id?: string | null;
  title?: string;
};

export function LedgerDetailModal({ open, onClose, party, kind, id, title }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    if (!open || !kind || !id) {
      setData(null);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    const path = party === 'supplier'
      ? `/suppliers/movements/${kind}/${id}`
      : `/customers/movements/${kind}/${id}`;
    api(path)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'تعذر تحميل التفاصيل'))
      .finally(() => setLoading(false));
  }, [open, party, kind, id]);

  const row = data?.row;
  const restocks = data?.restocks as any[] | undefined;

  return (
    <Modal open={open} onClose={onClose} title={title || 'تفاصيل الحركة'} wide>
      {loading && <div className="text-sm text-muted">جاري التحميل...</div>}
      {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {!loading && !error && !row && <Empty text="لا توجد تفاصيل" />}
      {!loading && row && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-slate-50 p-3">
              <div className="text-xs text-muted">الرقم</div>
              <div className="font-mono font-bold" dir="ltr">{row.number}</div>
            </div>
            {'invoiceDate' in row && (
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-muted">التاريخ</div>
                <div className="font-bold">{formatDate(row.invoiceDate)}</div>
              </div>
            )}
            {'returnDate' in row && (
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-muted">التاريخ</div>
                <div className="font-bold">{formatDate(row.returnDate)}</div>
              </div>
            )}
            {'paidAt' in row && (
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-muted">التاريخ</div>
                <div className="font-bold">{formatDate(row.paidAt)}</div>
              </div>
            )}
            {'receivedAt' in row && (
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-muted">التاريخ</div>
                <div className="font-bold">{formatDate(row.receivedAt)}</div>
              </div>
            )}
            {row.supplier?.name && (
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-muted">المورد</div>
                <div className="font-bold">{row.supplier.name}</div>
              </div>
            )}
            {row.customer?.name && (
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-muted">العميل</div>
                <div className="font-bold">{row.customer.name}</div>
              </div>
            )}
            {row.warehouse?.name && (
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-muted">المخزن</div>
                <div className="font-bold">{row.warehouse.name}</div>
              </div>
            )}
            {typeof row.total === 'number' && (
              <div className="rounded-xl bg-brand-50 p-3">
                <div className="text-xs text-brand-700">الإجمالي</div>
                <div className="text-lg font-extrabold text-brand-800">{formatMoney(row.total)}</div>
              </div>
            )}
            {typeof row.amount === 'number' && (
              <div className="rounded-xl bg-brand-50 p-3">
                <div className="text-xs text-brand-700">المبلغ</div>
                <div className="text-lg font-extrabold text-brand-800">{formatMoney(row.amount)}</div>
              </div>
            )}
            {row.status && <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-muted">الحالة</div><Badge>{row.status}</Badge></div>}
            {row.cashAccount?.name && (
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-muted">الحساب</div>
                <div className="font-bold">{row.cashAccount.name}</div>
              </div>
            )}
            {row.purchaseInvoice?.number && (
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-muted">فاتورة الشراء</div>
                <div className="font-mono font-bold" dir="ltr">{row.purchaseInvoice.number}</div>
              </div>
            )}
            {row.salesInvoice?.number && (
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-muted">فاتورة البيع</div>
                <div className="font-mono font-bold" dir="ltr">{row.salesInvoice.number}</div>
              </div>
            )}
          </div>

          {Array.isArray(row.lines) && row.lines.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>الصنف</Th>
                  <Th>الكمية</Th>
                  {'unitCost' in (row.lines[0] || {}) && <Th>التكلفة</Th>}
                  {'unitPrice' in (row.lines[0] || {}) && <Th>السعر</Th>}
                  {'restockedQty' in (row.lines[0] || {}) && <Th>مستلم بديل</Th>}
                  <Th>الإجمالي</Th>
                </tr>
              </thead>
              <tbody>
                {row.lines.map((line: any, i: number) => (
                  <tr key={line.id || i}>
                    <Td className="font-semibold">{line.product?.name || '—'}</Td>
                    <Td className="tabular-nums">{line.quantity}</Td>
                    {'unitCost' in line && <Td className="tabular-nums">{formatMoney(line.unitCost || 0)}</Td>}
                    {'unitPrice' in line && <Td className="tabular-nums">{formatMoney(line.unitPrice || 0)}</Td>}
                    {'restockedQty' in line && <Td className="tabular-nums">{line.restockedQty || 0}</Td>}
                    <Td className="font-bold tabular-nums">{formatMoney(line.total || 0)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          {kind === 'restock' || (restocks && restocks.length > 0) ? (
            <div>
              <div className="mb-2 font-bold text-slate-800">حركات الاستلام البديل</div>
              {!restocks?.length ? <Empty text="لا يوجد استلام بديل بعد" /> : (
                <Table>
                  <thead>
                    <tr>
                      <Th>التاريخ</Th>
                      <Th>الصنف</Th>
                      <Th>المخزن</Th>
                      <Th>الكمية</Th>
                      <Th>التكلفة</Th>
                      <Th>الإجمالي</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {restocks.map((mov) => (
                      <tr key={mov.id}>
                        <Td className="whitespace-nowrap">{formatDate(mov.createdAt)}</Td>
                        <Td className="font-semibold">{mov.product?.name}</Td>
                        <Td>{mov.warehouse?.name}</Td>
                        <Td className="tabular-nums">{mov.quantity}</Td>
                        <Td className="tabular-nums">{formatMoney(mov.unitCost || 0)}</Td>
                        <Td className="font-bold tabular-nums">{formatMoney((mov.quantity || 0) * (mov.unitCost || 0))}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          ) : null}

          {kind === 'warranty' && (
            <div className="grid gap-3 rounded-xl border border-brand-200 bg-brand-50/50 p-3 text-sm sm:grid-cols-2">
              <div>البطارية: <b>{row.product?.name || row.label || '—'}</b></div>
              <div>صاحبها: <b>{row.ownership === 'SHOP' ? 'المحل' : row.customerName}</b></div>
              <div>اتبعتت: <b>{row.sentAt ? formatDate(row.sentAt) : '—'}</b>{row.receiverName ? ` · المستلم ${row.receiverName}` : ''}</div>
              <div>وصل البديل: <b>{row.replacementAt ? formatDate(row.replacementAt) : '—'}</b>{row.replacementProduct ? ` · ${row.replacementProduct.name}` : ''}</div>
              <div>الاستهلاك: <b>{formatMoney(row.consumptionFee || 0)}</b> · {row.feeSettlement === 'CASH' ? 'اتدفع فوري' : 'على الحساب'}</div>
              {row.ownership === 'SHOP' && <div>تكلفة البديل: <b>{formatMoney((row.intakeValue || 0) + (row.consumptionFee || 0))}</b></div>}
            </div>
          )}
          {kind === 'purchase' && (row.scrapAmount || 0) > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3 text-sm">
              خردة مبيعة للمورد ومخصومة من الفاتورة: <b>{formatMoney(row.scrapAmount)}</b>
              {' · '}الإجمالي قبل الخصم {formatMoney((row.total || 0) + (row.scrapAmount || 0))}
            </div>
          )}
          {kind === 'scrap' && (
            <div className="grid gap-3 rounded-xl border border-amber-200 bg-amber-50/50 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>التاريخ: <b>{formatDate(row.saleDate)}</b></div>
              <div>الوزن القائم: <b>{row.grossKg} كجم</b></div>
              <div>{row.withWater ? `بمياه (خصم ${row.waterPercent}%)` : 'بدون مياه'}</div>
              <div>الوزن الصافي: <b>{row.netKg} كجم</b></div>
              <div>سعر الكيلو: <b>{formatMoney(row.priceKg)}</b></div>
              <div className="sm:col-span-3">
                التسوية: <b>{row.settlement === 'INVOICE' ? `مخصومة من فاتورة ${row.purchaseInvoice?.number || ''}` : row.settlement === 'CASH' ? 'استلام فلوس' : 'خصم من حساب المورد'}</b>
              </div>
            </div>
          )}
          {row.notes && <div className="text-sm text-muted">ملاحظات: {row.notes}</div>}
          {row.note && <div className="text-sm text-muted">ملاحظات: {row.note}</div>}
          {row.customerName && <div className="text-sm text-muted">اسم العميل: {row.customerName}</div>}
          {(row.consumptionAmount || 0) > 0 && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 text-sm">
              استهلاك: <b>{formatMoney(row.consumptionAmount)}</b>
              {row.cashAccount ? ` · ${row.cashAccount.name}` : ''}
            </div>
          )}
          {row.giveReplacement && (
            <div className="rounded-xl border border-brand-200 bg-brand-50/50 p-3 text-sm">
              استبدال: {row.replacementProduct?.name || '—'}
              {row.replacementWarehouse ? ` من ${row.replacementWarehouse.name}` : ''}
              {(row.replacementQty || 0) > 0 ? ` · كمية ${row.replacementQty}` : ''}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
