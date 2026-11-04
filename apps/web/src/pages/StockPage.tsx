import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Boxes, Coins, Eye, PackageCheck, PackageX, Pencil, Printer, Search, Trash2 } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import { useConfirm, useToast } from '../lib/feedback';
import { ProductPicker } from '../components/ProductPicker';
import { productsForWarehouse } from '../lib/productWarehouse';
import {
  Badge, Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, Pager, PrintHeader, SearchBox, Select, StatCard, StatGrid, Table, Td, Th,
} from '../components/ui';

type FieldValue = { value: string; field: { label: string } };

type Batch = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  supplierName: string;
  warehouseName: string;
  quantity: number;
  unitCost: number;
  total: number;
  batchNumber?: string | null;
  expiryDate?: string | null;
};

type StockItem = {
  id: string;
  warehouseId: string;
  productId: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  product: {
    id: string;
    sku: string;
    name: string;
    unit: string;
    costPrice: number;
    fieldValues: FieldValue[];
  };
  warehouse: { id: string; name: string };
  batches: Batch[];
  openLayers?: number;
  nextCost?: number | null;
};

type FifoConsumed = { type: string; reference: string | null; date: string; quantity: number; partyName: string | null };
type FifoLayerRow = {
  key: string;
  type: string;
  reference: string | null;
  viaTransfer: string | null;
  partyName: string | null;
  note: string | null;
  date: string | null;
  unitCost: number;
  quantity: number;
  remaining: number;
  used: number;
  consumed: FifoConsumed[];
};
type FifoDetail = {
  remainingQty: number;
  remainingValue: number;
  avgCost: number;
  nextCost: number | null;
  layers: FifoLayerRow[];
  fallbackOuts: { reference: string | null; type: string; date: string; quantity: number; unitCost: number; partyName: string | null }[];
};

const LAYER_LABELS: Record<string, string> = {
  PURCHASE: 'فاتورة شراء',
  SALE_RETURN: 'مرتجع بيع',
  ADJUSTMENT: 'تسوية / استلام',
  TRANSFER_IN: 'تحويل وارد',
  OPENING: 'رصيد سابق',
};

type Movement = {
  id: string;
  type: string;
  quantity: number;
  unitCost: number;
  reference?: string | null;
  note?: string | null;
  createdAt: string;
  product: { sku: string; name: string };
  warehouse: { name: string };
};

type Warehouse = { id: string; name: string; code?: string };
type Product = { id: string; name: string; sku: string; unit?: string; barcode?: string | null; warehouses?: { warehouseId: string }[] };

const MOV_LABELS: Record<string, string> = {
  PURCHASE: 'شراء',
  SALE: 'بيع',
  PURCHASE_RETURN: 'مرتجع شراء',
  SALE_RETURN: 'مرتجع بيع',
  TRANSFER_IN: 'تحويل وارد',
  TRANSFER_OUT: 'تحويل صادر',
  ADJUSTMENT: 'تسوية',
};

