import { useEffect, useRef, useState } from 'react';
import { Plus, Printer, Eye, Trash2, Pencil, ShoppingBag, Scale } from 'lucide-react';
import { ScrapSalesModal, scrapNumbers, WaterToggle } from '../components/ScrapSalesModal';
import { loadExcel } from '../lib/excel';
import { api, formatDate, formatMoney, initialQuery } from '../lib/api';
import { DueAmount } from '../components/DueAmount';
import { AddLineButton, EditorErrors, EditorSection, InvoiceEditor, LineCard, PriceHint, SummaryRow } from '../components/InvoiceEditor';
import { ProductPicker } from '../components/ProductPicker';
import { productsForWarehouse } from '../lib/productWarehouse';
import { TenderEditor, type PayMethodOption, type TenderPart } from '../components/TenderEditor';
import { useConfirm, useToast } from '../lib/feedback';
import { useColumns } from '../lib/columns';
import { IconAction, ListBar } from '../components/ListBar';
import {
  Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, Pager, PrintHeader, Select, StatusBadge, Table, Td, Th, todayIso,
} from '../components/ui';

type Party = { id: string; name: string };
type Product = { id: string; name: string; sku: string; costPrice: number; warehouses?: { warehouseId: string }[]; barcode?: string | null };
const emptyPart = (): TenderPart => ({ methodId: '', amount: '' });
type Line = {
  id?: string;
  productId: string;
  quantity: number | '';
  unitCost: number | '';
  discount: number | '';
  batchNumber: string;
  expiryDate: string;
};

type Invoice = {
  id: string;
  number: string;
  status: string;
  invoiceDate: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paidAmount: number;
  supplier: { id: string; name: string };
  warehouse: { id: string; name: string };
  lines: {
    id: string;
    productId: string;
    quantity: number;
    discount?: number;
    batchNumber?: string | null;
    expiryDate?: string | null;
    unitCost: number;
    total: number;
    product: { name: string; sku: string };
  }[];
  payments?: { id: string; paymentMethod: string; amount: number }[];
  scrapAmount?: number;
  scrapSale?: { id: string; number: string; withWater: boolean; waterPercent: number; grossKg: number; netKg: number; priceKg: number; amount: number; notes?: string | null } | null;
};

const emptyLine = (): Line => ({
  productId: '', quantity: '', unitCost: '', discount: '', batchNumber: '', expiryDate: '',
});
const num = (v: number | '') => (v === '' ? 0 : v);
const emptyScrap = () => ({ on: false, withWater: false, grossKg: '' as number | '', priceKg: '' as number | '', notes: '' });
const PURCHASE_VIEW = 'm5azen.purchasesView';
type PurchaseFilter = 'all' | 'DRAFT' | 'CONFIRMED' | 'PARTIAL' | 'PAID' | 'CANCELLED' | 'due';
const PURCHASE_FILTERS: { id: PurchaseFilter; label: string }[] = [
  { id: 'all', label: 'كل الفواتير' },
  { id: 'due', label: 'عليها متبقي' },
  { id: 'PAID', label: 'مدفوعة' },
  { id: 'PARTIAL', label: 'سداد جزئي' },
  { id: 'CONFIRMED', label: 'مؤكدة' },
  { id: 'DRAFT', label: 'مسودة' },
  { id: 'CANCELLED', label: 'ملغاة' },
];

function owed(inv: { status: string; total: number; paidAmount: number }) {
  if (inv.status === 'CANCELLED') return 0;
  return Math.max(0, inv.total - inv.paidAmount);
}

