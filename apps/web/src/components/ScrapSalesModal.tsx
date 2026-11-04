import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import { useConfirm, useToast } from '../lib/feedback';
import { Badge, Button, Empty, Input, Label, Modal, NumberInput, Select, Table, Td, Th, todayIso } from './ui';
import type { PayMethodOption } from './TenderEditor';

export const SCRAP_WATER_PERCENT = 15;

export type Settlement = 'INVOICE' | 'CASH' | 'BALANCE';

type ScrapSale = {
  id: string;
  number: string;
  saleDate: string;
  withWater: boolean;
  waterPercent: number;
  grossKg: number;
  netKg: number;
  priceKg: number;
  amount: number;
  settlement: Settlement;
  purchaseInvoiceId: string | null;
  paymentMethod: string;
  notes: string | null;
  supplier: { id: string; name: string; code: string };
  purchaseInvoice: { id: string; number: string } | null;
  cashAccount: { id: string; name: string } | null;
};

type OpenInvoice = { id: string; number: string; invoiceDate: string; total: number; paidAmount: number; due: number };
type PileRow = { id: string; number: string; intakeValue: number; weightKg: number | null; label: string | null; receivedAt: string; scrapSaleId: string | null; product: { name: string } | null };

const SETTLEMENT_LABEL: Record<Settlement, string> = {
  INVOICE: 'خصم من فاتورة شراء',
  CASH: 'استلام فلوس',
  BALANCE: 'خصم من حساب المورد القديم',
};

const num = (v: number | '') => (v === '' ? 0 : Number(v) || 0);

export function scrapNumbers(grossKg: number, priceKg: number, withWater: boolean) {
  const netKg = Math.round(grossKg * (1 - (withWater ? SCRAP_WATER_PERCENT : 0) / 100) * 1000) / 1000;
  const amount = Math.round(netKg * priceKg * 100) / 100;
  return { netKg, amount };
}

