import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Send, Trash2, Truck, Undo2 } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import { useConfirm, useToast } from '../lib/feedback';
import { Badge, Button, Card, CardHeader, Empty, Input, Label, Modal, NumberInput, Select, Table, Td, Th, todayIso } from './ui';
import type { PayMethodOption } from './TenderEditor';

type Ref = { id: string; name: string };
type ProductRef = { id: string; name: string; sku: string };

export type OldBattery = {
  id: string;
  number: string;
  source: 'SALE_SCRAP' | 'WARRANTY_SWAP' | 'WARRANTY_WAIT' | 'MANUAL' | 'SALE_RETURN';
  ownership: 'SHOP' | 'CUSTOMER';
  productId: string | null;
  label: string | null;
  customerName: string | null;
  customerPhone: string | null;
  intakeValue: number;
  receivedAt: string;
  productionDate: string | null;
  ageBand: 'UNDER_YEAR' | 'OVER_YEAR' | null;
  condition: 'GOOD' | 'BAD' | null;
  decision: 'PENDING' | 'SCRAP' | 'USED' | 'SERVICE' | 'WARRANTY';
  stockProductId: string | null;
  stockWarehouseId: string | null;
  weightKg: number | null;
  supplierId: string | null;
  claimStatus: 'IN_SHOP' | 'SENT' | 'RECEIVED' | 'DELIVERED' | 'REJECTED' | null;
  sentAt: string | null;
  receiverName: string | null;
  replacementAt: string | null;
  loanerProductId: string | null;
  loanerWarehouseId: string | null;
  loanerReturnedAt: string | null;
  consumptionFee: number;
  feeSettlement: 'BALANCE' | 'CASH' | null;
  notes: string | null;
  product: ProductRef | null;
  stockProduct: ProductRef | null;
  replacementProduct: ProductRef | null;
  loanerProduct: ProductRef | null;
  stockWarehouse: Ref | null;
  replacementWarehouse: Ref | null;
  loanerWarehouse: Ref | null;
  salesInvoice: { id: string; number: string } | null;
  salesReturn: { id: string; number: string } | null;
  supplier: Ref | null;
  scrapSale: { id: string; number: string } | null;
};

type Summary = { toSort: number; scrapPile: number; scrapPileValue: number; scrapPileKg: number; inShop: number; withSupplier: number; waitingCustomer: number };

const num = (v: number | '') => (v === '' ? 0 : Number(v) || 0);

const SOURCE_LABEL: Record<OldBattery['source'], string> = {
  SALE_SCRAP: 'خردة من فاتورة',
  WARRANTY_SWAP: 'ضمان — الزبون دفع فرق',
  WARRANTY_WAIT: 'ضمان زبون مستني',
  MANUAL: 'يدوي',
  SALE_RETURN: 'من مرتجع بيع',
};

const DECISION_LABEL: Record<OldBattery['decision'], string> = {
  PENDING: 'مستنية الفرز',
  SCRAP: 'خردة',
  USED: 'مستعمل/سيرفس',
  SERVICE: 'مستعمل/سيرفس',
  WARRANTY: 'مرتجع ضمان',
};

const DECISION_TONE: Record<OldBattery['decision'], 'slate' | 'amber' | 'sky' | 'violet' | 'brand'> = {
  PENDING: 'slate',
  SCRAP: 'amber',
  USED: 'sky',
  SERVICE: 'violet',
  WARRANTY: 'brand',
};

const CLAIM_LABEL: Record<NonNullable<OldBattery['claimStatus']>, string> = {
  IN_SHOP: 'في المحل',
  SENT: 'عند المورد — البديل لسه موصلش',
  RECEIVED: 'وصل البديل',
  DELIVERED: 'اتسلّم للزبون',
  REJECTED: 'المورد رفض',
};

const CLAIM_TONE: Record<NonNullable<OldBattery['claimStatus']>, 'slate' | 'amber' | 'emerald' | 'sky' | 'rose'> = {
  IN_SHOP: 'slate',
  SENT: 'amber',
  RECEIVED: 'emerald',
  DELIVERED: 'sky',
  REJECTED: 'rose',
};

function typeName(b: OldBattery) {
  return b.product?.name || b.label || '—';
}

function ageText(b: OldBattery) {
  if (b.productionDate) return `إنتاج ${formatDate(b.productionDate)}`;
  if (b.ageBand === 'UNDER_YEAR') return 'أقل من سنة';
  if (b.ageBand === 'OVER_YEAR') return 'أكتر من سنة';
  return '';
}

function suggest(condition: string, ageBand: string | null): OldBattery['decision'] | null {
  if (condition === 'BAD' && ageBand === 'OVER_YEAR') return 'SCRAP';
  if (condition === 'BAD' && ageBand === 'UNDER_YEAR') return 'WARRANTY';
  return null;
}

function ageFromDate(date: string) {
  if (!date) return null;
  return Date.now() - new Date(date).getTime() < 365 * 24 * 3600 * 1000 ? 'UNDER_YEAR' : 'OVER_YEAR';
}