export function StockPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'balances' | 'movements'>('balances');
  const [data, setData] = useState<{ items: StockItem[]; grandTotal: number; totalQty: number }>({
    items: [], grandTotal: 0, totalQty: 0,
  });
  const [movements, setMovements] = useState<Movement[]>([]);
  const [movPage, setMovPage] = useState(1);
  const [movPageSize, setMovPageSize] = useState(20);
  const [movTotal, setMovTotal] = useState(0);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouseId, setWarehouseId] = useState(() => params.get('warehouse') || '');
  const [search, setSearch] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [locOpen, setLocOpen] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupQ, setLookupQ] = useState('');
  const [lookupRows, setLookupRows] = useState<{ productId: string; warehouseId: string; quantity: number; sku: string; name: string; warehouseName: string }[]>([]);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [countForm, setCountForm] = useState({
    warehouseId: '',
    productId: '',
    quantity: '' as number | '',
    unitCost: '' as number | '',
    note: '',
    mode: 'set' as 'set' | 'delta',
  });
  const [expiryRows, setExpiryRows] = useState<{ name: string; sku: string; expiryDate: string; warehouseName: string; invoiceNumber: string; batchNumber?: string | null; expired: boolean; quantity: number }[]>([]);
  const [locations, setLocations] = useState<{ id: string; code: string; name: string }[]>([]);
  const [locForm, setLocForm] = useState({ warehouseId: '', code: '', name: '', productId: '', locationId: '' });
  const [detail, setDetail] = useState<StockItem | null>(null);
  const [fifo, setFifo] = useState<FifoDetail | null>(null);
  const [fifoLoading, setFifoLoading] = useState(false);
  const [editMov, setEditMov] = useState<Movement | null>(null);
  const [editBatch, setEditBatch] = useState<Batch | null>(null);
  const [movForm, setMovForm] = useState({
    quantity: '' as number | '',
    unitCost: '' as number | '',
    note: '',
    reference: '',
  });
  const [batchForm, setBatchForm] = useState({
    batchNumber: '',
    expiryDate: '',
    unitCost: '' as number | '',
  });
  const [form, setForm] = useState({
    fromWarehouseId: '',
    toWarehouseId: '',
    productId: '',
    quantity: '' as number | '',
    note: '',
  });

  async function load() {
    const q = new URLSearchParams();
    if (warehouseId) q.set('warehouseId', warehouseId);
    const qs = q.toString() ? `?${q}` : '';
    const mov = new URLSearchParams(q);
    mov.set('page', String(movPage));
    mov.set('pageSize', String(movPageSize));
    if (search.trim()) mov.set('search', search.trim());
    const [val, w, p, movPageResult] = await Promise.all([
      api<{ items: StockItem[]; grandTotal: number; totalQty: number }>(`/stock/valuation${qs}`),
      api<Warehouse[]>('/warehouses'),
      api<Product[]>('/products'),
      api<{ items: Movement[]; total: number }>(`/stock/movements?${mov}`),
    ]);
    setData(val);
    setWarehouses(w);
    setProducts(p);
    setMovements(movPageResult.items);
    setMovTotal(movPageResult.total);
    if (detail) {
      const refreshed = val.items.find((i) => i.id === detail.id);
      setDetail(refreshed || null);
    }
  }

  useEffect(() => { setMovPage(1); }, [search, warehouseId, movPageSize]);
  useEffect(() => {
    load();
  }, [warehouseId, search, movPage, movPageSize]);

  useEffect(() => {
    if (!detail) {
      setFifo(null);
      return;
    }
    setFifoLoading(true);
    api<FifoDetail>(`/stock/fifo?productId=${detail.productId}&warehouseId=${detail.warehouseId}`)
      .then(setFifo)
      .catch(() => setFifo(null))
      .finally(() => setFifoLoading(false));
  }, [detail]);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data.items;
    return data.items.filter((b) => {
      const hay = [
        b.product.name,
        b.product.sku,
        b.warehouse.name,
        ...b.batches.flatMap((batch) => [
          batch.invoiceNumber,
          batch.supplierName,
          batch.batchNumber || '',
        ]),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [data.items, search]);

  const visibleMovements = movements;
  const movPages = Math.max(1, Math.ceil(movTotal / movPageSize));
  const movFrom = movTotal === 0 ? 0 : (Math.min(movPage, movPages) - 1) * movPageSize + 1;
  const movTo = Math.min(Math.min(movPage, movPages) * movPageSize, movTotal);

  const visibleQty = visibleItems.reduce((s, i) => s + i.quantity, 0);
  const visibleCost = Math.round(visibleItems.reduce((s, i) => s + i.totalCost, 0) * 100) / 100;

  async function transfer() {
    await api('/stock/transfers', {
      method: 'POST',
      body: JSON.stringify({
        fromWarehouseId: form.fromWarehouseId,
        toWarehouseId: form.toWarehouseId,
        note: form.note,
        lines: [{ productId: form.productId, quantity: form.quantity === '' ? 0 : form.quantity }],
      }),
    });
    setTransferOpen(false);
    load();
  }

  function openEditMov(m: Movement) {
    setEditMov(m);
    setMovForm({
      quantity: m.quantity,
      unitCost: m.unitCost,
      note: m.note || '',
      reference: m.reference || '',
    });
  }

  async function saveMov() {
    if (!editMov) return;
    await api(`/stock/movements/${editMov.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quantity: movForm.quantity === '' ? 0 : movForm.quantity,
        unitCost: movForm.unitCost === '' ? 0 : movForm.unitCost,
        note: movForm.note || undefined,
        reference: movForm.reference || undefined,
      }),
    });
    setEditMov(null);
    load();
  }

  async function deleteMov(id: string) {
    const ok = await confirm({ title: 'حذف الحركة', message: 'حذف الحركة وتعديل الرصيد؟', confirmLabel: 'حذف', danger: true });
    if (!ok) return;
    try {
      await api(`/stock/movements/${id}`, { method: 'DELETE' });
      toast.success('تم حذف الحركة');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر الحذف');
    }
  }

  function openEditBatch(b: Batch) {
    setEditBatch(b);
    setBatchForm({
      batchNumber: b.batchNumber || '',
      expiryDate: b.expiryDate ? b.expiryDate.slice(0, 10) : '',
      unitCost: b.unitCost,
    });
  }

  async function saveBatch() {
    if (!editBatch) return;
    await api(`/stock/batches/${editBatch.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        batchNumber: batchForm.batchNumber,
        expiryDate: batchForm.expiryDate || '',
        unitCost: batchForm.unitCost === '' ? undefined : batchForm.unitCost,
      }),
    });
    setEditBatch(null);
    load();
  }

  async function deleteBatch(id: string) {
    const ok = await confirm({ title: 'حذف الدفعة', message: 'حذف الدفعة وخصم كميتها من المخزون؟', confirmLabel: 'حذف', danger: true });
    if (!ok) return;
    try {
      await api(`/stock/batches/${id}`, { method: 'DELETE' });
      toast.success('تم حذف الدفعة');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر الحذف');
    }
  }

  return (
    <div>
      <PageHeader
        title="المخزون"
        subtitle="الأرصدة · دفعات الشراء · التكلفة · الحركات"
        actions={
          <>
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer size={16} /> طباعة
            </Button>
            <Button variant="secondary" onClick={() => { setLookupOpen(true); setLookupQ(''); setLookupRows([]); }}>
              <Search size={16} /> بحث في مخازن أخرى
            </Button>
            <Button variant="secondary" onClick={() => {
              setCountForm({
                warehouseId: warehouseId || (warehouses.length === 1 ? warehouses[0].id : ''),
                productId: '',
                quantity: '',
                unitCost: '',
                note: '',
                mode: 'set',
              });
              setCountOpen(true);
            }}>جرد / رصيد افتتاحي</Button>
            <Button variant="secondary" onClick={async () => {
              setExpiryRows(await api('/stock/expiry?days=30'));
              setExpiryOpen(true);
            }}>صلاحية</Button>
            <Button variant="secondary" onClick={() => setLocOpen(true)}>مواقع المخزن</Button>
            <Button onClick={() => setTransferOpen(true)}>
              <ArrowLeftRight size={16} /> تحويل
            </Button>
          </>
        }
      />

      <PrintHeader
        title="تقرير المخزون والتكلفة"
        subtitle={warehouseId ? warehouses.find((w) => w.id === warehouseId)?.name : 'كل المخازن'}
      />

      <div className="no-print">
        <StatGrid>
          <StatCard label="أرصدة معروضة" value={visibleItems.length} hint={warehouseId ? warehouses.find((w) => w.id === warehouseId)?.name : 'كل المخازن'} icon={Boxes} tone="brand" />
          <StatCard label="إجمالي الكميات" value={visibleQty.toLocaleString('ar-EG')} hint="وحدة في المخزون" icon={PackageCheck} tone="emerald" />
          <StatCard label="تكلفة المخزون" value={formatMoney(visibleCost)} hint="بمتوسط تكلفة الدفعات" icon={Coins} tone="amber" />
          <StatCard label="أرصدة نفدت" value={visibleItems.filter((b) => b.quantity <= 0).length} hint="كمية صفر أو أقل" icon={PackageX} tone="rose" />
        </StatGrid>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 no-print">
        <div className="flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {([['balances', 'الأرصدة والدفعات'], ['movements', 'الحركات']] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)} className={`h-8 rounded-lg px-4 text-[13px] font-bold transition ${tab === key ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>
          ))}
        </div>
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="بحث صنف / كود / مخزن..."
          className="!w-72 max-w-full"
        />
        <Select className="!w-52" value={warehouseId} onChange={(e) => {
          const id = e.target.value;
          setWarehouseId(id);
          const next = new URLSearchParams(params);
          if (id) next.set('warehouse', id);
          else next.delete('warehouse');
          setParams(next, { replace: true });
        }}>
          <option value="">كل المخازن</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </Select>
      </div>

      {tab === 'balances' ? (
        <Card>
          {visibleItems.length === 0 ? <Empty text="لا توجد أرصدة" /> : (
            <Table>
              <thead>
                <tr>
                  <Th>المخزن</Th>
                  <Th>الكود</Th>
                  <Th>الصنف</Th>
                  <Th>الكمية</Th>
                  <Th>تكلفة الوحدة</Th>
                  <Th>إجمالي التكلفة</Th>
                  <Th>الدفعات</Th>
                  <Th className="no-print"></Th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((b) => (
                  <tr key={b.id} className={b.quantity <= 0 ? 'row-credit' : ''}>
                    <Td className="text-slate-600">{b.warehouse.name}</Td>
                    <Td><span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-700" dir="ltr">{b.product.sku}</span></Td>
                    <Td className="font-bold text-slate-900">{b.product.name}</Td>
                    <Td>
                      <span className={`font-extrabold ${b.quantity <= 0 ? 'text-rose-600' : 'text-slate-900'}`}>{b.quantity.toLocaleString('ar-EG')}</span>
                      <span className="ms-1 text-xs text-muted">{b.product.unit}</span>
                    </Td>
                    <Td className="whitespace-nowrap text-slate-600">{formatMoney(b.unitCost)}</Td>
                    <Td className="whitespace-nowrap font-extrabold text-brand-800">{formatMoney(b.totalCost)}</Td>
                    <Td><Badge tone="brand">{b.openLayers ?? b.batches.length} دفعة متاحة</Badge></Td>
                    <Td className="no-print">
                      <Button variant="ghost" onClick={() => setDetail(b)}>
                        <Eye size={14} /> تفاصيل
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-gradient-to-l from-brand-700 to-brand-900 px-5 py-3.5 text-white shadow-sm">
            <span className="text-sm font-semibold text-white/85">إجمالي تكلفة المخزون المعروض · {visibleQty.toLocaleString('ar-EG')} وحدة</span>
            <span className="text-xl font-extrabold tabular-nums">{formatMoney(visibleCost)}</span>
          </div>
        </Card>
      ) : (
        <Card>
          {visibleMovements.length === 0 ? <Empty text="لا توجد حركات" /> : (
            <Table>
              <thead>
                <tr>
                  <Th>التاريخ</Th>
                  <Th>النوع</Th>
                  <Th>المخزن</Th>
                  <Th>الصنف</Th>
                  <Th>الكمية</Th>
                  <Th>التكلفة</Th>
                  <Th>المرجع</Th>
                  <Th>ملاحظة / تشغيلة</Th>
                  <Th className="no-print"></Th>
                </tr>
              </thead>
              <tbody>
                {visibleMovements.map((m) => (
                  <tr key={m.id} className={`mov-${m.type}`}>
                    <Td className="whitespace-nowrap text-xs text-slate-500">{formatDate(m.createdAt)}</Td>
                    <Td><Badge tone={m.quantity > 0 ? 'emerald' : m.quantity < 0 ? 'rose' : 'slate'}>{MOV_LABELS[m.type] || m.type}</Badge></Td>
                    <Td className="text-slate-600">{m.warehouse.name}</Td>
                    <Td>
                      <div className="font-bold text-slate-900">{m.product.name}</div>
                      <div className="font-mono text-xs text-muted" dir="ltr">{m.product.sku}</div>
                    </Td>
                    <Td className={`font-extrabold ${m.quantity > 0 ? 'text-emerald-700' : 'text-rose-600'}`} ><bdi dir="ltr">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</bdi></Td>
                    <Td className="whitespace-nowrap text-slate-600">{formatMoney(m.unitCost)}</Td>
                    <Td><span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{m.reference || '—'}</span></Td>
                    <Td className="text-sm">{m.note || '—'}</Td>
                    <Td className="no-print">
                      <div className="flex gap-1">
                        <Button variant="ghost" className="!px-2" onClick={() => openEditMov(m)}>
                          <Pencil size={14} />
                        </Button>
                        <Button variant="ghost" className="!px-2 text-rose-600" onClick={() => deleteMov(m.id)}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <Pager page={movPage} pages={movPages} total={movTotal} from={movFrom} to={movTo} pageSize={movPageSize} onPageSize={setMovPageSize} onPage={setMovPage} />
        </Card>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `دفعات — ${detail.product.name}` : ''} wide>
        {detail && (
          <div className="space-y-4">
            <PrintHeader title={`دفعات شراء: ${detail.product.name}`} subtitle={detail.warehouse.name} />
            <div className="grid gap-2 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
              <div>المخزن: <strong>{detail.warehouse.name}</strong></div>
              <div>الكود: <strong className="font-mono">{detail.product.sku}</strong></div>
              <div>الرصيد الحالي: <strong>{detail.quantity} {detail.product.unit}</strong></div>
              <div>متوسط تكلفة الرصيد (FIFO): <strong>{formatMoney(detail.unitCost)}</strong></div>
              <div>البيع الجاي هيتسحب بتكلفة: <strong>{detail.nextCost != null ? formatMoney(detail.nextCost) : '—'}</strong></div>
              <div className="text-brand-800">
                إجمالي تكلفة الرصيد: <strong className="text-lg">{formatMoney(detail.totalCost)}</strong>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-bold text-slate-800">دفعات FIFO — الأقدم بيتباع الأول</div>
                {fifo && (
                  <div className="text-xs text-muted">
                    فاضل {fifo.remainingQty} {detail.product.unit} بقيمة {formatMoney(fifo.remainingValue)}
                  </div>
                )}
              </div>
              {fifoLoading && <div className="text-sm text-muted">جاري التحميل...</div>}
              {!fifoLoading && fifo && fifo.layers.length === 0 && <Empty text="لا توجد دفعات مسجلة لهذا الصنف في المخزن ده" />}
              {!fifoLoading && fifo && fifo.layers.length > 0 && (
                <div className="space-y-2">
                  {fifo.layers.map((layer, index) => (
                    <div key={layer.key} className={`rounded-xl border p-3 ${layer.remaining > 0.0001 ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-slate-50'}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone="slate">#{index + 1}</Badge>
                          <Badge tone={layer.type === 'PURCHASE' ? 'brand' : 'sky'}>{LAYER_LABELS[layer.type] || layer.type}</Badge>
                          {layer.reference && <span className="font-mono text-xs font-bold" dir="ltr">{layer.reference}</span>}
                          {layer.viaTransfer && <span className="text-xs text-muted">محوّلة بـ <bdi dir="ltr">{layer.viaTransfer}</bdi></span>}
                          {layer.partyName && <span className="text-xs text-slate-600">{layer.partyName}</span>}
                          {layer.date && <span className="text-xs text-muted">{formatDate(layer.date)}</span>}
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <span>دخل <b>{layer.quantity}</b></span>
                          <span>بسعر <b>{formatMoney(layer.unitCost)}</b></span>
                          <span className="text-rose-700">اتسحب <b>{layer.used}</b></span>
                          <span className={layer.remaining > 0.0001 ? 'font-extrabold text-emerald-700' : 'text-muted'}>
                            {layer.remaining > 0.0001 ? `فاضل ${layer.remaining}` : 'خلصت'}
                          </span>
                        </div>
                      </div>
                      {layer.consumed.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {layer.consumed.map((c, i) => (
                            <span key={i} className="rounded-lg bg-white px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-200">
                              {MOV_LABELS[c.type] || (c.type === 'TRIM' ? 'فرق رصيد' : c.type)}
                              {c.reference && <> <bdi dir="ltr" className="font-mono font-bold">{c.reference}</bdi></>}
                              {c.partyName && <> · {c.partyName}</>}
                              {' · '}<b>{c.quantity}</b>
                              {' · '}{formatDate(c.date)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {fifo.fallbackOuts.length > 0 && (
                    <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      فيه {fifo.fallbackOuts.reduce((s, o) => s + o.quantity, 0)} اتسحبت من غير دفعة مسجلة (رصيد قديم) واتحسبت بتكلفة الصنف الحالية.
                    </div>
                  )}
                </div>
              )}
            </div>

            {detail.product.fieldValues?.length > 0 && (
              <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-3">
                <div className="mb-2 text-sm font-semibold text-brand-800">حقول الصنف الإضافية</div>
                <div className="grid gap-1 text-sm sm:grid-cols-2">
                  {detail.product.fieldValues.map((fv, i) => (
                    <div key={i}>{fv.field.label}: <strong>{fv.value}</strong></div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-between no-print">
              <div className="text-sm font-semibold text-slate-700">دفعات الشراء (تشغيلة / صلاحية / سعر)</div>
              <Button variant="secondary" onClick={() => window.print()}><Printer size={14} /> طباعة</Button>
            </div>

            {detail.batches.length === 0 ? (
              <Empty text="لا توجد فواتير شراء مؤكدة لهذا الصنف في هذا المخزن" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>الفاتورة</Th>
                    <Th>التاريخ</Th>
                    <Th>المورد</Th>
                    <Th>الكمية</Th>
                    <Th>سعر الشراء</Th>
                    <Th>الإجمالي</Th>
                    <Th>التشغيلة</Th>
                    <Th>الصلاحية</Th>
                    <Th className="no-print"></Th>
                  </tr>
                </thead>
                <tbody>
                  {detail.batches.map((b) => (
                    <tr key={b.id} className="mov-PURCHASE">
                      <Td className="font-semibold">{b.invoiceNumber}</Td>
                      <Td>{formatDate(b.invoiceDate)}</Td>
                      <Td>{b.supplierName}</Td>
                      <Td className="font-bold">{b.quantity}</Td>
                      <Td>{formatMoney(b.unitCost)}</Td>
                      <Td className="font-bold">{formatMoney(b.total)}</Td>
                      <Td>
                        {b.batchNumber
                          ? <span className="rounded-lg bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-800">{b.batchNumber}</span>
                          : <span className="text-muted">—</span>}
                      </Td>
                      <Td>{b.expiryDate ? formatDate(b.expiryDate) : '—'}</Td>
                      <Td className="no-print">
                        <div className="flex gap-1">
                          <Button variant="ghost" className="!px-2" onClick={() => openEditBatch(b)}>
                            <Pencil size={14} />
                          </Button>
                          <Button variant="ghost" className="!px-2 text-rose-600" onClick={() => deleteBatch(b.id)}>
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        )}
      </Modal>

      <Modal open={lookupOpen} onClose={() => setLookupOpen(false)} title="بحث مخزون مخازن أخرى" wide>
        <div className="space-y-3">
          <p className="text-sm text-muted">عرض فقط — عشان توجّه العميل للمخزن اللي فيه الصنف. مفيش تعديل من هنا.</p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const q = lookupQ.trim();
              if (!q) return;
              setLookupBusy(true);
              try {
                setLookupRows(await api(`/stock/lookup?q=${encodeURIComponent(q)}`));
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'تعذر البحث');
              } finally {
                setLookupBusy(false);
              }
            }}
          >
            <Input
              className="!w-72 max-w-full"
              value={lookupQ}
              onChange={(e) => setLookupQ(e.target.value)}
              placeholder="اسم الصنف أو الكود أو الباركود"
            />
            <Button type="submit" disabled={lookupBusy || !lookupQ.trim()}>
              <Search size={16} /> بحث
            </Button>
          </form>
          {lookupRows.length === 0 ? (
            <Empty text={lookupQ.trim() ? 'مفيش رصيد متاح' : 'اكتب اسم الصنف وابحث'} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>الصنف</Th>
                  <Th>الكود</Th>
                  <Th>المخزن</Th>
                  <Th>الكمية</Th>
                </tr>
              </thead>
              <tbody>
                {lookupRows.map((row) => (
                  <tr key={`${row.productId}-${row.warehouseId}`}>
                    <Td className="font-bold">{row.name}</Td>
                    <Td><span className="font-mono text-xs" dir="ltr">{row.sku}</span></Td>
                    <Td><Badge tone="amber">{row.warehouseName}</Badge></Td>
                    <Td className="font-extrabold">{row.quantity.toLocaleString('ar-EG')}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Modal>

      <Modal open={countOpen} onClose={() => setCountOpen(false)} title={countForm.mode === 'set' ? 'جرد أو رصيد افتتاحي' : 'تسوية كمية'}>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Button variant={countForm.mode === 'set' ? 'primary' : 'secondary'} onClick={() => setCountForm({ ...countForm, mode: 'set' })}>رصيد فعلي</Button>
            <Button variant={countForm.mode === 'delta' ? 'primary' : 'secondary'} onClick={() => setCountForm({ ...countForm, mode: 'delta' })}>فرق +/-</Button>
          </div>
          <div>
            <Label>المخزن</Label>
            <Select value={countForm.warehouseId} onChange={(e) => setCountForm({ ...countForm, warehouseId: e.target.value, productId: '' })}>
              <option value="">اختر</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>الصنف</Label>
            <ProductPicker
              products={productsForWarehouse(products, countForm.warehouseId, [countForm.productId]).map((product) => ({
                id: product.id,
                name: product.name,
                sku: product.sku,
                barcode: product.barcode,
              }))}
              value={countForm.productId}
              disabled={!countForm.warehouseId}
              placeholder={countForm.warehouseId ? 'اكتب اسم الصنف' : 'اختر المخزن أولاً'}
              onChange={(productId) => setCountForm({ ...countForm, productId })}
            />
          </div>
          <div>
            <Label>{countForm.mode === 'set' ? 'الكمية المعدودة' : 'الفرق'}</Label>
            <NumberInput value={countForm.quantity} onValueChange={(v) => setCountForm({ ...countForm, quantity: v })} />
          </div>
          {(() => {
            const selected = products.find((p) => p.id === countForm.productId);
            const unitLabel = selected?.unit === 'كيلو' ? 'الكيلو' : 'القطعة';
            const qty = countForm.quantity === '' ? 0 : countForm.quantity;
            const cost = countForm.unitCost === '' ? 0 : countForm.unitCost;
            const totalCost = Math.round(Math.abs(qty) * cost * 100) / 100;
            return (
              <>
                <div>
                  <Label>تكلفة {unitLabel}</Label>
                  <NumberInput value={countForm.unitCost} onValueChange={(v) => setCountForm({ ...countForm, unitCost: v })} />
                  <p className="mt-1 text-xs text-muted">تدخل تكلفة {unitLabel} عشان يتسجل رصيدك بتكلفة صحيحة</p>
                </div>
                {(qty !== 0 || cost !== 0) && (
                  <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
                    <div className="text-muted">إجمالي تكلفة الرصيد</div>
                    <div className="font-extrabold text-slate-900">{formatMoney(totalCost)}</div>
                    <div className="text-xs text-muted">{Math.abs(qty).toLocaleString('ar-EG')} × {formatMoney(cost)}</div>
                  </div>
                )}
              </>
            );
          })()}
          <div><Label>ملاحظة</Label><Input value={countForm.note} onChange={(e) => setCountForm({ ...countForm, note: e.target.value })} /></div>
          <Button className="w-full" onClick={async () => {
            if (!countForm.warehouseId || !countForm.productId) {
              toast.error('اختَر المخزن والصنف');
              return;
            }
            try {
              await api('/stock/adjustments', {
                method: 'POST',
                body: JSON.stringify({
                  warehouseId: countForm.warehouseId,
                  mode: countForm.mode,
                  note: countForm.note,
                  lines: [{
                    productId: countForm.productId,
                    quantity: countForm.quantity === '' ? 0 : countForm.quantity,
                    unitCost: countForm.unitCost === '' ? undefined : countForm.unitCost,
                  }],
                }),
              });
              setCountOpen(false);
              setCountForm({ warehouseId: '', productId: '', quantity: '', unitCost: '', note: '', mode: 'set' });
              toast.success('تم حفظ الرصيد');
              load();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'تعذر حفظ الرصيد');
            }
          }}>حفظ</Button>
        </div>
      </Modal>

      <Modal open={expiryOpen} onClose={() => setExpiryOpen(false)} title="دفعات قرب انتهاء الصلاحية" wide>
        {expiryRows.length === 0 ? <Empty /> : (
          <Table>
            <thead><tr><Th>الصنف</Th><Th>المخزن</Th><Th>الفاتورة</Th><Th>التشغيلة</Th><Th>الكمية</Th><Th>الصلاحية</Th></tr></thead>
            <tbody>
              {expiryRows.map((row, i) => (
                <tr key={i} className={row.expired ? 'row-credit' : ''}>
                  <Td>{row.name}<div className="font-mono text-xs text-muted">{row.sku}</div></Td>
                  <Td>{row.warehouseName}</Td>
                  <Td>{row.invoiceNumber}</Td>
                  <Td>{row.batchNumber || '—'}</Td>
                  <Td>{row.quantity}</Td>
                  <Td>{formatDate(row.expiryDate)}{row.expired ? ' · منتهية' : ''}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Modal>

      <Modal open={locOpen} onClose={() => setLocOpen(false)} title="مواقع داخل المخزن">
        <div className="space-y-3">
          <div>
            <Label>المخزن</Label>
            <Select value={locForm.warehouseId} onChange={async (e) => {
              const warehouseId = e.target.value;
              setLocForm({ ...locForm, warehouseId });
              if (warehouseId) setLocations(await api(`/stock/locations?warehouseId=${warehouseId}`));
            }}>
              <option value="">اختر</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="كود الموقع" value={locForm.code} onChange={(e) => setLocForm({ ...locForm, code: e.target.value })} />
            <Input placeholder="اسم الرف" value={locForm.name} onChange={(e) => setLocForm({ ...locForm, name: e.target.value })} />
          </div>
          <Button variant="secondary" onClick={async () => {
            await api('/stock/locations', { method: 'POST', body: JSON.stringify({ warehouseId: locForm.warehouseId, code: locForm.code, name: locForm.name }) });
            setLocations(await api(`/stock/locations?warehouseId=${locForm.warehouseId}`));
          }}>إضافة موقع</Button>
          <div>
            <Label>ربط صنف بموقع</Label>
            <ProductPicker
              products={productsForWarehouse(products, locForm.warehouseId, [locForm.productId]).map((product) => ({
                id: product.id,
                name: product.name,
                sku: product.sku,
                barcode: product.barcode,
              }))}
              value={locForm.productId}
              disabled={!locForm.warehouseId}
              placeholder={locForm.warehouseId ? 'اكتب اسم الصنف' : 'اختر المخزن أولاً'}
              onChange={(productId) => setLocForm({ ...locForm, productId })}
            />
            <Select className="mt-2" value={locForm.locationId} onChange={(e) => setLocForm({ ...locForm, locationId: e.target.value })}>
              <option value="">الموقع</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.code} - {l.name}</option>)}
            </Select>
          </div>
          <Button className="w-full" onClick={async () => {
            await api('/stock/product-locations', {
              method: 'POST',
              body: JSON.stringify({ productId: locForm.productId, warehouseId: locForm.warehouseId, locationId: locForm.locationId }),
            });
            setLocOpen(false);
          }}>حفظ الربط</Button>
        </div>
      </Modal>

      <Modal open={transferOpen} onClose={() => setTransferOpen(false)} title="تحويل بين مخازن">
        <div className="space-y-3">
          <div>
            <Label>من مخزن</Label>
            <Select value={form.fromWarehouseId} onChange={(e) => setForm({ ...form, fromWarehouseId: e.target.value })}>
              <option value="">اختر</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>إلى مخزن</Label>
            <Select value={form.toWarehouseId} onChange={(e) => setForm({ ...form, toWarehouseId: e.target.value })}>
              <option value="">اختر</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>الصنف</Label>
            <ProductPicker
              products={productsForWarehouse(products, form.fromWarehouseId, [form.productId]).map((product) => ({
                id: product.id,
                name: product.name,
                sku: product.sku,
                barcode: product.barcode,
              }))}
              value={form.productId}
              disabled={!form.fromWarehouseId}
              placeholder={form.fromWarehouseId ? 'اكتب اسم الصنف' : 'اختر المخزن أولاً'}
              onChange={(productId) => setForm({ ...form, productId })}
            />
          </div>
          <div>
            <Label>الكمية المحوّلة</Label>
            <NumberInput value={form.quantity} onValueChange={(v) => setForm({ ...form, quantity: v })} />
          </div>
          <div><Label>ملاحظة</Label><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          <Button className="w-full" onClick={transfer}>تنفيذ التحويل</Button>
        </div>
      </Modal>

      <Modal open={!!editMov} onClose={() => setEditMov(null)} title="تعديل حركة مخزون">
        <div className="space-y-3">
          <div>
            <Label>الكمية (موجبة وارد / سالبة صادر)</Label>
            <NumberInput value={movForm.quantity} onValueChange={(v) => setMovForm({ ...movForm, quantity: v })} />
          </div>
          <div>
            <Label>تكلفة الوحدة</Label>
            <NumberInput value={movForm.unitCost} onValueChange={(v) => setMovForm({ ...movForm, unitCost: v })} />
          </div>
          <div>
            <Label>المرجع</Label>
            <Input value={movForm.reference} onChange={(e) => setMovForm({ ...movForm, reference: e.target.value })} />
          </div>
          <div>
            <Label>ملاحظة</Label>
            <Input value={movForm.note} onChange={(e) => setMovForm({ ...movForm, note: e.target.value })} />
          </div>
          <Button className="w-full" onClick={saveMov}>حفظ</Button>
        </div>
      </Modal>

      <Modal open={!!editBatch} onClose={() => setEditBatch(null)} title="تعديل دفعة شراء">
        <div className="space-y-3">
          <div>
            <Label>رقم التشغيلة</Label>
            <Input value={batchForm.batchNumber} onChange={(e) => setBatchForm({ ...batchForm, batchNumber: e.target.value })} />
          </div>
          <div>
            <Label>تاريخ الصلاحية</Label>
            <Input type="date" value={batchForm.expiryDate} onChange={(e) => setBatchForm({ ...batchForm, expiryDate: e.target.value })} />
          </div>
          <div>
            <Label>سعر الشراء للوحدة</Label>
            <NumberInput value={batchForm.unitCost} onValueChange={(v) => setBatchForm({ ...batchForm, unitCost: v })} />
          </div>
          <Button className="w-full" onClick={saveBatch}>حفظ</Button>
        </div>
      </Modal>
    </div>
  );
}