/** اختيار بمياه / بدون مياه */
export function WaterToggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex rounded-xl bg-slate-100 p-1">
      {([[false, 'بدون مياه'], [true, `بمياه (−${SCRAP_WATER_PERCENT}%)`]] as const).map(([flag, label]) => (
        <button
          key={String(flag)}
          type="button"
          onClick={() => onChange(flag)}
          className={`h-8 flex-1 rounded-lg px-3 text-xs font-bold transition ${value === flag ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const emptyForm = () => ({
  supplierId: '',
  saleDate: todayIso(),
  withWater: false,
  grossKg: '' as number | '',
  priceKg: '' as number | '',
  settlement: 'BALANCE' as Settlement,
  purchaseInvoiceId: '',
  methodId: '',
  notes: '',
});

export function ScrapSalesModal({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged?: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<ScrapSale[]>([]);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string; code: string }[]>([]);
  const [methods, setMethods] = useState<PayMethodOption[]>([]);
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [editing, setEditing] = useState<ScrapSale | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pile, setPile] = useState<PileRow[]>([]);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    if (!formOpen) return;
    const qs = editing ? `?scrapId=${editing.id}` : '';
    api<PileRow[]>(`/scrap/pile${qs}`)
      .then((rows) => {
        setPile(rows);
        setPicked(editing ? rows.filter((r) => r.scrapSaleId === editing.id).map((r) => r.id) : rows.map((r) => r.id));
      })
      .catch(() => { setPile([]); setPicked([]); });
  }, [formOpen, editing?.id]);
  const pileCost = pile.filter((r) => picked.includes(r.id)).reduce((s, r) => s + r.intakeValue, 0);

  async function load() {
    setRows(await api<ScrapSale[]>('/scrap'));
  }

  useEffect(() => {
    if (!open) return;
    load().catch(() => setRows([]));
    api<typeof suppliers>('/scrap/suppliers').then(setSuppliers).catch(() => setSuppliers([]));
    api<PayMethodOption[]>('/cash/methods').then((m) => setMethods(m.filter((x) => x.kind === 'IMMEDIATE'))).catch(() => setMethods([]));
  }, [open]);

  useEffect(() => {
    if (!formOpen || !form.supplierId) {
      setInvoices([]);
      return;
    }
    const qs = new URLSearchParams({ supplierId: form.supplierId });
    if (editing) qs.set('scrapId', editing.id);
    api<OpenInvoice[]>(`/scrap/open-invoices?${qs}`).then(setInvoices).catch(() => setInvoices([]));
  }, [formOpen, form.supplierId, editing?.id]);

  const calc = useMemo(() => scrapNumbers(num(form.grossKg), num(form.priceKg), form.withWater), [form.grossKg, form.priceKg, form.withWater]);
  const chosenInvoice = invoices.find((i) => i.id === form.purchaseInvoiceId);

  function openNew() {
    setEditing(null);
    setForm({ ...emptyForm(), methodId: methods[0]?.id || '' });
    setError('');
    setFormOpen(true);
  }

  function openEdit(row: ScrapSale) {
    setEditing(row);
    setForm({
      supplierId: row.supplier.id,
      saleDate: row.saleDate.slice(0, 10),
      withWater: row.withWater,
      grossKg: row.grossKg,
      priceKg: row.priceKg,
      settlement: row.settlement,
      purchaseInvoiceId: row.purchaseInvoiceId || '',
      methodId: row.paymentMethod || methods[0]?.id || '',
      notes: row.notes || '',
    });
    setError('');
    setFormOpen(true);
  }

  async function save() {
    setError('');
    if (!form.supplierId) return setError('اختار المورد');
    if (num(form.grossKg) <= 0) return setError('أدخل وزن الخردة');
    if (num(form.priceKg) <= 0) return setError('أدخل سعر الكيلو');
    if (form.settlement === 'INVOICE' && !form.purchaseInvoiceId) return setError('اختار فاتورة الشراء');
    if (form.settlement === 'INVOICE' && chosenInvoice && calc.amount > chosenInvoice.due + 0.009) {
      return setError(`قيمة الخردة أكبر من المتبقي على الفاتورة (${formatMoney(chosenInvoice.due)})`);
    }
    if (form.settlement === 'CASH' && !form.methodId) return setError('اختار طريقة استلام الفلوس');
    setSaving(true);
    try {
      const body = JSON.stringify({
        supplierId: form.supplierId,
        saleDate: form.saleDate,
        withWater: form.withWater,
        grossKg: num(form.grossKg),
        priceKg: num(form.priceKg),
        settlement: form.settlement,
        purchaseInvoiceId: form.settlement === 'INVOICE' ? form.purchaseInvoiceId : undefined,
        methodId: form.settlement === 'CASH' ? form.methodId : undefined,
        notes: form.notes,
        oldBatteryIds: picked,
      });
      await api(editing ? `/scrap/${editing.id}` : '/scrap', { method: editing ? 'PATCH' : 'POST', body });
      toast.success(editing ? 'تم تعديل بيع الخردة' : 'تم تسجيل بيع الخردة');
      setFormOpen(false);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: ScrapSale) {
    const ok = await confirm({ title: 'حذف بيع الخردة', message: `حذف ${row.number} وعكس أثره على المورد/الخزنة؟`, confirmLabel: 'حذف', danger: true });
    if (!ok) return;
    try {
      await api(`/scrap/${row.id}`, { method: 'DELETE' });
      toast.success('تم الحذف');
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر الحذف');
    }
  }

  const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
  const totalKg = rows.reduce((s, r) => s + r.netKg, 0);

  return (
    <>
      <Modal open={open} onClose={onClose} title="بيع خردة للموردين" wide>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-muted">
              {rows.length} عملية · صافي {totalKg.toLocaleString('ar-EG')} كجم · {formatMoney(totalAmount)}
            </div>
            <Button onClick={openNew}><Plus size={16} /> بيع خردة</Button>
          </div>
          {rows.length === 0 ? <Empty text="مفيش مبيعات خردة لسه" /> : (
            <Table>
              <thead>
                <tr>
                  <Th>الرقم</Th>
                  <Th>التاريخ</Th>
                  <Th>المورد</Th>
                  <Th>الوزن</Th>
                  <Th>سعر الكيلو</Th>
                  <Th>القيمة</Th>
                  <Th>التسوية</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <Td><span className="font-mono text-xs font-bold" dir="ltr">{row.number}</span></Td>
                    <Td className="whitespace-nowrap">{formatDate(row.saleDate)}</Td>
                    <Td className="font-semibold">{row.supplier.name}</Td>
                    <Td>
                      <div className="font-bold">{row.netKg} كجم</div>
                      <div className="text-xs text-muted">{row.withWater ? `قائم ${row.grossKg} − ${row.waterPercent}% مياه` : 'بدون مياه'}</div>
                    </Td>
                    <Td>{formatMoney(row.priceKg)}</Td>
                    <Td className="font-extrabold text-emerald-700">{formatMoney(row.amount)}</Td>
                    <Td>
                      <Badge tone={row.settlement === 'CASH' ? 'emerald' : row.settlement === 'INVOICE' ? 'brand' : 'amber'}>
                        {row.settlement === 'INVOICE' ? `فاتورة ${row.purchaseInvoice?.number || ''}` : row.settlement === 'CASH' ? `فلوس${row.cashAccount ? ` · ${row.cashAccount.name}` : ''}` : 'من الحساب'}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex gap-1">
                        <Button variant="ghost" className="!px-2" onClick={() => openEdit(row)}><Pencil size={14} /></Button>
                        <Button variant="ghost" className="!px-2 text-rose-600" onClick={() => remove(row)}><Trash2 size={14} /></Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Modal>

      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={editing ? `تعديل ${editing.number}` : 'بيع خردة لمورد'}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>المورد</Label>
              <Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value, purchaseInvoiceId: '' })}>
                <option value="">اختار المورد</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>التاريخ</Label>
              <Input type="date" value={form.saleDate} onChange={(e) => setForm({ ...form, saleDate: e.target.value })} />
            </div>
          </div>
          <div>
            <Label>نوع الخردة</Label>
            <WaterToggle value={form.withWater} onChange={(withWater) => setForm({ ...form, withWater })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>الوزن (كجم)</Label>
              <NumberInput value={form.grossKg} onValueChange={(v) => setForm({ ...form, grossKg: v })} />
            </div>
            <div>
              <Label>سعر الكيلو</Label>
              <NumberInput value={form.priceKg} onValueChange={(v) => setForm({ ...form, priceKg: v })} />
            </div>
          </div>
          <div className="grid gap-2 rounded-xl bg-amber-50 p-3 text-sm sm:grid-cols-3">
            <div>الوزن الصافي: <b>{calc.netKg} كجم</b></div>
            <div className="text-xs text-amber-800 sm:col-span-1">{form.withWater ? `اتخصم ${SCRAP_WATER_PERCENT}% مياه` : 'من غير خصم'}</div>
            <div className="text-base">القيمة: <b className="text-emerald-700">{formatMoney(calc.amount)}</b></div>
          </div>

          {pile.length > 0 && (
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-bold">بطاريات كوم الخردة اللي في البيعة دي</span>
                <button
                  type="button"
                  className="text-xs font-bold text-brand-700"
                  onClick={() => setPicked(picked.length === pile.length ? [] : pile.map((r) => r.id))}
                >
                  {picked.length === pile.length ? 'إلغاء الكل' : 'اختار الكل'}
                </button>
              </div>
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                {pile.map((r) => (
                  <label key={r.id} className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs ring-1 ${picked.includes(r.id) ? 'bg-amber-50 ring-amber-300' : 'bg-white ring-slate-200'}`}>
                    <input
                      type="checkbox"
                      checked={picked.includes(r.id)}
                      onChange={() => setPicked((cur) => cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id])}
                    />
                    <bdi dir="ltr" className="font-mono">{r.number}</bdi>
                    {r.product?.name || r.label ? ` · ${r.product?.name || r.label}` : ''}
                    {' · '}{formatMoney(r.intakeValue)}
                  </label>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs">
                <span>{picked.length} بطارية · قيمتها وقت الاستلام <b>{formatMoney(pileCost)}</b></span>
                {calc.amount > 0 && (
                  <span className={calc.amount - pileCost >= 0 ? 'font-bold text-emerald-700' : 'font-bold text-rose-600'}>
                    ربح البيعة {formatMoney(calc.amount - pileCost)}
                  </span>
                )}
              </div>
            </div>
          )}

          <div>
            <Label>المورد هيدفع إزاي؟</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {(Object.keys(SETTLEMENT_LABEL) as Settlement[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setForm({ ...form, settlement: key })}
                  className={`rounded-xl border px-3 py-2 text-sm font-bold transition ${form.settlement === key ? 'border-brand-400 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                >
                  {SETTLEMENT_LABEL[key]}
                </button>
              ))}
            </div>
          </div>

          {form.settlement === 'INVOICE' && (
            <div>
              <Label>فاتورة الشراء</Label>
              <Select value={form.purchaseInvoiceId} onChange={(e) => setForm({ ...form, purchaseInvoiceId: e.target.value })}>
                <option value="">{form.supplierId ? (invoices.length ? 'اختار الفاتورة' : 'مفيش فواتير مفتوحة للمورد') : 'اختار المورد الأول'}</option>
                {invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.number} · {formatDate(inv.invoiceDate)} · متبقي {formatMoney(inv.due)}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-muted">قيمة الخردة هتتخصم من إجمالي الفاتورة. ممكن كمان تضيفها من شاشة فاتورة الشراء نفسها.</p>
            </div>
          )}
          {form.settlement === 'CASH' && (
            <div>
              <Label>استلام الفلوس على</Label>
              <Select value={form.methodId} onChange={(e) => setForm({ ...form, methodId: e.target.value })}>
                <option value="">اختار</option>
                {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </div>
          )}
          {form.settlement === 'BALANCE' && (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">القيمة هتنزل من رصيد المورد (اللي عليك له) وتظهر في كشف حسابه.</p>
          )}

          <div>
            <Label>ملاحظات</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFormOpen(false)}>إلغاء</Button>
            <Button onClick={save} disabled={saving}>{saving ? 'جاري الحفظ...' : 'حفظ'}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