/** اختيار تاريخ الإنتاج أو أقل/أكتر من سنة */
function AgeInput({ date, band, onChange }: { date: string; band: string | null; onChange: (date: string, band: string | null) => void }) {
  const effective = date ? ageFromDate(date) : band;
  return (
    <div className="space-y-2">
      <Input type="date" value={date} onChange={(e) => onChange(e.target.value, ageFromDate(e.target.value))} />
      <div className="flex rounded-xl bg-slate-100 p-1">
        {([['UNDER_YEAR', 'أقل من سنة'], ['OVER_YEAR', 'أكتر من سنة']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange('', key)}
            className={`h-8 flex-1 rounded-lg text-xs font-bold transition ${effective === key ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function useLookups() {
  const [products, setProducts] = useState<ProductRef[]>([]);
  const [warehouses, setWarehouses] = useState<Ref[]>([]);
  const [suppliers, setSuppliers] = useState<Ref[]>([]);
  const [methods, setMethods] = useState<PayMethodOption[]>([]);
  const [usedWarehouse, setUsedWarehouse] = useState<Ref | null>(null);
  useEffect(() => {
    api<{ usedWarehouse: Ref }>('/returns/old-batteries/config').then((c) => setUsedWarehouse(c.usedWarehouse)).catch(() => setUsedWarehouse(null));
    api<ProductRef[]>('/products').then(setProducts).catch(() => setProducts([]));
    api<Ref[]>('/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
    api<Ref[]>('/scrap/suppliers').then(setSuppliers).catch(() => setSuppliers([]));
    api<PayMethodOption[]>('/cash/methods').then((m) => setMethods(m.filter((x) => x.kind === 'IMMEDIATE'))).catch(() => setMethods([]));
  }, []);
  return { products, warehouses, suppliers, methods, usedWarehouse };
}

type BulkResult = { done: number; errors: { number: string; message: string }[] };

/** فرز المحدد مرة واحدة: نفس القرار لكل البطاريات المختارة */
function BulkSortBar({ ids, products, warehouses, suppliers, usedWarehouse, onDone, onClear }: {
  ids: string[];
  products: ProductRef[];
  warehouses: Ref[];
  suppliers: Ref[];
  usedWarehouse: Ref | null;
  onDone: (result: BulkResult) => void;
  onClear: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    decision: '' as '' | OldBattery['decision'],
    condition: '' as '' | 'GOOD' | 'BAD',
    ageBand: '' as '' | 'UNDER_YEAR' | 'OVER_YEAR',
    productId: '',
    stockProductId: '',
    stockWarehouseId: '',
    supplierId: '',
  });
  const [saving, setSaving] = useState(false);
  const toStock = form.decision === 'USED' || form.decision === 'SERVICE';

  async function apply() {
    if (!form.decision) return toast.error('اختار المصير');
    if (toStock && !form.stockProductId) return toast.error('اختار الصنف المستعمل/السيرفس');
    setSaving(true);
    try {
      const result = await api<BulkResult>('/returns/old-batteries/sort-bulk', {
        method: 'POST',
        body: JSON.stringify({
          ids,
          decision: form.decision,
          ...(form.condition ? { condition: form.condition } : {}),
          ...(form.ageBand ? { ageBand: form.ageBand, productionDate: null } : {}),
          ...(form.productId ? { productId: form.productId } : {}),
          ...(toStock ? { stockProductId: form.stockProductId, stockWarehouseId: form.stockWarehouseId || usedWarehouse?.id } : {}),
          ...(form.decision === 'WARRANTY' && form.supplierId ? { supplierId: form.supplierId } : {}),
        }),
      });
      if (result.errors.length) toast.error(`اتفرز ${result.done} · ${result.errors.length} ماتفرزتش: ${result.errors.map((e) => `${e.number} (${e.message})`).join(' · ')}`);
      else toast.success(`اتفرز ${result.done} بطارية`);
      onDone(result);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر الفرز');
    } finally {
      setSaving(false);
    }
  }

  const chip = (active: boolean) => `h-8 rounded-lg px-3 text-xs font-bold transition ${active ? 'bg-brand-700 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`;

  return (
    <div className="mb-3 space-y-3 rounded-2xl border border-brand-200 bg-brand-50/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-extrabold text-brand-900">فرز {ids.length} بطارية مرة واحدة</div>
        <button type="button" className="text-xs font-bold text-slate-500" onClick={onClear}>إلغاء التحديد</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-slate-600">المصير:</span>
        {([['SCRAP', 'خردة'], ['USED', 'مستعمل/سيرفس'], ['WARRANTY', 'مرتجع ضمان للمورد']] as const).map(([key, label]) => (
          <button key={key} type="button" className={chip(form.decision === key)} onClick={() => setForm({ ...form, decision: key })}>{label}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-slate-600">الفحص (اختياري):</span>
        {([['GOOD', 'سليمة'], ['BAD', 'بايظة']] as const).map(([key, label]) => (
          <button key={key} type="button" className={chip(form.condition === key)} onClick={() => setForm({ ...form, condition: form.condition === key ? '' : key })}>{label}</button>
        ))}
        <span className="ms-2 text-xs font-bold text-slate-600">الإنتاج:</span>
        {([['UNDER_YEAR', 'أقل من سنة'], ['OVER_YEAR', 'أكتر من سنة']] as const).map(([key, label]) => (
          <button key={key} type="button" className={chip(form.ageBand === key)} onClick={() => setForm({ ...form, ageBand: form.ageBand === key ? '' : key })}>{label}</button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <Label>نوع البطارية (لو كلهم نفس النوع)</Label>
          <ProductSelect products={products} value={form.productId} onChange={(productId) => setForm({ ...form, productId })} placeholder="سيب النوع زي ما هو" />
        </div>
        {toStock && (
          <>
            <div>
              <Label>الصنف المستعمل</Label>
              <ProductSelect products={products} value={form.stockProductId} onChange={(stockProductId) => setForm({ ...form, stockProductId })} />
            </div>
            <div>
              <Label>المخزن</Label>
              <Select value={form.stockWarehouseId || usedWarehouse?.id || ''} onChange={(e) => setForm({ ...form, stockWarehouseId: e.target.value })}>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
          </>
        )}
        {form.decision === 'WARRANTY' && (
          <div>
            <Label>المورد (اختياري)</Label>
            <Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">لسه</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
        )}
      </div>
      <div className="flex justify-end">
        <Button onClick={apply} disabled={saving}>{saving ? 'جاري الفرز...' : `طبّق على ${ids.length} بطارية`}</Button>
      </div>
    </div>
  );
}

function ProductSelect({ products, value, onChange, placeholder = 'اختار الصنف' }: { products: ProductRef[]; value: string; onChange: (id: string) => void; placeholder?: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {products.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}
    </Select>
  );
}

export function OldBatteriesPanel({ mode, onCountsChange }: { mode: 'sort' | 'warranty'; onCountsChange?: (summary: Summary) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { products, warehouses, suppliers, methods, usedWarehouse } = useLookups();
  const [rows, setRows] = useState<OldBattery[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [view, setView] = useState<string>(mode === 'sort' ? 'sort' : 'SENT');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [sorting, setSorting] = useState<OldBattery | null>(null);
  const [receiving, setReceiving] = useState<OldBattery | null>(null);
  const [sendOpen, setSendOpen] = useState<string[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<OldBattery | null>(null);

  async function load() {
    const params = new URLSearchParams();
    if (mode === 'sort') params.set('view', view === 'all' ? '' : view);
    else params.set('view', 'warranty');
    if (supplierFilter) params.set('supplierId', supplierFilter);
    if (search.trim()) params.set('q', search.trim());
    const [list, sum] = await Promise.all([
      api<OldBattery[]>(`/returns/old-batteries?${params}`),
      api<Summary>('/returns/old-batteries/summary'),
    ]);
    setRows(list);
    setSummary(sum);
    onCountsChange?.(sum);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch(() => setRows([])); }, 200);
    return () => window.clearTimeout(timer);
  }, [mode, view, supplierFilter, search]);

  const visible = useMemo(() => {
    if (mode === 'sort') return rows;
    if (view === 'all') return rows;
    return rows.filter((r) => r.claimStatus === view);
  }, [rows, mode, view]);

  async function act(path: string, body?: unknown, message = 'تم') {
    try {
      await api(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
      toast.success(message);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر التنفيذ');
    }
  }

  async function remove(row: OldBattery) {
    const ok = await confirm({ title: 'حذف البطارية', message: `حذف ${row.number}؟`, confirmLabel: 'حذف', danger: true });
    if (!ok) return;
    try {
      await api(`/returns/old-batteries/${row.id}`, { method: 'DELETE' });
      toast.success('تم الحذف');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر الحذف');
    }
  }

  async function reject(row: OldBattery) {
    const toScrap = row.ownership === 'SHOP'
      ? await confirm({ title: 'المورد رفض الضمان', message: 'تحوّل البطارية لكوم الخردة؟ (لو لأ هتتسجل مرفوضة بس)', confirmLabel: 'خليها خردة' })
      : false;
    await act(`/returns/old-batteries/${row.id}/reject`, { toScrap }, 'تم تسجيل الرفض');
  }

  async function deliverToCustomer(row: OldBattery) {
    const loaner = row.loanerProduct && !row.loanerReturnedAt
      ? `\nبطارية السيرفس «${row.loanerProduct.name}» هترجع لمخزن ${row.loanerWarehouse?.name || 'المستعمل/سيرفس'}.`
      : '';
    const ok = await confirm({
      title: 'تسليم البديل للزبون',
      message: `تسليم البطارية الجديدة لـ ${row.customerName || 'الزبون'}؟${loaner}`,
      confirmLabel: 'تسليم',
    });
    if (!ok) return;
    await act(`/returns/old-batteries/${row.id}/deliver`, undefined, loaner ? 'اتسلّمت للزبون وبطارية السيرفس رجعت للمخزن' : 'اتسلّمت للزبون');
  }

  const sortTabs: [string, string, number | undefined][] = [
    ['sort', 'مستنية الفرز', summary?.toSort],
    ['scrap', 'كوم الخردة', summary?.scrapPile],
    ['stock', 'مستعمل / سيرفس', undefined],
    ['warranty', 'اتفرزت ضمان', undefined],
    ['all', 'الكل', undefined],
  ];
  const warrantyTabs: [string, string, number | undefined][] = [
    ['IN_SHOP', 'في المحل', summary?.inShop],
    ['SENT', 'عند المورد', summary?.withSupplier],
    ['RECEIVED', 'وصل البديل', undefined],
    ['DELIVERED', 'اتسلّم للزبون', undefined],
    ['REJECTED', 'مرفوض', undefined],
    ['all', 'الكل', undefined],
  ];
  const tabs = mode === 'sort' ? sortTabs : warrantyTabs;
  const inShopSelected = selected.filter((id) => visible.some((r) => r.id === id && (r.claimStatus === 'IN_SHOP' || r.claimStatus === 'SENT')));

  return (
    <Card>
      <CardHeader
        title={mode === 'sort' ? 'فرز البطاريات القديمة' : 'مرتجعات الضمان للموردين'}
        subtitle={mode === 'sort'
          ? `مستنية الفرز ${summary?.toSort ?? 0} · كوم الخردة ${summary?.scrapPile ?? 0} بطارية بقيمة ${formatMoney(summary?.scrapPileValue || 0)}`
          : `في المحل ${summary?.inShop ?? 0} · عند الموردين ${summary?.withSupplier ?? 0} · زباين مستنيين يستلموا ${summary?.waitingCustomer ?? 0}`}
        icon={mode === 'sort' ? Undo2 : Truck}
        actions={(
          <div className="flex flex-wrap gap-2">
            {mode === 'warranty' && inShopSelected.length > 0 && (
              <Button variant="secondary" onClick={() => setSendOpen(inShopSelected)}><Send size={14} /> إرسال {inShopSelected.length} للمورد</Button>
            )}
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> {mode === 'sort' ? 'بطارية قديمة' : 'ضمان زبون (يستنى البديل)'}
            </Button>
          </div>
        )}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap rounded-xl bg-slate-100 p-1">
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => { setView(key); setSelected([]); }}
              className={`h-8 rounded-lg px-3 text-xs font-bold transition ${view === key ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              {label}{count !== undefined ? ` (${count})` : ''}
            </button>
          ))}
        </div>
        {mode === 'warranty' && (
          <Select className="!w-48" value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
            <option value="">كل الموردين</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <Input className="!w-56" placeholder="بحث: رقم، نوع، زبون، مستلم…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {mode === 'sort' && selected.length > 0 && (
        <BulkSortBar
          ids={selected}
          products={products}
          warehouses={warehouses}
          suppliers={suppliers}
          usedWarehouse={usedWarehouse}
          onClear={() => setSelected([])}
          onDone={(result) => {
            const failed = new Set(result.errors.map((e) => e.number));
            setSelected((cur) => cur.filter((id) => failed.has(rows.find((r) => r.id === id)?.number || '')));
            load();
          }}
        />
      )}

      {visible.length === 0 ? <Empty text="مفيش بطاريات هنا" /> : mode === 'sort' ? (
        <Table>
          <thead>
            <tr>
              <Th>
                <input
                  type="checkbox"
                  title="تحديد الكل"
                  checked={visible.length > 0 && visible.every((r) => selected.includes(r.id))}
                  onChange={(e) => setSelected(e.target.checked ? visible.map((r) => r.id) : [])}
                />
              </Th>
              <Th>الرقم</Th>
              <Th>التاريخ</Th>
              <Th>المصدر</Th>
              <Th>النوع</Th>
              <Th>الحالة / الإنتاج</Th>
              <Th>القيمة عليك</Th>
              <Th>المصير</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((b) => (
              <tr key={b.id} className={selected.includes(b.id) ? 'bg-brand-50/60' : ''}>
                <Td>
                  <input
                    type="checkbox"
                    checked={selected.includes(b.id)}
                    onChange={() => setSelected((cur) => cur.includes(b.id) ? cur.filter((x) => x !== b.id) : [...cur, b.id])}
                  />
                </Td>
                <Td><span className="font-mono text-xs font-bold" dir="ltr">{b.number}</span></Td>
                <Td className="whitespace-nowrap">{formatDate(b.receivedAt)}</Td>
                <Td>
                  <div className="text-sm">{SOURCE_LABEL[b.source]}</div>
                  <div className="text-xs text-muted">
                    {b.salesInvoice ? <bdi dir="ltr">{b.salesInvoice.number}</bdi> : null}
                    {b.customerName ? ` · ${b.customerName}` : ''}
                  </div>
                </Td>
                <Td className="font-semibold">{typeName(b)}</Td>
                <Td className="text-xs">
                  {b.condition ? <Badge tone={b.condition === 'GOOD' ? 'emerald' : 'rose'}>{b.condition === 'GOOD' ? 'سليمة' : 'بايظة'}</Badge> : '—'}
                  <div className="mt-1 text-muted">{ageText(b)}</div>
                </Td>
                <Td className="tabular-nums">{formatMoney(b.intakeValue)}</Td>
                <Td>
                  <Badge tone={DECISION_TONE[b.decision]}>{DECISION_LABEL[b.decision]}</Badge>
                  <div className="mt-1 text-xs text-muted">
                    {b.decision === 'SCRAP' && (b.scrapSale ? `اتباعت ${b.scrapSale.number}` : b.weightKg ? `${b.weightKg} كجم` : 'في الكوم')}
                    {(b.decision === 'USED' || b.decision === 'SERVICE') && `${b.stockProduct?.name || ''} · ${b.stockWarehouse?.name || ''}`}
                    {b.decision === 'WARRANTY' && b.claimStatus && CLAIM_LABEL[b.claimStatus]}
                  </div>
                </Td>
                <Td>
                  <div className="flex gap-1">
                    <Button variant={b.decision === 'PENDING' ? 'primary' : 'secondary'} className="!px-2" onClick={() => setSorting(b)}>
                      {b.decision === 'PENDING' ? 'فرز' : 'تعديل الفرز'}
                    </Button>
                    <Button variant="ghost" className="!px-2" onClick={() => setEditing(b)} title="تعديل البيانات"><Pencil size={14} /></Button>
                    <Button variant="ghost" className="!px-2 text-rose-600" onClick={() => remove(b)}><Trash2 size={14} /></Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th></Th>
              <Th>تاريخ الإرسال</Th>
              <Th>نوع البطارية</Th>
              <Th>المورد</Th>
              <Th>المستلم</Th>
              <Th>صاحبها</Th>
              <Th>البديل</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((b) => (
              <tr key={b.id}>
                <Td>
                  {(b.claimStatus === 'IN_SHOP' || b.claimStatus === 'SENT') && (
                    <input
                      type="checkbox"
                      checked={selected.includes(b.id)}
                      onChange={() => setSelected((cur) => cur.includes(b.id) ? cur.filter((x) => x !== b.id) : [...cur, b.id])}
                    />
                  )}
                </Td>
                <Td className="whitespace-nowrap">
                  {b.sentAt ? formatDate(b.sentAt) : <span className="text-muted">لسه في المحل</span>}
                  <div className="font-mono text-[11px] text-muted" dir="ltr">{b.number}</div>
                </Td>
                <Td>
                  <div className="font-semibold">{typeName(b)}</div>
                  <div className="text-xs text-muted">{ageText(b)}</div>
                </Td>
                <Td>{b.supplier?.name || '—'}</Td>
                <Td>{b.receiverName || '—'}</Td>
                <Td>
                  {b.ownership === 'SHOP'
                    ? <Badge tone="brand">محل</Badge>
                    : (
                      <div>
                        <div className="font-semibold">{b.customerName}</div>
                        {b.customerPhone && <div className="text-xs text-muted" dir="ltr">{b.customerPhone}</div>}
                      </div>
                    )}
                </Td>
                <Td>
                  {b.claimStatus && <Badge tone={CLAIM_TONE[b.claimStatus]}>{CLAIM_LABEL[b.claimStatus]}</Badge>}
                  {(b.claimStatus === 'RECEIVED' || b.claimStatus === 'DELIVERED') && (
                    <div className="mt-1 text-xs text-muted">
                      {b.replacementAt && formatDate(b.replacementAt)}
                      {b.replacementProduct && ` · ${b.replacementProduct.name}`}
                      {b.consumptionFee > 0 && ` · استهلاك ${formatMoney(b.consumptionFee)}`}
                      {b.ownership === 'SHOP' && ` · تكلفتها ${formatMoney(b.intakeValue + b.consumptionFee)}`}
                    </div>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {b.claimStatus === 'IN_SHOP' && <Button variant="secondary" className="!px-2" onClick={() => setSendOpen([b.id])}><Send size={14} /> إرسال</Button>}
                    {b.claimStatus === 'SENT' && (
                      <>
                        <Button className="!px-2" onClick={() => setReceiving(b)}>وصل البديل</Button>
                        <Button variant="ghost" className="!px-2" onClick={() => act(`/returns/old-batteries/${b.id}/unsend`, undefined, 'رجعت للمحل')}>رجوع</Button>
                        <Button variant="ghost" className="!px-2 text-rose-600" onClick={() => reject(b)}>رفض</Button>
                      </>
                    )}
                    {b.claimStatus === 'RECEIVED' && b.ownership === 'CUSTOMER' && (
                      <Button
                        className="!px-2"
                        onClick={() => deliverToCustomer(b)}
                      >
                        تسليم للزبون
                      </Button>
                    )}
                    {b.claimStatus === 'RECEIVED' && (
                      <Button variant="ghost" className="!px-2" onClick={() => act(`/returns/old-batteries/${b.id}/undo-receive`, undefined, 'اتلغى الاستلام')}>إلغاء الاستلام</Button>
                    )}
                    {b.claimStatus === 'DELIVERED' && (
                      <Button variant="ghost" className="!px-2" onClick={() => act(`/returns/old-batteries/${b.id}/undo-deliver`, undefined, 'اتلغى التسليم')}>إلغاء التسليم</Button>
                    )}
                    {b.loanerProduct && (
                      <div className="mt-1 text-[11px] text-muted">
                        سيرفس مع الزبون: {b.loanerProduct.name}
                        {b.loanerReturnedAt ? ' · رجعت للمخزن' : ''}
                      </div>
                    )}
                    {(b.claimStatus === 'IN_SHOP' || b.claimStatus === 'REJECTED') && (
                      <Button variant="ghost" className="!px-2 text-rose-600" onClick={() => remove(b)}><Trash2 size={14} /></Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {sorting && (
        <SortModal
          battery={sorting}
          products={products}
          warehouses={warehouses}
          suppliers={suppliers}
          usedWarehouse={usedWarehouse}
          onClose={() => setSorting(null)}
          onSaved={() => { setSorting(null); load(); }}
        />
      )}
      {receiving && (
        <ReceiveModal
          battery={receiving}
          products={products}
          warehouses={warehouses}
          methods={methods}
          onClose={() => setReceiving(null)}
          onSaved={() => { setReceiving(null); load(); }}
        />
      )}
      {sendOpen && (
        <SendModal
          ids={sendOpen}
          suppliers={suppliers}
          presetSupplier={rows.find((r) => sendOpen.includes(r.id) && r.supplierId)?.supplierId || ''}
          onClose={() => setSendOpen(null)}
          onSaved={() => { setSendOpen(null); setSelected([]); load(); }}
        />
      )}
      {(createOpen || editing) && (
        <CreateModal
          kind={mode === 'sort' ? 'MANUAL' : 'WARRANTY_WAIT'}
          editing={editing}
          products={products}
          warehouses={warehouses}
          usedWarehouse={usedWarehouse}
          suppliers={suppliers}
          onClose={() => { setCreateOpen(false); setEditing(null); }}
          onSaved={() => { setCreateOpen(false); setEditing(null); load(); }}
        />
      )}
    </Card>
  );
}

function SortModal({ battery, products, warehouses, suppliers, usedWarehouse, onClose, onSaved }: {
  battery: OldBattery;
  products: ProductRef[];
  warehouses: Ref[];
  suppliers: Ref[];
  usedWarehouse: Ref | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    productId: battery.productId || '',
    productionDate: battery.productionDate ? battery.productionDate.slice(0, 10) : '',
    ageBand: battery.ageBand as string | null,
    condition: (battery.condition || '') as '' | 'GOOD' | 'BAD',
    decision: battery.decision,
    stockProductId: battery.stockProductId || '',
    stockWarehouseId: battery.stockWarehouseId || usedWarehouse?.id || '',
    weightKg: (battery.weightKg ?? '') as number | '',
    supplierId: battery.supplierId || '',
    notes: battery.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const customer = battery.ownership === 'CUSTOMER';
  const hint = form.condition ? suggest(form.condition, form.ageBand) : null;

  async function save() {
    if (form.decision === 'PENDING') return toast.error('اختار مصير البطارية');
    if ((form.decision === 'USED' || form.decision === 'SERVICE') && !form.stockProductId) {
      return toast.error('اختار الصنف المستعمل/السيرفس');
    }
    setSaving(true);
    try {
      await api(`/returns/old-batteries/${battery.id}/sort`, {
        method: 'PATCH',
        body: JSON.stringify({
          productId: form.productId || undefined,
          productionDate: form.productionDate || null,
          ageBand: form.ageBand,
          condition: form.condition || null,
          decision: form.decision,
          stockProductId: form.stockProductId || undefined,
          stockWarehouseId: form.stockWarehouseId || usedWarehouse?.id || undefined,
          weightKg: form.decision === 'SCRAP' && form.weightKg !== '' ? num(form.weightKg) : null,
          supplierId: form.decision === 'WARRANTY' ? form.supplierId || null : undefined,
          notes: form.notes,
        }),
      });
      toast.success('تم الفرز');
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setSaving(false);
    }
  }

  const decisions: [OldBattery['decision'], string][] = customer
    ? [['WARRANTY', 'مرتجع ضمان للمورد']]
    : [['SCRAP', 'خردة'], ['USED', 'مستعمل/سيرفس'], ['WARRANTY', 'مرتجع ضمان للمورد']];

  return (
    <Modal open onClose={onClose} title={`فرز ${battery.number}`}>
      <div className="space-y-3">
        <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {SOURCE_LABEL[battery.source]}{battery.salesInvoice ? ` · ${battery.salesInvoice.number}` : ''}{battery.customerName ? ` · ${battery.customerName}` : ''}
          {' · '}قيمتها عليك <b>{formatMoney(battery.intakeValue)}</b>
        </div>
        <div>
          <Label>نوع البطارية</Label>
          <ProductSelect products={products} value={form.productId} onChange={(productId) => setForm({ ...form, productId })} placeholder="اختار النوع (اختياري)" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>تاريخ الإنتاج</Label>
            <AgeInput date={form.productionDate} band={form.ageBand} onChange={(productionDate, ageBand) => setForm({ ...form, productionDate, ageBand })} />
          </div>
          <div>
            <Label>نتيجة الفحص</Label>
            <div className="flex rounded-xl bg-slate-100 p-1">
              {([['GOOD', 'سليمة'], ['BAD', 'بايظة']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    const next = suggest(key, form.ageBand);
                    setForm({ ...form, condition: key, decision: next && !customer ? next : form.decision });
                  }}
                  className={`h-9 flex-1 rounded-lg text-sm font-bold transition ${form.condition === key ? (key === 'GOOD' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white') : 'text-slate-500 hover:text-slate-800'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {hint && !customer && <p className="mt-1 text-xs text-brand-700">المقترح: {DECISION_LABEL[hint]}</p>}
          </div>
        </div>
        <div>
          <Label>مصير البطارية</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {decisions.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setForm({ ...form, decision: key })}
                className={`rounded-xl border px-3 py-2 text-sm font-bold transition ${form.decision === key ? 'border-brand-400 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {(form.decision === 'USED' || form.decision === 'SERVICE') && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>الصنف المستعمل</Label>
              <ProductSelect products={products} value={form.stockProductId} onChange={(stockProductId) => setForm({ ...form, stockProductId })} />
              <p className="mt-1 text-xs text-muted">اعمل صنف زي "td70 spot مستعمل" من صفحة الأصناف</p>
            </div>
            <div>
              <Label>يدخل مخزن</Label>
              <Select value={form.stockWarehouseId || usedWarehouse?.id || ''} onChange={(e) => setForm({ ...form, stockWarehouseId: e.target.value })}>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
            <p className="text-xs text-muted sm:col-span-2">هتدخل المخزن بتكلفة {formatMoney(battery.intakeValue)} (قيمتها وقت الاستلام)</p>
          </div>
        )}
        {form.decision === 'SCRAP' && (
          <div>
            <Label>الوزن (كجم) — اختياري</Label>
            <NumberInput value={form.weightKg} onValueChange={(weightKg) => setForm({ ...form, weightKg })} />
          </div>
        )}
        {form.decision === 'WARRANTY' && (
          <div>
            <Label>المورد (ممكن تحدده وقت الإرسال)</Label>
            <Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">لسه</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
        )}
        <div>
          <Label>ملاحظات</Label>
          <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2">
          {battery.decision !== 'PENDING' && !customer && (
            <Button variant="ghost" onClick={async () => {
              try {
                await api(`/returns/old-batteries/${battery.id}/sort`, { method: 'PATCH', body: JSON.stringify({ decision: 'PENDING' }) });
                toast.success('رجعت للفرز');
                onSaved();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'تعذر');
              }
            }}>رجّعها للفرز</Button>
          )}
          <Button variant="secondary" onClick={onClose}>إلغاء</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'جاري الحفظ...' : 'حفظ'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function SendModal({ ids, suppliers, presetSupplier, onClose, onSaved }: {
  ids: string[];
  suppliers: Ref[];
  presetSupplier: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({ supplierId: presetSupplier, sentAt: todayIso(), receiverName: '' });
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!form.supplierId) return toast.error('اختار المورد');
    setSaving(true);
    try {
      await api('/returns/old-batteries/send', { method: 'POST', body: JSON.stringify({ ids, ...form }) });
      toast.success(`اتبعتت ${ids.length} بطارية للمورد`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر الإرسال');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`إرسال ${ids.length} بطارية ضمان للمورد`}>
      <div className="space-y-3">
        <div>
          <Label>المورد</Label>
          <Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
            <option value="">اختار المورد</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>تاريخ الإرسال</Label>
            <Input type="date" value={form.sentAt} onChange={(e) => setForm({ ...form, sentAt: e.target.value })} />
          </div>
          <div>
            <Label>المستلم (من طرف المورد)</Label>
            <Input value={form.receiverName} onChange={(e) => setForm({ ...form, receiverName: e.target.value })} placeholder="مثلًا عبده كاوتشة" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>إلغاء</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'جاري...' : 'إرسال'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function ReceiveModal({ battery, products, warehouses, methods, onClose, onSaved }: {
  battery: OldBattery;
  products: ProductRef[];
  warehouses: Ref[];
  methods: PayMethodOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const shop = battery.ownership === 'SHOP';
  const [form, setForm] = useState({
    replacementProductId: battery.productId || '',
    replacementWarehouseId: '',
    consumptionFee: '' as number | '',
    feeSettlement: 'BALANCE' as 'BALANCE' | 'CASH',
    methodId: methods[0]?.id || '',
    replacementAt: todayIso(),
  });
  const [saving, setSaving] = useState(false);
  const fee = num(form.consumptionFee);
  async function save() {
    if (shop && (!form.replacementProductId || !form.replacementWarehouseId)) return toast.error('اختار الصنف والمخزن');
    if (fee > 0 && form.feeSettlement === 'CASH' && !form.methodId) return toast.error('اختار طريقة الدفع');
    setSaving(true);
    try {
      await api(`/returns/old-batteries/${battery.id}/receive`, {
        method: 'PATCH',
        body: JSON.stringify({
          replacementProductId: form.replacementProductId || undefined,
          replacementWarehouseId: shop ? form.replacementWarehouseId : undefined,
          consumptionFee: fee,
          feeSettlement: fee > 0 ? form.feeSettlement : undefined,
          methodId: fee > 0 && form.feeSettlement === 'CASH' ? form.methodId : undefined,
          replacementAt: form.replacementAt,
        }),
      });
      toast.success('تم تسجيل البديل');
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`وصل البديل · ${battery.number}`}>
      <div className="space-y-3">
        <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
          {typeName(battery)} · {battery.supplier?.name}
          {' · '}{shop ? 'ملك المحل' : `ملك ${battery.customerName}`}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>البطارية الجديدة</Label>
            <ProductSelect products={products} value={form.replacementProductId} onChange={(replacementProductId) => setForm({ ...form, replacementProductId })} />
          </div>
          {shop && (
            <div>
              <Label>تدخل مخزن</Label>
              <Select value={form.replacementWarehouseId} onChange={(e) => setForm({ ...form, replacementWarehouseId: e.target.value })}>
                <option value="">اختار المخزن</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
          )}
          <div>
            <Label>تاريخ الاستلام</Label>
            <Input type="date" value={form.replacementAt} onChange={(e) => setForm({ ...form, replacementAt: e.target.value })} />
          </div>
          <div>
            <Label>الاستهلاك للمورد</Label>
            <NumberInput value={form.consumptionFee} onValueChange={(consumptionFee) => setForm({ ...form, consumptionFee })} />
            {!shop && <p className="mt-1 text-xs text-muted">ضمان زبون — عادةً من غير استهلاك</p>}
          </div>
        </div>
        {fee > 0 && (
          <div className="space-y-2">
            <div className="flex rounded-xl bg-slate-100 p-1">
              {([['BALANCE', 'على حساب المورد'], ['CASH', 'دفع فوري']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setForm({ ...form, feeSettlement: key })}
                  className={`h-8 flex-1 rounded-lg text-xs font-bold transition ${form.feeSettlement === key ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {form.feeSettlement === 'CASH' && (
              <Select value={form.methodId} onChange={(e) => setForm({ ...form, methodId: e.target.value })}>
                <option value="">اختار طريقة الدفع</option>
                {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            )}
          </div>
        )}
        {shop && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm">
            البطارية الجديدة واقفة عليك بـ <b>{formatMoney(battery.intakeValue + fee)}</b>
            <span className="text-xs text-muted"> (خردة {formatMoney(battery.intakeValue)} + استهلاك {formatMoney(fee)})</span>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>إلغاء</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'جاري الحفظ...' : 'حفظ'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function CreateModal({ kind, editing, products, warehouses, usedWarehouse, suppliers, onClose, onSaved }: {
  kind: 'MANUAL' | 'WARRANTY_WAIT';
  editing: OldBattery | null;
  products: ProductRef[];
  warehouses: Ref[];
  usedWarehouse: Ref | null;
  suppliers: Ref[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const wait = editing ? editing.ownership === 'CUSTOMER' : kind === 'WARRANTY_WAIT';
  const [form, setForm] = useState({
    quantity: 1 as number | '',
    productId: editing?.productId || '',
    label: editing?.label || '',
    customerName: editing?.customerName || '',
    customerPhone: editing?.customerPhone || '',
    intakeValue: (editing?.intakeValue ?? '') as number | '',
    productionDate: '',
    ageBand: null as string | null,
    supplierId: '',
    notes: editing?.notes || '',
    giveLoaner: false,
    loanerWarehouseId: usedWarehouse?.id || '',
    loanerProductId: '',
  });
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!form.productId && !form.label.trim()) return toast.error('اختار نوع البطارية');
    if (wait && !form.customerName.trim()) return toast.error('اكتب اسم الزبون');
    if (wait && form.giveLoaner && (!form.loanerProductId || !form.loanerWarehouseId)) {
      return toast.error('اختار بطارية السيرفس والمخزن');
    }
    setSaving(true);
    try {
      if (editing) {
        await api(`/returns/old-batteries/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            productId: form.productId || null,
            label: form.label || null,
            customerName: form.customerName || null,
            customerPhone: form.customerPhone || null,
            ...(wait ? {} : { intakeValue: num(form.intakeValue) }),
            notes: form.notes || null,
          }),
        });
      } else {
        await api('/returns/old-batteries', {
          method: 'POST',
          body: JSON.stringify({
            kind,
            quantity: num(form.quantity) || 1,
            productId: form.productId || undefined,
            label: form.label || undefined,
            customerName: form.customerName || undefined,
            customerPhone: form.customerPhone || undefined,
            intakeValue: wait ? 0 : num(form.intakeValue),
            productionDate: form.productionDate || undefined,
            ageBand: form.ageBand || undefined,
            supplierId: form.supplierId || undefined,
            notes: form.notes || undefined,
            ...(wait && form.giveLoaner ? {
              loanerProductId: form.loanerProductId,
              loanerWarehouseId: form.loanerWarehouseId,
            } : {}),
          }),
        });
      }
      toast.success('تم الحفظ');
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={editing ? `تعديل ${editing.number}` : wait ? 'ضمان زبون — يستنى البديل من المورد' : 'بطارية قديمة يدوي'}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>نوع البطارية</Label>
            <ProductSelect products={products} value={form.productId} onChange={(productId) => setForm({ ...form, productId })} />
          </div>
          <div>
            <Label>أو اكتب النوع</Label>
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="td70 spot" dir="ltr" />
          </div>
        </div>
        {(wait || form.customerName) && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>اسم الزبون</Label>
              <Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
            </div>
            <div>
              <Label>التليفون</Label>
              <Input value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} dir="ltr" />
            </div>
          </div>
        )}
        {!editing && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>تاريخ الإنتاج</Label>
              <AgeInput date={form.productionDate} band={form.ageBand} onChange={(productionDate, ageBand) => setForm({ ...form, productionDate, ageBand })} />
            </div>
            <div className="space-y-3">
              <div>
                <Label>العدد</Label>
                <NumberInput value={form.quantity} onValueChange={(quantity) => setForm({ ...form, quantity })} />
              </div>
              {wait && (
                <div>
                  <Label>المورد (اختياري دلوقتي)</Label>
                  <Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                    <option value="">لسه</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </div>
              )}
            </div>
          </div>
        )}
        {!wait && (
          <div>
            <Label>قيمتها عليك (اللي دفعته فيها)</Label>
            <NumberInput value={form.intakeValue} onValueChange={(intakeValue) => setForm({ ...form, intakeValue })} />
          </div>
        )}
        {wait && !editing && (
          <div className="space-y-3 rounded-xl border border-sky-200 bg-sky-50/50 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={form.giveLoaner}
                onChange={(e) => setForm({
                  ...form,
                  giveLoaner: e.target.checked,
                  loanerWarehouseId: form.loanerWarehouseId || usedWarehouse?.id || '',
                })}
              />
              هديه بطارية سيرفس مؤقت لحد ما ياخد البديل؟
            </label>
            {form.giveLoaner && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>مخزن السيرفس</Label>
                  <Select value={form.loanerWarehouseId} onChange={(e) => setForm({ ...form, loanerWarehouseId: e.target.value, loanerProductId: '' })}>
                    <option value="">اختر المخزن</option>
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>بطارية السيرفس</Label>
                  <ProductSelect products={products} value={form.loanerProductId} onChange={(loanerProductId) => setForm({ ...form, loanerProductId })} placeholder="اختار البطارية" />
                </div>
              </div>
            )}
            <p className="text-xs text-muted">لما تضغط «تسليم للزبون» بعد وصول البديل، بطارية السيرفس هترجع للمخزن أوتوماتيك.</p>
          </div>
        )}
        <div>
          <Label>ملاحظات</Label>
          <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>إلغاء</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'جاري الحفظ...' : 'حفظ'}</Button>
        </div>
      </div>
    </Modal>
  );
}