export function PurchasesPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [items, setItems] = useState<Invoice[]>([]);
  const [listPage, setListPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ count: 0, total: 0, paid: 0, due: 0, red: 0, yellow: 0, green: 0 });
  const requestKey = useRef('');
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [warehouses, setWarehouses] = useState<Party[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [methods, setMethods] = useState<PayMethodOption[]>([]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Invoice | null>(null);
  const [search, setSearch] = useState(initialQuery);
  const [status, setStatus] = useState<PurchaseFilter>('all');
  const [listView, setListView] = useState<'table' | 'cards'>(() => (localStorage.getItem(PURCHASE_VIEW) === 'cards' ? 'cards' : 'table'));
  const [form, setForm] = useState({
    supplierId: '',
    warehouseId: '',
    discount: '' as number | '',
    tax: '' as number | '',
    payments: [emptyPart()] as TenderPart[],
    notes: '',
    confirm: true,
  });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [scrap, setScrap] = useState(emptyScrap);
  const [scrapListOpen, setScrapListOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const [priceHints, setPriceHints] = useState<Record<string, { lastSupplier: number | null; lastSale: number | null }>>({});

  async function loadLookups() {
    const [s, w, p, m] = await Promise.all([
      api<Party[]>('/suppliers'),
      api<Party[]>('/warehouses'),
      api<Product[]>('/products'),
      api<PayMethodOption[]>('/cash/methods'),
    ]);
    setSuppliers(s);
    setWarehouses(w);
    setProducts(p);
    setMethods(m);
  }

  async function load() {
    const params = new URLSearchParams({ page: String(listPage), pageSize: String(pageSize) });
    if (search.trim()) params.set('q', search.trim());
    if (status === 'due') params.set('due', '1');
    else if (status !== 'all') params.set('status', status);
    const inv = await api<{ items: Invoice[]; total: number; summary: typeof summary }>(`/purchases?${params}`);
    setItems(inv.items);
    setTotal(inv.total);
    setSummary(inv.summary);
  }

  useEffect(() => { loadLookups().catch(() => undefined); }, []);
  useEffect(() => {
    const params = new URLSearchParams();
    if (form.supplierId) params.set('supplierId', form.supplierId);
    if (editingId) params.set('excludeInvoiceId', editingId);
    api<{ productId: string; lastSupplier: number | null; lastSale: number | null }[]>(`/purchases/price-hints?${params}`)
      .then((rows) => {
        const map: Record<string, { lastSupplier: number | null; lastSale: number | null }> = {};
        rows.forEach((row) => { map[row.productId] = row; });
        setPriceHints(map);
      })
      .catch(() => setPriceHints({}));
  }, [form.supplierId, editingId]);
  useEffect(() => { setListPage(1); }, [search, status, pageSize]);
  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch(() => undefined); }, 200);
    return () => window.clearTimeout(timer);
  }, [listPage, pageSize, search, status]);

  const filtered = items;
  const dueCounts = { red: summary.red, yellow: summary.yellow, green: summary.green };
  const formDueDate = (editingId ? items.find((row) => row.id === editingId)?.invoiceDate : '') || todayIso();
  const stats = summary;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageFrom = total === 0 ? 0 : (listPage - 1) * pageSize + 1;
  const pageTo = Math.min(listPage * pageSize, total);
  const purchaseColumns = useColumns('m5azen.cols.purchases', [
    { id: 'number', label: 'الرقم' },
    { id: 'supplier', label: 'المورد' },
    { id: 'warehouse', label: 'المخزن' },
    { id: 'date', label: 'التاريخ' },
    { id: 'total', label: 'الإجمالي' },
    { id: 'paid', label: 'المدفوع' },
    { id: 'due', label: 'المتبقي' },
    { id: 'status', label: 'الحالة' },
  ]);

  useEffect(() => {
    const open = new URLSearchParams(window.location.search).get('open');
    if (!open || !items.length) return;
    const invoice = items.find((row) => row.id === open || row.number === open);
    if (invoice) setView(invoice);
  }, [items]);

  function updateLine(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      if (patch.productId) {
        const prod = products.find((p) => p.id === patch.productId);
        if (prod) next.unitCost = prod.costPrice;
      }
      return next;
    }));
  }

  const linesTotal = lines.reduce((s, l) => s + num(l.quantity) * num(l.unitCost) - num(l.discount), 0);
  const afterDiscount = linesTotal - num(form.discount);
  const taxPercent = num(form.tax);
  const taxAmount = Math.round(afterDiscount * taxPercent * 100) / 10000;
  const scrapCalc = scrap.on ? scrapNumbers(num(scrap.grossKg), num(scrap.priceKg), scrap.withWater) : { netKg: 0, amount: 0 };
  const grossTotal = afterDiscount + taxAmount;
  const grand = Math.round((grossTotal - scrapCalc.amount) * 100) / 100;
  const paidNow = form.payments.reduce((sum, part) => sum + num(part.amount), 0);
  const remaining = Math.max(0, grand - paidNow);
  const filledLines = lines.filter((l) => l.productId);
  const badLine = (l: Line) => !!l.productId && !(num(l.quantity) > 0);
  const formErrors = [
    !form.supplierId && 'اختر المورد',
    !form.warehouseId && 'اختر المخزن',
    !filledLines.length && 'أضف صنفًا واحدًا على الأقل',
    lines.some(badLine) && 'كل بند لازم يكون له كمية أكبر من صفر',
    paidNow > grand + 0.009 && 'المدفوع أكبر من إجمالي الفاتورة',
    scrap.on && !(num(scrap.grossKg) > 0) && 'أدخل وزن الخردة',
    scrap.on && !(num(scrap.priceKg) > 0) && 'أدخل سعر كيلو الخردة',
    scrap.on && grand < -0.009 && 'قيمة الخردة أكبر من الفاتورة — سجّلها كبيع خردة منفصل',
    form.confirm && form.payments.some((part) => num(part.amount) > 0 && !part.methodId) && 'اختر طريقة الدفع لكل جزء',
  ].filter(Boolean) as string[];

  async function save() {
    setTriedSave(true);
    if (formErrors.length) return;
    setSaving(true);
    try {
      if (!editingId && !requestKey.current) requestKey.current = crypto.randomUUID();
      await api(editingId ? `/purchases/${editingId}` : '/purchases', {
        method: editingId ? 'PATCH' : 'POST',
        headers: editingId ? undefined : { 'x-idempotency-key': requestKey.current },
        body: JSON.stringify({
          supplierId: form.supplierId,
          warehouseId: form.warehouseId,
          discount: num(form.discount),
          tax: taxPercent,
          notes: form.notes || undefined,
          confirm: form.confirm,
          scrap: scrap.on
            ? { withWater: scrap.withWater, grossKg: num(scrap.grossKg), priceKg: num(scrap.priceKg), notes: scrap.notes || undefined }
            : null,
          payments: form.payments.filter((part) => num(part.amount) > 0).map((part) => ({ id: part.id, methodId: part.methodId, amount: num(part.amount) })),
          lines: filledLines.map((l) => ({
            id: l.id,
            productId: l.productId,
            quantity: num(l.quantity),
            unitCost: num(l.unitCost),
            discount: num(l.discount),
            batchNumber: l.batchNumber || undefined,
            expiryDate: l.expiryDate || undefined,
          })),
        }),
      });
      requestKey.current = '';
      toast.success(editingId ? 'تم تعديل الفاتورة' : 'تم حفظ الفاتورة');
      setEditingId(null);
      setOpen(false);
      setTriedSave(false);
      setForm({
        supplierId: '', warehouseId: '', discount: '', tax: '', payments: [emptyPart()], notes: '', confirm: true,
      });
      setLines([emptyLine()]);
      setScrap(emptyScrap());
      load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'تعذر حفظ الفاتورة');
    } finally {
      setSaving(false);
    }
  }

  function printInvoice(inv: Invoice) {
    setView(inv);
    setTimeout(() => window.print(), 300);
  }

  function editInvoice(inv: Invoice) {
    setEditingId(inv.id);
    setTriedSave(false);
    setForm({
      supplierId: inv.supplier.id,
      warehouseId: inv.warehouse.id,
      discount: inv.discount,
      tax: inv.subtotal - inv.discount > 0 ? Math.round((inv.tax / (inv.subtotal - inv.discount)) * 10000) / 100 : 0,
      payments: inv.payments?.length
        ? inv.payments.map((payment) => ({ id: payment.id, methodId: payment.paymentMethod, amount: payment.amount }))
        : [emptyPart()],
      notes: '',
      confirm: true,
    });
    setLines(inv.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      quantity: l.quantity,
      unitCost: l.unitCost,
      discount: l.discount || '',
      batchNumber: l.batchNumber || '',
      expiryDate: l.expiryDate ? l.expiryDate.slice(0, 10) : '',
    })));
    setScrap(inv.scrapSale
      ? { on: true, withWater: inv.scrapSale.withWater, grossKg: inv.scrapSale.grossKg, priceKg: inv.scrapSale.priceKg, notes: inv.scrapSale.notes || '' }
      : emptyScrap());
    setView(null);
    setOpen(true);
  }

  async function removeInvoice(id: string) {
    const ok = await confirm({
      title: 'حذف فاتورة الشراء',
      message: 'حذف الفاتورة وإلغاء أثرها على المخزون والحسابات؟',
      confirmLabel: 'حذف',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/purchases/${id}`, { method: 'DELETE' });
      if (view?.id === id) setView(null);
      toast.success('تم حذف الفاتورة');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر حذف الفاتورة');
    }
  }

  function openInvoiceForm() {
    setEditingId(null);
    setTriedSave(false);
    setForm({
      supplierId: '', warehouseId: warehouses.length === 1 ? warehouses[0].id : '', discount: '', tax: '', payments: [emptyPart()], notes: '', confirm: true,
    });
    setLines([emptyLine()]);
    setScrap(emptyScrap());
    setOpen(true);
  }

  async function exportRows() {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (status === 'due') params.set('due', '1');
    else if (status !== 'all') params.set('status', status);
    const rows = await api<Invoice[]>(`/purchases${params.toString() ? `?${params}` : ''}`);
    const ExcelJS = await loadExcel();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('المشتريات');
    sheet.addRow(['الرقم', 'المورد', 'المخزن', 'التاريخ', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة']);
    rows.forEach((inv) => sheet.addRow([inv.number, inv.supplier.name, inv.warehouse.name, formatDate(inv.invoiceDate), inv.total, inv.paidAmount, owed(inv), inv.status]));
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer]));
    link.download = 'purchases.xlsx';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div>
      <PageHeader
        title="المشتريات"
        subtitle="فواتير الموردين ودخول المخزون"
        actions={(
          <>
            <Button variant="secondary" onClick={() => setScrapListOpen(true)}><Scale size={16} /> بيع خردة لمورد</Button>
            <Button onClick={openInvoiceForm}><Plus size={16} /> فاتورة شراء</Button>
          </>
        )}
      />
      <ScrapSalesModal open={scrapListOpen} onClose={() => setScrapListOpen(false)} onChanged={() => load()} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {([
          { key: 'all' as const, label: 'فواتير الشراء', value: String(stats.count), hint: 'كل الحالات', stripe: 'bg-brand-700' },
          { key: 'all' as const, label: 'إجمالي المشتريات', value: formatMoney(stats.total), hint: 'بدون الملغى', stripe: 'bg-brand-500' },
          { key: 'PAID' as const, label: 'المدفوع للموردين', value: formatMoney(stats.paid), hint: 'سداد على الفواتير', stripe: 'bg-emerald-600' },
          { key: 'due' as const, label: 'المتبقي للموردين', value: formatMoney(stats.due), hint: 'ذمم لم تُسدَّد', stripe: stats.due > 0 ? 'bg-rose-600' : 'bg-emerald-600' },
        ]).map((card) => (
          <button key={card.label} type="button" onClick={() => setStatus(card.key)} className={`overflow-hidden rounded-2xl border bg-white text-right shadow-sm ${status === card.key && card.key !== 'all' ? 'border-brand-700 ring-2 ring-brand-700/30' : 'border-slate-200'}`}>
            <div className={`h-1 ${card.stripe}`} />
            <div className="px-4 py-3">
              <div className="text-xs font-bold text-muted">{card.label}</div>
              <div className="mt-1 text-xl font-extrabold text-slate-900">{card.value}</div>
              <div className="mt-1 text-[11px] text-muted">{card.hint}</div>
            </div>
          </button>
        ))}
      </div>
      <Card>
        {(dueCounts.red + dueCounts.yellow + dueCounts.green) > 0 && (
          <div className="mb-3 flex flex-wrap gap-2 text-xs font-bold">
            {dueCounts.red > 0 && <span className="rounded-full bg-rose-100 px-3 py-1 text-rose-700">متأخر: {dueCounts.red}</span>}
            {dueCounts.yellow > 0 && <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">أقل من 5 أيام: {dueCounts.yellow}</span>}
            {dueCounts.green > 0 && <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-800">باقي 5 أيام: {dueCounts.green}</span>}
          </div>
        )}
        <ListBar
          search={search}
          onSearch={setSearch}
          placeholder="بحث برقم الفاتورة أو المورد"
          view={listView}
          onView={(mode) => { setListView(mode); localStorage.setItem(PURCHASE_VIEW, mode); }}
          onExport={exportRows}
          columns={purchaseColumns.columns}
          onToggleColumn={purchaseColumns.toggle}
          filterActive={status !== 'all'}
          filter={(
            <div className="space-y-1">
              <div className="mb-2 text-xs font-bold text-muted">حالة الفاتورة</div>
              {PURCHASE_FILTERS.map((item) => (
                <button key={item.id} type="button" className={`block w-full rounded-lg px-2 py-1.5 text-right text-sm ${status === item.id ? 'bg-brand-700 font-bold text-white' : 'hover:bg-slate-50'}`} onClick={() => setStatus(item.id)}>{item.label}</button>
              ))}
            </div>
          )}
        />
        {filtered.length === 0 ? <Empty text="لا توجد فواتير مطابقة" hint="غيّر البحث أو حالة الفاتورة" /> : listView === 'cards' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((inv) => (
                <div key={inv.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-brand-700">{inv.number}</div>
                      <div className="mt-1 truncate text-base font-extrabold">{inv.supplier.name}</div>
                      <div className="mt-1 text-xs text-muted">{inv.warehouse.name} · {formatDate(inv.invoiceDate)}</div>
                    </div>
                    <StatusBadge status={inv.status} />
                  </div>
                  <div className="mt-4 flex items-end justify-between gap-3">
                    <div>
                      <div className="text-xs text-muted">الإجمالي</div>
                      <div className="font-extrabold">{formatMoney(inv.total)}</div>
                      <div className="mt-1"><DueAmount date={inv.invoiceDate} remaining={owed(inv)} /></div>
                    </div>
                    <div className="flex gap-1">
                      <IconAction label="عرض" onClick={() => setView(inv)}><Eye size={14} /></IconAction>
                      <IconAction label="تعديل" onClick={() => editInvoice(inv)}><Pencil size={14} /></IconAction>
                      <IconAction label="طباعة" onClick={() => printInvoice(inv)}><Printer size={14} /></IconAction>
                      <IconAction label="حذف" danger onClick={() => removeInvoice(inv.id)}><Trash2 size={14} /></IconAction>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <Pager page={listPage} pages={pageCount} total={total} from={pageFrom} to={pageTo} pageSize={pageSize} onPageSize={setPageSize} onPage={setListPage} />
          </>
        ) : (
          <>
          <Table>
            <thead>
              <tr>
                {purchaseColumns.visible('status') && <Th>الحالة</Th>}
                {purchaseColumns.visible('due') && <Th>المتبقي</Th>}
                {purchaseColumns.visible('paid') && <Th>المدفوع</Th>}
                {purchaseColumns.visible('total') && <Th>الإجمالي</Th>}
                {purchaseColumns.visible('date') && <Th>التاريخ</Th>}
                {purchaseColumns.visible('warehouse') && <Th>المخزن</Th>}
                {purchaseColumns.visible('supplier') && <Th>المورد</Th>}
                {purchaseColumns.visible('number') && <Th>الرقم</Th>}
                <Th>الإجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((inv) => (
                <tr key={inv.id} className={`status-${inv.status}`}>
                  {purchaseColumns.visible('status') && <Td><StatusBadge status={inv.status} /></Td>}
                  {purchaseColumns.visible('due') && <Td><DueAmount date={inv.invoiceDate} remaining={owed(inv)} /></Td>}
                  {purchaseColumns.visible('paid') && <Td>{formatMoney(inv.paidAmount)}</Td>}
                  {purchaseColumns.visible('total') && <Td className="font-semibold">{formatMoney(inv.total)}</Td>}
                  {purchaseColumns.visible('date') && <Td>{formatDate(inv.invoiceDate)}</Td>}
                  {purchaseColumns.visible('warehouse') && <Td>{inv.warehouse.name}</Td>}
                  {purchaseColumns.visible('supplier') && <Td className="font-semibold">{inv.supplier.name}</Td>}
                  {purchaseColumns.visible('number') && <Td className="font-mono text-xs font-bold text-brand-800">{inv.number}</Td>}
                  <Td>
                    <div className="flex gap-1">
                      <IconAction label="عرض" onClick={() => setView(inv)}><Eye size={14} /></IconAction>
                      <IconAction label="تعديل" onClick={() => editInvoice(inv)}><Pencil size={14} /></IconAction>
                      <IconAction label="طباعة" onClick={() => printInvoice(inv)}><Printer size={14} /></IconAction>
                      <IconAction label="حذف" danger onClick={() => removeInvoice(inv.id)}><Trash2 size={14} /></IconAction>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pager page={listPage} pages={pageCount} total={total} from={pageFrom} to={pageTo} pageSize={pageSize} onPageSize={setPageSize} onPage={setListPage} />
          </>
        )}
      </Card>

      <InvoiceEditor
        open={open}
        title={editingId ? 'تعديل فاتورة شراء' : 'فاتورة شراء جديدة'}
        subtitle="اختار المورد والمخزن، ضيف الأصناف والتشغيلات، وسجّل المدفوع"
        icon={<ShoppingBag size={18} />}
        total={grand}
        onClose={() => { setOpen(false); setEditingId(null); }}
        side={(
          <>
            <div className="text-sm font-extrabold text-slate-800">الحساب والدفع</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>خصم الفاتورة</Label>
                <NumberInput value={form.discount} onValueChange={(v) => setForm({ ...form, discount: v })} />
              </div>
              <div>
                <Label>الضريبة %</Label>
                <NumberInput value={form.tax} onValueChange={(v) => setForm({ ...form, tax: v })} />
              </div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
              <label className="flex items-center gap-2 text-sm font-bold text-amber-900">
                <input
                  type="checkbox"
                  checked={scrap.on}
                  onChange={(e) => setScrap(e.target.checked ? { ...scrap, on: true } : emptyScrap())}
                />
                بيع خردة للمورد ده وخصمها من الفاتورة
              </label>
              {scrap.on && (
                <div className="mt-2 space-y-2">
                  <WaterToggle value={scrap.withWater} onChange={(withWater) => setScrap({ ...scrap, withWater })} />
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label>الوزن (كجم)</Label>
                      <NumberInput value={scrap.grossKg} onValueChange={(v) => setScrap({ ...scrap, grossKg: v })} />
                    </div>
                    <div>
                      <Label>سعر الكيلو</Label>
                      <NumberInput value={scrap.priceKg} onValueChange={(v) => setScrap({ ...scrap, priceKg: v })} />
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-amber-900">
                    <span>الصافي {scrapCalc.netKg} كجم{scrap.withWater ? ' (بعد خصم المياه)' : ''}</span>
                    <b>{formatMoney(scrapCalc.amount)}</b>
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label>المدفوع الآن</Label>
              <button
                type="button"
                className="shrink-0 rounded-xl border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-bold text-brand-700 hover:bg-brand-100"
                onClick={() => setForm({
                  ...form,
                  payments: [{
                    methodId: form.payments[0]?.methodId || methods.find((method) => method.kind === 'IMMEDIATE')?.id || methods[0]?.id || '',
                    amount: Math.round(grand * 100) / 100,
                  }],
                })}
              >
                كامل
              </button>
            </div>
            <TenderEditor methods={methods} parts={form.payments} onChange={(payments) => setForm({ ...form, payments })} />
            <div>
              <Label>ملاحظات</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="رقم فاتورة المورد مثلًا" />
            </div>
            <div className="mt-auto space-y-2 rounded-2xl bg-brand-900 px-4 py-4 text-sm">
              <SummaryRow label={`البنود (${filledLines.length})`} value={formatMoney(linesTotal)} />
              <SummaryRow label="خصم الفاتورة" value={formatMoney(num(form.discount))} />
              <SummaryRow label={`الضريبة (${taxPercent}%)`} value={formatMoney(taxAmount)} />
              {scrapCalc.amount > 0 && <SummaryRow label="خردة مخصومة" value={`− ${formatMoney(scrapCalc.amount)}`} />}
              <SummaryRow label="الإجمالي" value={formatMoney(grand)} strong />
              <SummaryRow label="المدفوع" value={formatMoney(paidNow)} />
              <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2 font-bold text-slate-900">
                <span>المتبقي</span>
                <DueAmount date={formDueDate} remaining={remaining} />
              </div>
            </div>
            <label className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm">
              <input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} />
              تأكيد فوري (إضافة للمخزون وتحديث رصيد المورد)
            </label>
            {triedSave && <EditorErrors errors={formErrors} />}
            <Button className="w-full !py-3 text-base" onClick={save} disabled={saving}>
              {saving ? 'جاري الحفظ...' : editingId ? 'حفظ التعديل' : 'حفظ الفاتورة'}
            </Button>
          </>
        )}
      >
        <EditorSection title="بيانات الفاتورة">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>المورد</Label>
              <Select className={triedSave && !form.supplierId ? 'border-rose-300' : ''} value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                <option value="">اختر المورد</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>المخزن المستلم</Label>
              <Select className={triedSave && !form.warehouseId ? 'border-rose-300' : ''} value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}>
                <option value="">اختر المخزن</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
          </div>
        </EditorSection>

        <EditorSection title={`بنود الفاتورة (${filledLines.length})`} action={<AddLineButton onClick={() => setLines((prev) => [...prev, emptyLine()])} />}>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <LineCard
                key={i}
                index={i}
                total={Math.max(0, num(l.quantity) * num(l.unitCost) - num(l.discount))}
                invalid={triedSave && badLine(l)}
                canRemove={lines.length > 1}
                onRemove={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <div className="grid gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-6">
                    <Label>الصنف</Label>
                    <ProductPicker
                      products={productsForWarehouse(products, form.warehouseId, lines.map((line) => line.productId)).map((product) => ({
                        id: product.id,
                        name: product.name,
                        sku: product.sku,
                        barcode: product.barcode,
                      }))}
                      value={l.productId}
                      disabled={!form.warehouseId}
                      placeholder={form.warehouseId ? 'اكتب اسم الصنف' : 'اختر المخزن أولاً'}
                      onChange={(productId) => updateLine(i, { productId })}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <PriceHint label="آخر شراء من المورد" value={l.productId ? priceHints[l.productId]?.lastSupplier : null} />
                  </div>
                  <div className="sm:col-span-3">
                    <PriceHint label="آخر سعر بيع" value={l.productId ? priceHints[l.productId]?.lastSale : null} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>الكمية</Label>
                    <NumberInput value={l.quantity} onValueChange={(v) => updateLine(i, { quantity: v })} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>تكلفة الوحدة</Label>
                    <NumberInput value={l.unitCost} onValueChange={(v) => updateLine(i, { unitCost: v })} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>خصم البند</Label>
                    <NumberInput value={l.discount} onValueChange={(v) => updateLine(i, { discount: v })} />
                  </div>
                  <div className="sm:col-span-6">
                    <Label>رقم التشغيلة (اختياري)</Label>
                    <Input value={l.batchNumber} onChange={(e) => updateLine(i, { batchNumber: e.target.value })} placeholder="LOT-001" />
                  </div>
                  <div className="sm:col-span-6">
                    <Label>تاريخ الصلاحية (اختياري)</Label>
                    <Input type="date" value={l.expiryDate} onChange={(e) => updateLine(i, { expiryDate: e.target.value })} />
                  </div>
                </div>
              </LineCard>
            ))}
          </div>
        </EditorSection>
      </InvoiceEditor>

      <Modal open={!!view} onClose={() => setView(null)} title={`فاتورة ${view?.number || ''}`} wide>
        {view && (
          <div>
            <PrintHeader title={`فاتورة شراء ${view.number}`} subtitle={view.supplier.name} />
            <div className="mb-4 overflow-hidden rounded-2xl bg-brand-900 px-5 py-4 text-white no-print">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-brand-200">فاتورة شراء</div>
                  <div className="text-2xl font-extrabold">{view.number}</div>
                  <div className="mt-1 text-sm text-brand-100">{view.supplier.name} · {view.warehouse.name} · {formatDate(view.invoiceDate)}</div>
                </div>
                <StatusBadge status={view.status} />
              </div>
              <div className="mt-4 grid gap-3 border-t border-white/10 pt-3 sm:grid-cols-3">
                <div><div className="text-[11px] text-brand-200">الإجمالي</div><div className="text-lg font-extrabold">{formatMoney(view.total)}</div></div>
                <div><div className="text-[11px] text-brand-200">المدفوع</div><div className="text-lg font-extrabold">{formatMoney(view.paidAmount)}</div></div>
                <div><div className="text-[11px] text-brand-200">المتبقي</div><div className="mt-1 inline-flex rounded-xl bg-white px-2 py-1">{view.status === 'CANCELLED' ? <span className="font-bold text-emerald-700">{formatMoney(0)}</span> : <DueAmount date={view.invoiceDate} remaining={owed(view)} />}</div></div>
              </div>
            </div>
            <div className="mb-4 flex justify-end gap-2 no-print">
              <Button variant="secondary" onClick={() => window.print()}><Printer size={14} /> طباعة / PDF</Button>
              <Button variant="secondary" onClick={() => editInvoice(view)}><Pencil size={14} /> تعديل</Button>
              <Button variant="danger" onClick={() => removeInvoice(view.id)}><Trash2 size={14} /> حذف</Button>
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>الصنف</Th>
                  <Th>كمية</Th>
                  <Th>تكلفة</Th>
                  <Th>تشغيلة</Th>
                  <Th>صلاحية</Th>
                  <Th>الإجمالي</Th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((l, i) => (
                  <tr key={i}>
                    <Td>{l.product.name}</Td>
                    <Td>{l.quantity}</Td>
                    <Td>{formatMoney(l.unitCost)}</Td>
                    <Td>{l.batchNumber || '—'}</Td>
                    <Td>{l.expiryDate ? formatDate(l.expiryDate) : '—'}</Td>
                    <Td>{formatMoney(l.total)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="mt-4 space-y-1 text-sm">
              {view.scrapSale && (
                <div className="flex justify-between rounded-lg bg-amber-50 px-2 py-1 text-amber-900">
                  <span>
                    خردة مخصومة {view.scrapSale.number} · {view.scrapSale.netKg} كجم
                    {view.scrapSale.withWater ? ` (قائم ${view.scrapSale.grossKg} − ${view.scrapSale.waterPercent}% مياه)` : ''}
                    {' × '}{formatMoney(view.scrapSale.priceKg)}
                  </span>
                  <span>− {formatMoney(view.scrapSale.amount)}</span>
                </div>
              )}
              <div className="flex justify-between"><span>المدفوع</span><span>{formatMoney(view.paidAmount)}</span></div>
              <div className="flex justify-between font-bold">
                <span>المتبقي</span>
                {view.status === 'CANCELLED' ? <span>{formatMoney(0)}</span> : <DueAmount date={view.invoiceDate} remaining={view.total - view.paidAmount} />}
              </div>
              <div className="flex justify-between text-lg font-extrabold">
                <span>الإجمالي</span>
                <span>{formatMoney(view.total)}</span>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
