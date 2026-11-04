import { useEffect, useId, useRef, useState } from 'react';
import { Printer, Eye, ShoppingCart, Receipt, Trash2, Pencil, Scale } from 'lucide-react';
import { ScrapSalesModal } from '../components/ScrapSalesModal';
import { loadExcel } from '../lib/excel';
import { api, formatDate, formatMoney, initialQuery, productImageUrl } from '../lib/api';
import { DueAmount } from '../components/DueAmount';
import { AddLineButton, EditorErrors, EditorSection, InvoiceEditor, LineCard, PriceHint, SummaryRow } from '../components/InvoiceEditor';
import { ProductPicker } from '../components/ProductPicker';
import { productsForWarehouse } from '../lib/productWarehouse';
import { TenderEditor, type PayMethodOption, type TenderPart } from '../components/TenderEditor';
import { useConfirm, usePrompt, useToast } from '../lib/feedback';
import { useAccess } from '../lib/auth';
import { useColumns } from '../lib/columns';
import { IconAction, ListBar } from '../components/ListBar';
import {
  Button, Card, Empty, Input, Label, Modal, NumberInput, PageHeader, Pager, PrintHeader, Select, StatusBadge, Table, Td, Th, todayIso,
} from '../components/ui';

type Party = { id: string; name: string; code?: string; priceList?: string };
type Product = {
  id: string;
  name: string;
  sku: string;
  salePrice: number;
  wholesalePrice?: number;
  barcode?: string | null;
  imageFile?: string | null;
  warehouses?: { warehouseId: string }[];
};
type StockRow = { productId: string; quantity: number; product: Product };
const WALK_IN_NAME = 'عميل سريع';
type Account = { id: string; name: string };
type Line = { id?: string; productId: string; quantity: number | ''; unitPrice: number | ''; discount: number | '' };

type Invoice = {
  id: string;
  number: string;
  status: string;
  invoiceDate: string;
  total: number;
  paidAmount: number;
  discount: number;
  tax: number;
  subtotal: number;
  notes?: string | null;
  taxRate?: number;
  hasScrap?: boolean;
  scrapKg?: number;
  scrapPieces?: number;
  scrapPriceKg?: number;
  scrapAmount?: number;
  scrapKind?: string;
  customer: { id: string; name: string };
  warehouse: { id: string; name: string };
  lines: { id: string; productId: string; quantity: number; unitPrice: number; unitCost?: number; discount?: number; total: number; product: { name: string; sku: string } }[];
  receipts?: { id: string; number: string; amount: number; paymentMethod: string; receivedAt: string; note?: string | null }[];
};

type CostPreview = {
  unitCost?: number;
  totalCost?: number;
  shortage: number;
  allocations: { quantity: number; unitCost?: number; reference: string | null; supplierName: string | null; fallback?: boolean }[];
};

/** ربح الفاتورة = (البنود − الخصم + قيمة الخردة المستلمة) − تكلفة البضاعة بالـ FIFO */
function invoiceProfit(inv: Invoice) {
  if (inv.lines.some((l) => l.unitCost === undefined)) return null;
  const cost = inv.lines.reduce((s, l) => s + l.quantity * (l.unitCost || 0), 0);
  const revenue = inv.subtotal - inv.discount + (inv.scrapAmount || 0);
  return { revenue, cost, profit: Math.round((revenue - cost) * 100) / 100 };
}

const emptyLine = (): Line => ({ productId: '', quantity: '', unitPrice: '', discount: '' });
const emptyPart = (): TenderPart => ({ methodId: '', amount: '' });

function CustomerPicker({
  customers,
  value,
  invalid,
  onChange,
}: {
  customers: Party[];
  value: string;
  invalid?: boolean;
  onChange: (name: string) => void;
}) {
  const listId = useId();
  const ordered = [...customers].sort((a, b) => {
    if (a.name === WALK_IN_NAME) return -1;
    if (b.name === WALK_IN_NAME) return 1;
    return a.name.localeCompare(b.name, 'ar');
  });
  return (
    <>
      <Input
        list={listId}
        value={value}
        className={invalid ? 'border-rose-300' : ''}
        placeholder={WALK_IN_NAME}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {ordered.map((c) => <option key={c.id} value={c.name} />)}
      </datalist>
    </>
  );
}
const num = (v: number | '') => (v === '' ? 0 : v);
const SALE_VIEW = 'm5azen.salesView';
type SaleFilter = 'all' | 'DRAFT' | 'CONFIRMED' | 'PARTIAL' | 'PAID' | 'CANCELLED' | 'due';
const SALE_FILTERS: { id: SaleFilter; label: string }[] = [
  { id: 'all', label: 'كل الفواتير' },
  { id: 'due', label: 'عليها متبقي' },
  { id: 'PAID', label: 'مدفوعة' },
  { id: 'PARTIAL', label: 'تحصيل جزئي' },
  { id: 'CONFIRMED', label: 'مؤكدة' },
  { id: 'DRAFT', label: 'مسودة' },
  { id: 'CANCELLED', label: 'ملغاة' },
];

function owed(inv: { status: string; total: number; paidAmount: number }) {
  if (inv.status === 'CANCELLED') return 0;
  return Math.max(0, inv.total - inv.paidAmount);
}

export function SalesPage() {
  const confirm = useConfirm();
  const promptText = usePrompt();
  const toast = useToast();
  const [items, setItems] = useState<Invoice[]>([]);
  const [listPage, setListPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ count: 0, total: 0, paid: 0, due: 0, red: 0, yellow: 0, green: 0 });
  const requestKey = useRef('');
  const [customers, setCustomers] = useState<Party[]>([]);
  const [warehouses, setWarehouses] = useState<Party[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [methods, setMethods] = useState<PayMethodOption[]>([]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Invoice | null>(null);
  const [scrapOpen, setScrapOpen] = useState(false);
  const access = useAccess();
  const canSeeCost = access.see('sales', 'cost');
  const canSeeProfit = access.see('sales', 'profit');
  const [costPreview, setCostPreview] = useState<Record<number, CostPreview>>({});
  const [saleFifo, setSaleFifo] = useState<{
    lines: {
      lineId: string;
      name: string;
      quantity: number;
      unitPrice: number;
      total?: number;
      unitCost: number;
      allocations: { quantity: number; unitCost: number; reference: string | null; viaTransfer: string | null; supplierName: string | null; fallback?: boolean }[];
    }[];
  } | null>(null);
  useEffect(() => {
    if (!view || view.status === 'DRAFT') {
      setSaleFifo(null);
      return;
    }
    api<NonNullable<typeof saleFifo>>(`/sales/${view.id}/fifo`).then(setSaleFifo).catch(() => setSaleFifo(null));
  }, [view?.id, view?.status]);
  const [search, setSearch] = useState(initialQuery);
  const [status, setStatus] = useState<SaleFilter>('all');
  const [listView, setListView] = useState<'table' | 'cards'>(() => (localStorage.getItem(SALE_VIEW) === 'cards' ? 'cards' : 'table'));
  const [stockByWh, setStockByWh] = useState<Record<string, { qty: Record<string, number>; products: Product[] }>>({});
  const [editCredit, setEditCredit] = useState<{ warehouseId: string; qty: Record<string, number>; posted: boolean } | null>(null);
  const [form, setForm] = useState({
    customerName: WALK_IN_NAME,
    warehouseId: '',
    discount: '' as number | '',
    tax: '' as number | '',
    payments: [emptyPart()] as TenderPart[],
    notes: '',
    confirm: true,
    hasScrap: false,
    scrapKind: 'SCRAP' as 'SCRAP' | 'WARRANTY_SWAP',
    scrapKg: '' as number | '',
    scrapPieces: '' as number | '',
    scrapPriceKg: '' as number | '',
  });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [posOpen, setPosOpen] = useState(false);
  const [posSearch, setPosSearch] = useState('');
  const [posCart, setPosCart] = useState<Line[]>([]);
  const [posForm, setPosForm] = useState({
    customerName: WALK_IN_NAME,
    warehouseId: '',
    discount: '' as number | '',
    payments: [emptyPart()] as TenderPart[],
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const [shift, setShift] = useState<{ id: string; openingCash: number; account: { name: string } } | null>(null);
  const [useShift, setUseShift] = useState(false);
  const [customerPrices, setCustomerPrices] = useState<Record<string, number>>({});
  const [priceHints, setPriceHints] = useState<Record<string, { lastPurchase: number | null; lastCustomer: number | null }>>({});

  async function loadLookups() {
    const [c, w, p, a, m] = await Promise.all([
      api<Party[]>('/customers'),
      api<Party[]>('/warehouses'),
      api<Product[]>('/products'),
      api<Account[]>('/cash/accounts'),
      api<PayMethodOption[]>('/cash/methods'),
    ]);
    setCustomers(c);
    setWarehouses(w);
    setProducts(p);
    setAccounts(a);
    setMethods(m);
    api<{ id: string; openingCash: number; account: { name: string } } | null>('/finance/shifts/current')
      .then((row) => setShift(row))
      .catch(() => setShift(null));
  }

  async function load() {
    const params = new URLSearchParams({ page: String(listPage), pageSize: String(pageSize) });
    if (search.trim()) params.set('q', search.trim());
    if (status === 'due') params.set('due', '1');
    else if (status !== 'all') params.set('status', status);
    const inv = await api<{ items: Invoice[]; total: number; summary: typeof summary }>(`/sales?${params}`);
    setItems(inv.items);
    setTotal(inv.total);
    setSummary(inv.summary);
  }

  const selectedCustomer = customers.find((c) => c.name.trim() === form.customerName.trim());

  useEffect(() => {
    if (!selectedCustomer) {
      setCustomerPrices({});
      return;
    }
    api<{ productId: string; price: number }[]>(`/customers/${selectedCustomer.id}/prices`)
      .then((rows) => {
        const map: Record<string, number> = {};
        rows.forEach((row) => { map[row.productId] = row.price; });
        setCustomerPrices(map);
      })
      .catch(() => setCustomerPrices({}));
  }, [selectedCustomer?.id]);

  const hintCustomerName = posOpen ? posForm.customerName : form.customerName;
  const hintCustomer = customers.find((customer) => customer.name.trim() === hintCustomerName.trim());

  useEffect(() => {
    const params = new URLSearchParams();
    if (hintCustomer) params.set('customerId', hintCustomer.id);
    if (!posOpen && editingId) params.set('excludeInvoiceId', editingId);
    api<{ productId: string; lastPurchase: number | null; lastCustomer: number | null }[]>(`/sales/price-hints?${params}`)
      .then((rows) => {
        const map: Record<string, { lastPurchase: number | null; lastCustomer: number | null }> = {};
        rows.forEach((row) => { map[row.productId] = row; });
        setPriceHints(map);
      })
      .catch(() => setPriceHints({}));
  }, [hintCustomer?.id, editingId, posOpen]);

  function priceFor(product: Product, customerName = form.customerName) {
    if (customerPrices[product.id] && customerName.trim() === form.customerName.trim()) return customerPrices[product.id];
    const customer = customers.find((c) => c.name.trim() === customerName.trim());
    if (customer?.priceList === 'WHOLESALE' && (product.wholesalePrice || 0) > 0) return product.wholesalePrice || 0;
    return product.salePrice;
  }

  useEffect(() => { loadLookups().catch(() => undefined); }, []);
  useEffect(() => { setListPage(1); }, [search, status, pageSize]);
  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch(() => undefined); }, 200);
    return () => window.clearTimeout(timer);
  }, [listPage, pageSize, search, status]);

  async function loadStock(warehouseId: string) {
    if (!warehouseId) return;
    const rows = await api<StockRow[]>(`/stock/balances?warehouseId=${encodeURIComponent(warehouseId)}`);
    const qty: Record<string, number> = {};
    const list: Product[] = [];
    rows.forEach((row) => {
      qty[row.product.id] = row.quantity;
      if (row.quantity > 0) list.push(row.product);
    });
    setStockByWh((prev) => ({ ...prev, [warehouseId]: { qty, products: list } }));
  }

  useEffect(() => {
    if (form.warehouseId) loadStock(form.warehouseId).catch(() => undefined);
  }, [form.warehouseId]);

  useEffect(() => {
    if (posForm.warehouseId) loadStock(posForm.warehouseId).catch(() => undefined);
  }, [posForm.warehouseId]);

  function stockOf(warehouseId: string) {
    return stockByWh[warehouseId] || { qty: {}, products: [] };
  }

  function availableQty(productId: string, warehouseId: string) {
    const onHand = stockOf(warehouseId).qty[productId] || 0;
    if (editCredit?.posted && editCredit.warehouseId === warehouseId) return onHand + (editCredit.qty[productId] || 0);
    return onHand;
  }

  function productsForSale(warehouseId: string, selectedIds: string[] = []) {
    return productsForWarehouse(products, warehouseId, selectedIds);
  }

  async function resolveCustomer(name: string) {
    const trimmed = name.trim();
    const found = customers.find((c) => c.name.trim() === trimmed);
    if (found) return found.id;
    const created = await api<Party>('/customers/by-name', {
      method: 'POST',
      body: JSON.stringify({ name: trimmed }),
    });
    setCustomers((prev) => prev.some((c) => c.id === created.id) ? prev : [...prev, created].sort((a, b) => a.name.localeCompare(b.name, 'ar')));
    return created.id;
  }

  const filtered = items;
  const dueCounts = { red: summary.red, yellow: summary.yellow, green: summary.green };
  const formDueDate = (editingId ? items.find((row) => row.id === editingId)?.invoiceDate : '') || todayIso();
  const stats = summary;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageFrom = total === 0 ? 0 : (listPage - 1) * pageSize + 1;
  const pageTo = Math.min(listPage * pageSize, total);
  const saleColumns = useColumns('m5azen.cols.sales', [
    { id: 'number', label: 'الرقم' },
    { id: 'customer', label: 'العميل' },
    { id: 'warehouse', label: 'المخزن' },
    { id: 'date', label: 'التاريخ' },
    { id: 'total', label: 'الإجمالي' },
    { id: 'paid', label: 'المدفوع' },
    { id: 'due', label: 'المتبقي' },
    { id: 'status', label: 'الحالة' },
    ...(canSeeProfit ? [{ id: 'profit', label: 'الربح' }] : []),
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
        if (prod) next.unitPrice = priceFor(prod);
      }
      return next;
    }));
  }

  function addLineAfterProduct(i: number, productId: string) {
    setLines((prev) => {
      const next = prev.map((l, idx) => {
        if (idx !== i) return l;
        const prod = products.find((p) => p.id === productId);
        return {
          ...l,
          productId,
          unitPrice: prod ? priceFor(prod) : l.unitPrice,
          quantity: l.quantity === '' ? 1 : l.quantity,
        };
      });
      const hasEmptyAfter = next.slice(i + 1).some((l) => !l.productId);
      return hasEmptyAfter ? next : [...next, emptyLine()];
    });
    window.setTimeout(() => {
      document.querySelector<HTMLInputElement>(`input[data-product-line="${i + 1}"]`)?.focus();
    }, 30);
  }

  const previewKey = lines.map((l) => `${l.productId}:${num(l.quantity)}`).join(',');
  useEffect(() => {
    if (!open || !canSeeCost || !form.warehouseId || !lines.some((l) => l.productId && num(l.quantity) > 0)) {
      setCostPreview({});
      return;
    }
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ warehouseId: form.warehouseId, lines: previewKey });
      if (editingId) params.set('excludeInvoiceId', editingId);
      api<CostPreview[]>(`/sales/fifo-preview?${params}`)
        .then((rows) => {
          const map: Record<number, CostPreview> = {};
          rows.forEach((row, i) => { map[i] = row; });
          setCostPreview(map);
        })
        .catch(() => setCostPreview({}));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open, canSeeCost, form.warehouseId, previewKey, editingId]);

  const linesTotal = lines.reduce((s, l) => s + num(l.quantity) * num(l.unitPrice) - num(l.discount), 0);
  const taxAmount = Math.round((linesTotal - num(form.discount)) * num(form.tax) * 100) / 10000;
  const scrapAmount = form.hasScrap ? Math.round(num(form.scrapKg) * num(form.scrapPriceKg) * 100) / 100 : 0;
  // المطلوب من العميل فلوس — الخردة بتتسلّم عيني وبتدخل في الإيراد والربح بس
  const grand = linesTotal - num(form.discount) + taxAmount;
  const costKnown = canSeeCost && lines.some((l, i) => l.productId && costPreview[i]?.unitCost !== undefined);
  const formCost = lines.reduce((s, l, i) => s + (l.productId ? costPreview[i]?.totalCost || 0 : 0), 0);
  const formRevenue = linesTotal - num(form.discount) + scrapAmount;
  const formProfit = Math.round((formRevenue - formCost) * 100) / 100;
  const paidNow = form.payments.reduce((sum, part) => sum + num(part.amount), 0);
  const remaining = Math.max(0, grand - paidNow);
  const filledLines = lines.filter((l) => l.productId);
  const badLine = (l: Line) => !!l.productId && !(num(l.quantity) > 0);
  const overStock = lines.some((l) => l.productId && num(l.quantity) > availableQty(l.productId, form.warehouseId) + 0.0001);
  const showScrapSection = !!form.warehouseId && form.customerName.trim().length >= 2;
  const formErrors = [
    form.customerName.trim().length < 2 && 'اكتب اسم العميل',
    !form.warehouseId && 'اختر المخزن',
    !filledLines.length && 'أضف صنفًا واحدًا على الأقل',
    lines.some(badLine) && 'كل بند لازم يكون له كمية أكبر من صفر',
    overStock && 'الكمية أكبر من المتاح في المخزن',
    form.hasScrap && !(num(form.scrapPieces) >= 1) && 'أدخل عدد البطاريات القديمة',
    form.hasScrap && form.scrapKind === 'SCRAP' && !(num(form.scrapKg) > 0) && 'أدخل وزن الخردة بالكيلو',
    form.hasScrap && form.scrapKind === 'SCRAP' && !(num(form.scrapPriceKg) > 0) && 'أدخل سعر كيلو الخردة',
    paidNow > grand + 0.009 && 'المدفوع أكبر من إجمالي الفاتورة',
    form.confirm && form.payments.some((part) => num(part.amount) > 0 && !part.methodId) && 'اختر طريقة الدفع لكل جزء',
  ].filter(Boolean) as string[];

  const posGross = posCart.reduce((s, l) => s + num(l.quantity) * num(l.unitPrice), 0);
  const posDiscount = num(posForm.discount);
  const posNet = Math.max(0, Math.round((posGross - posDiscount) * 100) / 100);
  const posEntered = posForm.payments.reduce((sum, part) => sum + num(part.amount), 0);
  const posPaid = posEntered > 0 ? posEntered : (posForm.payments[0]?.methodId ? posNet : 0);
  const posRemaining = Math.max(0, posNet - posPaid);
  const posProducts = productsForSale(posForm.warehouseId).filter((p) => {
    const q = posSearch.trim().toLowerCase();
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q);
  });

  function playAddSound() {
    const audio = new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(740, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1180, audio.currentTime + 0.07);
    gain.gain.setValueAtTime(0.05, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.16);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.17);
    osc.onended = () => audio.close();
  }

  function addPosProduct(p: Product) {
    if (!posForm.warehouseId) {
      toast.error('اختر المخزن أولاً');
      return;
    }
    const onHand = availableQty(p.id, posForm.warehouseId);
    const inCart = posCart.find((l) => l.productId === p.id);
    if (num(inCart?.quantity || 0) + 1 > onHand + 0.0001) {
      toast.error(`المتاح من ${p.name} هو ${onHand}`);
      return;
    }
    playAddSound();
    setPosCart((prev) => {
      const idx = prev.findIndex((l) => l.productId === p.id);
      if (idx >= 0) {
        return prev.map((l, i) => i === idx ? { ...l, quantity: num(l.quantity) + 1 } : l);
      }
      return [...prev, { productId: p.id, quantity: 1, unitPrice: priceFor(p, posForm.customerName), discount: '' }];
    });
  }

  function openPos() {
    setPosCart([]);
    setPosSearch('');
    setEditCredit(null);
    setPosForm({
      customerName: WALK_IN_NAME,
      warehouseId: warehouses.length === 1 ? warehouses[0].id : '',
      discount: '',
      payments: [{ methodId: methods.find((method) => method.kind === 'IMMEDIATE')?.id || methods[0]?.id || '', amount: '' }],
    });
    setPosOpen(true);
  }

  async function save() {
    setTriedSave(true);
    if (formErrors.length) return;
    setSaving(true);
    try {
    const customerId = await resolveCustomer(form.customerName);
    const payload = {
      customerId,
      warehouseId: form.warehouseId,
      discount: num(form.discount),
      taxRate: num(form.tax),
      payments: form.payments.filter((part) => num(part.amount) > 0).map((part) => ({ id: part.id, methodId: part.methodId, amount: num(part.amount) })),
      notes: form.notes || undefined,
      confirm: form.confirm,
      shiftId: useShift && shift ? shift.id : undefined,
      hasScrap: form.hasScrap,
      scrapKind: form.hasScrap ? form.scrapKind : 'SCRAP',
      scrapKg: form.hasScrap ? num(form.scrapKg) : 0,
      scrapPieces: form.hasScrap ? num(form.scrapPieces) : 0,
      scrapPriceKg: form.hasScrap ? num(form.scrapPriceKg) : 0,
      lines: lines.filter((l) => l.productId).map((l) => ({
        id: l.id,
        productId: l.productId,
        quantity: num(l.quantity),
        unitPrice: num(l.unitPrice),
        discount: num(l.discount),
      })),
    };
      if (!editingId && !requestKey.current) requestKey.current = crypto.randomUUID();
      await api(editingId ? `/sales/${editingId}` : '/sales', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
        headers: editingId ? undefined : { 'x-idempotency-key': requestKey.current },
      });
      requestKey.current = '';
      toast.success(editingId ? 'تم تعديل الفاتورة' : 'تم حفظ الفاتورة');
      setEditingId(null);
      setOpen(false);
      setTriedSave(false);
      setForm({
        customerName: WALK_IN_NAME, warehouseId: '', discount: '', tax: '', payments: [emptyPart()], notes: '', confirm: true,
        hasScrap: false, scrapKind: 'SCRAP', scrapKg: '', scrapPieces: '', scrapPriceKg: '',
      });
      setLines([emptyLine()]);
      setEditCredit(null);
      load();
      loadStock(form.warehouseId);
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

  async function removeInvoice(id: string) {
    const ok = await confirm({
      title: 'حذف فاتورة البيع',
      message: 'حذف الفاتورة وإلغاء أثرها على المخزون والحسابات؟',
      confirmLabel: 'حذف',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/sales/${id}`, { method: 'DELETE' });
      if (view?.id === id) setView(null);
      toast.success('تم حذف الفاتورة');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر حذف الفاتورة');
    }
  }

  async function editInvoice(inv: Invoice) {
    setEditingId(inv.id);
    setTriedSave(false);
    const credit: Record<string, number> = {};
    if (inv.status !== 'DRAFT') {
      inv.lines.forEach((l) => { credit[l.productId] = (credit[l.productId] || 0) + l.quantity; });
    }
    setEditCredit({ warehouseId: inv.warehouse.id, qty: credit, posted: inv.status !== 'DRAFT' });
    setForm({
      customerName: inv.customer.name,
      warehouseId: inv.warehouse.id,
      discount: inv.discount,
      tax: inv.taxRate || 0,
      payments: inv.receipts?.length
        ? inv.receipts.map((receipt) => ({ id: receipt.id, methodId: receipt.paymentMethod, amount: receipt.amount }))
        : [emptyPart()],
      notes: inv.notes || '',
      confirm: true,
      hasScrap: !!inv.hasScrap,
      scrapKind: inv.scrapKind === 'WARRANTY_SWAP' ? 'WARRANTY_SWAP' : 'SCRAP',
      scrapKg: inv.hasScrap ? (inv.scrapKg || '') : '',
      scrapPieces: inv.hasScrap ? (inv.scrapPieces || '') : '',
      scrapPriceKg: inv.hasScrap ? (inv.scrapPriceKg || '') : '',
    });
    setLines(inv.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount || '',
    })));
    setView(null);
    setOpen(true);
  }

  async function openShift() {
    const accountId = accounts[0]?.id;
    if (!accountId) {
      toast.error('أضف حساب خزنة أولاً');
      return;
    }
    const raw = await promptText({ title: 'رصيد بداية الوردية', defaultValue: '0', confirmLabel: 'فتح' });
    if (raw == null) return;
    const opening = Number(raw || '0');
    const row = await api<{ id: string; openingCash: number; account: { name: string } }>('/finance/shifts', {
      method: 'POST',
      body: JSON.stringify({ cashAccountId: accountId, openingCash: opening }),
    });
    setShift(row);
    setUseShift(false);
    toast.success('تم فتح الوردية');
  }

  async function closeShift() {
    if (!shift) return;
    const raw = await promptText({ title: 'النقدية المعدودة في الدرج', defaultValue: String(shift.openingCash), confirmLabel: 'قفل' });
    if (raw == null) return;
    const closing = Number(raw || '0');
    const closed = await api<{ difference: number }>(`/finance/shifts/${shift.id}/close`, {
      method: 'POST',
      body: JSON.stringify({ closingCash: closing }),
    });
    toast.success(`اتقفلت الوردية. الفرق: ${formatMoney(closed.difference)}`);
    setShift(null);
    setUseShift(false);
  }

  async function scanPosBarcode() {
    const code = posSearch.trim();
    if (!code) return;
    try {
      if (!posForm.warehouseId) {
        toast.error('اختر المخزن أولاً');
        return;
      }
      const product = await api<Product>(`/products/barcode/${encodeURIComponent(code)}`);
      const onHand = availableQty(product.id, posForm.warehouseId);
      if (onHand <= 0) {
        toast.error('الصنف مش موجود في المخزن ده');
        return;
      }
      addPosProduct(product);
      setPosSearch('');
    } catch {
      /* البحث بالاسم يفضل ظاهر */
    }
  }

  async function savePos() {
    if (posDiscount > posGross + 0.001) {
      toast.error('الخصم أكبر من إجمالي السلة');
      return;
    }
    if (posNet > 0 && posForm.payments.some((part) => num(part.amount) > 0 && !part.methodId)) {
      toast.error('اختر طريقة الدفع لكل جزء');
      return;
    }
    const payments = posEntered > 0
      ? posForm.payments.filter((part) => num(part.amount) > 0).map((part) => ({ methodId: part.methodId, amount: num(part.amount) }))
      : (posForm.payments[0]?.methodId && posNet > 0
        ? [{ methodId: posForm.payments[0].methodId, amount: posNet }]
        : []);
    if (posForm.customerName.trim().length < 2) {
      toast.error('اكتب اسم العميل');
      return;
    }
    if (!posForm.warehouseId) {
      toast.error('اختر المخزن');
      return;
    }
    if (posCart.some((l) => l.productId && num(l.quantity) > availableQty(l.productId, posForm.warehouseId) + 0.0001)) {
      toast.error('الكمية أكبر من المتاح في المخزن');
      return;
    }
    try {
    const customerId = await resolveCustomer(posForm.customerName);
    if (!requestKey.current) requestKey.current = crypto.randomUUID();
    const created = await api<Invoice>('/sales', {
      method: 'POST',
      headers: { 'x-idempotency-key': requestKey.current },
      body: JSON.stringify({
        customerId,
        warehouseId: posForm.warehouseId,
        discount: posDiscount,
        taxRate: 0,
        payments,
        shiftId: useShift && shift ? shift.id : undefined,
        confirm: true,
        lines: posCart.filter((l) => l.productId && num(l.quantity) > 0).map((l) => ({
          productId: l.productId,
          quantity: num(l.quantity),
          unitPrice: num(l.unitPrice),
          discount: 0,
        })),
      }),
    });
    requestKey.current = '';
    setPosOpen(false);
    load();
    loadStock(posForm.warehouseId);
    const wantPrint = await confirm({
      title: 'طباعة الفاتورة',
      message: `فاتورة ${created.number} اتسجلت. تطبعها دلوقتي؟`,
      confirmLabel: 'طباعة',
      cancelLabel: 'لا',
    });
    if (wantPrint) printInvoice(created);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'تعذر إتمام البيع');
    }
  }

  function openInvoiceForm() {
    setEditingId(null);
    setTriedSave(false);
    setEditCredit(null);
    setForm({
      customerName: WALK_IN_NAME,
      warehouseId: warehouses.length === 1 ? warehouses[0].id : '',
      discount: '',
      tax: '',
      payments: [emptyPart()],
      notes: '',
      confirm: true,
      hasScrap: false,
      scrapKind: 'SCRAP',
      scrapKg: '',
      scrapPieces: '',
      scrapPriceKg: '',
    });
    setLines([emptyLine()]);
    setOpen(true);
  }

  async function exportRows() {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (status === 'due') params.set('due', '1');
    else if (status !== 'all') params.set('status', status);
    const rows = await api<Invoice[]>(`/sales${params.toString() ? `?${params}` : ''}`);
    const ExcelJS = await loadExcel();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('المبيعات');
    sheet.addRow(['الرقم', 'العميل', 'المخزن', 'التاريخ', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة']);
    rows.forEach((inv) => sheet.addRow([inv.number, inv.customer.name, inv.warehouse.name, formatDate(inv.invoiceDate), inv.total, inv.paidAmount, owed(inv), inv.status]));
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer]));
    link.download = 'sales.xlsx';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div>
      <PageHeader
        title="المبيعات"
        subtitle="نقطة البيع وفواتير العملاء والتحصيل"
        actions={<Button variant="secondary" onClick={() => setScrapOpen(true)}><Scale size={16} /> بيع خردة لمورد</Button>}
      />
      <ScrapSalesModal open={scrapOpen} onClose={() => setScrapOpen(false)} />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {([
          { key: 'all' as const, label: 'فواتير البيع', value: String(stats.count), hint: 'كل الحالات', stripe: 'bg-brand-700' },
          { key: 'all' as const, label: 'إجمالي المبيعات', value: formatMoney(stats.total), hint: 'بدون الملغى', stripe: 'bg-brand-500' },
          { key: 'PAID' as const, label: 'المحصّل', value: formatMoney(stats.paid), hint: 'مدفوع على الفواتير', stripe: 'bg-emerald-600' },
          { key: 'due' as const, label: 'المتبقي على العملاء', value: formatMoney(stats.due), hint: 'ذمم لم تُحصَّل', stripe: stats.due > 0 ? 'bg-rose-600' : 'bg-emerald-600' },
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

      <div className="mb-4 grid gap-3 lg:grid-cols-[1.2fr_1fr_1.1fr]">
        <button type="button" onClick={openPos} className="rounded-2xl bg-gradient-to-br from-brand-700 to-brand-950 p-5 text-right text-white shadow-sm">
          <span className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-white/10"><ShoppingCart size={20} /></span>
          <div className="text-lg font-extrabold">نقطة البيع</div>
          <div className="mt-1 text-sm text-brand-100">بيع سريع بالصورة والصوت، ثم التحصيل</div>
        </button>
        <button type="button" onClick={openInvoiceForm} className="rounded-2xl border border-slate-200 bg-white p-5 text-right shadow-sm hover:border-brand-300">
          <span className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-brand-50 text-brand-700"><Receipt size={20} /></span>
          <div className="text-lg font-extrabold text-slate-900">فاتورة مبيعات</div>
          <div className="mt-1 text-sm text-muted">خصم، ضريبة، وتحصيل جزئي</div>
        </button>
        <div className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          {shift ? (
            <>
              <div>
                <div className="text-xs font-bold text-brand-700">وردية مفتوحة</div>
                <div className="mt-1 font-extrabold">{shift.account?.name}</div>
                <div className="mt-1 text-sm text-muted">رصيد البداية {formatMoney(shift.openingCash)}</div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={useShift} onChange={(e) => setUseShift(e.target.checked)} />
                  احسب البيع على الوردية
                </label>
                <Button variant="secondary" onClick={closeShift}>قفل الوردية</Button>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="text-xs font-bold text-muted">الوردية</div>
                <div className="mt-1 font-extrabold">البيع متاح من غيرها</div>
                <div className="mt-1 text-sm text-muted">افتح وردية لو عايز تقفل الصندوق في آخر اليوم</div>
              </div>
              <Button className="mt-3" variant="secondary" onClick={openShift}>فتح وردية</Button>
            </>
          )}
        </div>
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
          placeholder="بحث برقم الفاتورة أو العميل"
          view={listView}
          onView={(mode) => { setListView(mode); localStorage.setItem(SALE_VIEW, mode); }}
          onExport={exportRows}
          columns={saleColumns.columns}
          onToggleColumn={saleColumns.toggle}
          filterActive={status !== 'all'}
          filter={(
            <div className="space-y-1">
              <div className="mb-2 text-xs font-bold text-muted">حالة الفاتورة</div>
              {SALE_FILTERS.map((item) => (
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
                      <div className="mt-1 truncate text-base font-extrabold">{inv.customer.name}</div>
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
                {canSeeProfit && saleColumns.visible('profit') && <Th>الربح</Th>}
                {saleColumns.visible('status') && <Th>الحالة</Th>}
                {saleColumns.visible('due') && <Th>المتبقي</Th>}
                {saleColumns.visible('paid') && <Th>المدفوع</Th>}
                {saleColumns.visible('total') && <Th>الإجمالي</Th>}
                {saleColumns.visible('date') && <Th>التاريخ</Th>}
                {saleColumns.visible('warehouse') && <Th>المخزن</Th>}
                {saleColumns.visible('customer') && <Th>العميل</Th>}
                {saleColumns.visible('number') && <Th>الرقم</Th>}
                <Th>الإجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((inv) => (
                <tr key={inv.id} className={`status-${inv.status}`}>
                  {canSeeProfit && saleColumns.visible('profit') && (() => {
                    const p = inv.status === 'DRAFT' || inv.status === 'CANCELLED' ? null : invoiceProfit(inv);
                    return <Td className={`font-bold ${p && p.profit < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{p ? formatMoney(p.profit) : '—'}</Td>;
                  })()}
                  {saleColumns.visible('status') && <Td><StatusBadge status={inv.status} /></Td>}
                  {saleColumns.visible('due') && <Td><DueAmount date={inv.invoiceDate} remaining={owed(inv)} /></Td>}
                  {saleColumns.visible('paid') && <Td>{formatMoney(inv.paidAmount)}</Td>}
                  {saleColumns.visible('total') && <Td className="font-semibold">{formatMoney(inv.total)}</Td>}
                  {saleColumns.visible('date') && <Td>{formatDate(inv.invoiceDate)}</Td>}
                  {saleColumns.visible('warehouse') && <Td>{inv.warehouse.name}</Td>}
                  {saleColumns.visible('customer') && <Td className="font-semibold">{inv.customer.name}</Td>}
                  {saleColumns.visible('number') && <Td className="font-mono text-xs font-bold text-brand-800">{inv.number}</Td>}
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
        title={editingId ? 'تعديل فاتورة بيع' : 'فاتورة بيع جديدة'}
        subtitle="اختار العميل والمخزن، ضيف الأصناف، وسجّل المدفوع"
        icon={<Receipt size={18} />}
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
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="تظهر على الفاتورة" />
            </div>
            <div className="mt-auto space-y-2 rounded-2xl bg-brand-900 px-4 py-4 text-sm">
              <SummaryRow label={`البنود (${filledLines.length})`} value={formatMoney(linesTotal)} />
              <SummaryRow label="خصم الفاتورة" value={formatMoney(num(form.discount))} />
              <SummaryRow label={`الضريبة (${num(form.tax)}%)`} value={formatMoney(taxAmount)} />
              <SummaryRow label="المطلوب من العميل" value={formatMoney(grand)} strong />
              <SummaryRow label="المدفوع" value={formatMoney(paidNow)} />
              <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2 font-bold text-slate-900">
                <span>المتبقي</span>
                <DueAmount date={formDueDate} remaining={remaining} />
              </div>
            </div>
            {(costKnown || (form.hasScrap && scrapAmount > 0)) && (
              <div className="space-y-1.5 rounded-2xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm">
                <div className="flex justify-between"><span>البنود بعد الخصم</span><b>{formatMoney(linesTotal - num(form.discount))}</b></div>
                {form.hasScrap && scrapAmount > 0 && (
                  <div className="flex justify-between"><span>+ خردة مستلمة من العميل</span><b>{formatMoney(scrapAmount)}</b></div>
                )}
                <div className="flex justify-between border-t border-emerald-200 pt-1.5"><span>إيراد الفاتورة</span><b>{formatMoney(formRevenue)}</b></div>
                {costKnown && <div className="flex justify-between"><span>− تكلفة البضاعة (FIFO)</span><b>{formatMoney(formCost)}</b></div>}
                {costKnown && canSeeProfit && (
                  <div className={`flex justify-between rounded-xl px-3 py-2 text-base font-extrabold ${formProfit >= 0 ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}`}>
                    <span>ربح الفاتورة</span>
                    <span>{formatMoney(formProfit)}</span>
                  </div>
                )}
              </div>
            )}
            <label className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm">
              <input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} />
              تأكيد فوري (خصم المخزون وتحديث رصيد العميل)
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
              <Label>المخزن</Label>
              <Select className={triedSave && !form.warehouseId ? 'border-rose-300' : ''} value={form.warehouseId} onChange={(e) => {
                const warehouseId = e.target.value;
                setForm({ ...form, warehouseId });
                if (warehouseId !== form.warehouseId) setLines([emptyLine()]);
              }}>
                <option value="">اختر المخزن أولاً</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>العميل</Label>
              <CustomerPicker
                customers={customers}
                value={form.customerName}
                invalid={triedSave && form.customerName.trim().length < 2}
                onChange={(customerName) => setForm({ ...form, customerName })}
              />
              <p className="mt-1 text-xs text-muted">العميل السريع موجود تلقائيًا. لو كتبت اسم مش متسجل هيتسجل لوحده.</p>
              {selectedCustomer?.priceList === 'WHOLESALE' && <p className="mt-1 text-xs font-semibold text-brand-700">عميل جملة: الأسعار من قائمة الجملة</p>}
            </div>
          </div>
          {showScrapSection && (
            <label className="mt-4 flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-800">
              <input
                type="checkbox"
                checked={form.hasScrap}
                onChange={(e) => setForm({
                  ...form,
                  hasScrap: e.target.checked,
                  ...(e.target.checked ? { scrapPieces: form.scrapPieces || 1 } : { scrapKg: '', scrapPieces: '', scrapPriceKg: '', scrapKind: 'SCRAP' as const }),
                })}
              />
              العميل هيسلّم بطارية قديمة؟ (خردة أو ضمان)
            </label>
          )}
        </EditorSection>

        {showScrapSection && form.hasScrap && (
          <EditorSection title="بطارية قديمة من العميل">
            <div className="mb-3 flex rounded-xl bg-slate-100 p-1">
              {([['SCRAP', 'خردة (العميل باعها)'], ['WARRANTY_SWAP', 'ضمان — العميل دفع فرق وخد جديدة']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setForm({ ...form, scrapKind: key })}
                  className={`h-9 flex-1 rounded-lg px-3 text-xs font-bold transition ${form.scrapKind === key ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mb-3 text-xs text-muted">
              البطارية بتبقى ملك المحل وبتظهر في "فرز البطاريات القديمة" عشان تقرر: خردة، مستعمل، سيرفس، ولا مرتجع ضمان للمورد.
            </p>
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <Label>عدد البطاريات</Label>
                <NumberInput value={form.scrapPieces} onValueChange={(v) => setForm({ ...form, scrapPieces: v })} />
              </div>
              <div>
                <Label>الوزن (كيلو){form.scrapKind === 'WARRANTY_SWAP' ? ' — اختياري' : ''}</Label>
                <NumberInput value={form.scrapKg} onValueChange={(v) => setForm({ ...form, scrapKg: v })} />
              </div>
              <div>
                <Label>سعر الكيلو</Label>
                <NumberInput value={form.scrapPriceKg} onValueChange={(v) => setForm({ ...form, scrapPriceKg: v })} />
              </div>
              <div>
                <Label>قيمة الخردة</Label>
                <div className="flex h-10 items-center rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-extrabold text-slate-900">
                  {formatMoney(scrapAmount)}
                </div>
                <p className="mt-1 text-xs text-muted">الوزن × سعر الكيلو — بتدخل في إيراد وربح الفاتورة، ومش بتتضاف على المطلوب من العميل</p>
              </div>
            </div>
          </EditorSection>
        )}

        <EditorSection title={`بنود الفاتورة (${filledLines.length})`} action={<AddLineButton onClick={() => setLines((prev) => [...prev, emptyLine()])} />}>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <LineCard
                key={i}
                index={i}
                total={Math.max(0, num(l.quantity) * num(l.unitPrice) - num(l.discount))}
                invalid={triedSave && badLine(l)}
                canRemove={lines.length > 1}
                onRemove={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <div className="grid gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-6">
                    <Label>الصنف</Label>
                    <ProductPicker
                      products={productsForSale(form.warehouseId, lines.map((line) => line.productId)).map((product) => ({
                        id: product.id,
                        name: product.name,
                        sku: product.sku,
                        barcode: product.barcode,
                        hint: `متاح ${availableQty(product.id, form.warehouseId)}`,
                      }))}
                      value={l.productId}
                      lineIndex={i}
                      disabled={!form.warehouseId}
                      placeholder={form.warehouseId ? 'اكتب اسم الصنف' : 'اختر المخزن أولاً'}
                      onChange={(productId) => updateLine(i, { productId })}
                      onEnter={(productId) => addLineAfterProduct(i, productId)}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <PriceHint label="آخر سعر شراء" value={l.productId ? priceHints[l.productId]?.lastPurchase : null} />
                  </div>
                  <div className="sm:col-span-3">
                    <PriceHint label="آخر سعر لهذا العميل" value={l.productId ? priceHints[l.productId]?.lastCustomer : null} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>الكمية</Label>
                    <NumberInput value={l.quantity} onValueChange={(v) => updateLine(i, { quantity: v })} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>سعر الوحدة</Label>
                    <NumberInput value={l.unitPrice} onValueChange={(v) => updateLine(i, { unitPrice: v })} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>خصم البند</Label>
                    <NumberInput value={l.discount} onValueChange={(v) => updateLine(i, { discount: v })} />
                  </div>
                </div>
                {canSeeCost && l.productId && num(l.quantity) > 0 && costPreview[i]?.unitCost !== undefined && (() => {
                  const cp = costPreview[i];
                  const lineTotal = num(l.quantity) * num(l.unitPrice) - num(l.discount);
                  const lineProfit = Math.round((lineTotal - (cp.totalCost || 0)) * 100) / 100;
                  const belowCost = num(l.unitPrice) > 0 && num(l.unitPrice) < (cp.unitCost || 0);
                  return (
                    <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          البطارية واقفة عليك بـ <b className="text-sm">{formatMoney(cp.unitCost || 0)}</b>
                          {' · '}تكلفة البند <b>{formatMoney(cp.totalCost || 0)}</b>
                        </span>
                        {canSeeProfit && (
                          <span className={`font-extrabold ${lineProfit >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                            ربح البند {formatMoney(lineProfit)}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {cp.allocations.map((a, k) => (
                          <span key={k} className={`rounded-md px-1.5 py-0.5 ring-1 ${a.fallback ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-white text-slate-600 ring-slate-200'}`}>
                            {a.quantity} × {formatMoney(a.unitCost || 0)}
                            {a.fallback ? ' (رصيد بدون دفعة)' : <> من <bdi dir="ltr" className="font-mono">{a.reference}</bdi></>}
                            {a.supplierName && ` · ${a.supplierName}`}
                          </span>
                        ))}
                      </div>
                      {belowCost && (
                        <div className="mt-1 text-amber-700">
                          سعر البيع أقل من التكلفة{form.hasScrap && scrapAmount > 0 ? ' — الخردة المستلمة بتعوّض الفرق في ربح الفاتورة' : ''}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </LineCard>
            ))}
          </div>
        </EditorSection>
      </InvoiceEditor>

      {posOpen && (
        <div className="fixed inset-0 z-[80] flex flex-col bg-slate-100">
          <div className="flex items-center justify-between gap-3 bg-brand-950 px-5 py-3 text-white">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-white/10"><ShoppingCart size={18} /></span>
              <div>
                <div className="text-lg font-extrabold">نقطة البيع</div>
                <div className="text-xs text-brand-100">اضغط الصنف لإضافته</div>
              </div>
            </div>
            <div className="text-left">
              <div className="text-[11px] text-brand-200">الإجمالي</div>
              <div className="text-xl font-extrabold">{formatMoney(posNet)}</div>
            </div>
            <button type="button" className="rounded-xl bg-white/10 px-4 py-2 text-sm font-bold" onClick={() => setPosOpen(false)}>إغلاق</button>
          </div>
        <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[1fr_22rem]">
          <div className="flex min-h-0 flex-col">
            <div className="mb-3 max-w-xs">
              <Label>المخزن</Label>
              <Select value={posForm.warehouseId} onChange={(e) => { setPosForm({ ...posForm, warehouseId: e.target.value }); setPosCart([]); }}>
                <option value="">اختر المخزن أولاً</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
            <Input
              value={posSearch}
              onChange={(e) => setPosSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scanPosBarcode(); } }}
              placeholder="اسم أو كود أو باركود ثم Enter"
            />
            <div className="mt-3 grid flex-1 auto-rows-max grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
              {!posForm.warehouseId && <div className="col-span-full"><Empty text="اختر المخزن عشان تظهر البضاعة الموجودة فيه" /></div>}
              {posForm.warehouseId && posProducts.length === 0 && <div className="col-span-full"><Empty text="مفيش بضاعة متاحة في المخزن ده" /></div>}
              {posProducts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addPosProduct(p)}
                  className="overflow-hidden rounded-2xl border border-slate-200 bg-white text-right shadow-sm transition hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-md"
                >
                  <div className="grid h-28 place-items-center bg-slate-50">
                    {p.imageFile ? <img src={productImageUrl(p.id, p.imageFile)} alt="" className="h-full w-full object-cover" /> : <ShoppingCart className="text-slate-300" size={28} />}
                  </div>
                  <div className="px-3 py-2">
                    <div className="truncate text-sm font-bold">{p.name}</div>
                    <div className="text-xs text-muted">{p.sku} · متاح {availableQty(p.id, posForm.warehouseId)}</div>
                    <div className="mt-1 text-sm font-semibold text-brand-800">{formatMoney(priceFor(p, posForm.customerName))}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-2xl bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">السلة</div>
            {posCart.length === 0 ? <Empty text="اضغط على صنف لإضافته" /> : (
              <div className="space-y-2">
                {posCart.map((l, i) => {
                  const prod = products.find((p) => p.id === l.productId);
                  return (
                    <div key={l.productId} className="grid grid-cols-12 items-end gap-2 rounded-xl bg-slate-50 p-2">
                      <div className="col-span-5 flex items-center gap-2 text-sm font-semibold">
                        {prod?.imageFile && <img src={productImageUrl(prod.id, prod.imageFile)} alt="" className="h-10 w-10 rounded-lg object-cover" />}
                        <span className="min-w-0">
                          <span className="block truncate">{prod?.name}</span>
                          <span className="block truncate text-[11px] font-semibold text-slate-500">
                            شراء {priceHints[l.productId]?.lastPurchase == null ? '—' : formatMoney(priceHints[l.productId]?.lastPurchase || 0)}
                            {' · '}
                            العميل {priceHints[l.productId]?.lastCustomer == null ? '—' : formatMoney(priceHints[l.productId]?.lastCustomer || 0)}
                          </span>
                        </span>
                      </div>
                      <div className="col-span-3">
                        <Label>كمية</Label>
                        <NumberInput value={l.quantity} onValueChange={(v) => setPosCart((prev) => prev.map((row, idx) => idx === i ? { ...row, quantity: v } : row))} />
                      </div>
                      <div className="col-span-3">
                        <Label>سعر</Label>
                        <NumberInput value={l.unitPrice} onValueChange={(v) => setPosCart((prev) => prev.map((row, idx) => idx === i ? { ...row, unitPrice: v } : row))} />
                      </div>
                      <button type="button" className="col-span-1 pb-2 text-rose-600" onClick={() => setPosCart((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
                    </div>
                  );
                })}
              </div>
            )}
            <div>
              <Label>العميل</Label>
              <CustomerPicker customers={customers} value={posForm.customerName} onChange={(customerName) => setPosForm({ ...posForm, customerName })} />
            </div>
            <div>
              <Label>خصم الفاتورة</Label>
              <NumberInput value={posForm.discount} onValueChange={(discount) => setPosForm({ ...posForm, discount })} />
            </div>
            <TenderEditor methods={methods} parts={posForm.payments} onChange={(payments) => setPosForm({ ...posForm, payments })} />
            <p className="text-[11px] text-slate-500">لو الجزء الأول فاضي ومختار طريقة، يتسدد الصافي بعد الخصم بالطريقة دي.</p>
            <div className="space-y-1 rounded-2xl bg-brand-900 px-4 py-3 text-sm text-white">
              <div className="flex justify-between text-brand-100"><span>المجموع</span><span className="text-white">{formatMoney(posGross)}</span></div>
              <div className="flex justify-between text-brand-100"><span>الخصم</span><span className="text-white">{formatMoney(posDiscount)}</span></div>
              <div className="flex justify-between"><span className="text-brand-100">الإجمالي</span><strong className="text-lg">{formatMoney(posNet)}</strong></div>
              <div className="flex justify-between text-brand-100"><span>المدفوع</span><span className="text-white">{formatMoney(posPaid)}</span></div>
              <div className="flex justify-between border-t border-white/10 pt-2 font-bold"><span>المتبقي</span><span>{formatMoney(posRemaining)}</span></div>
            </div>
            <Button className="w-full" onClick={savePos} disabled={!posCart.length}>إتمام البيع</Button>
          </div>
        </div>
        </div>
      )}

      <Modal open={!!view} onClose={() => setView(null)} title={`فاتورة ${view?.number || ''}`} wide>
        {view && (
          <div>
            <PrintHeader title={`فاتورة بيع ${view.number}`} subtitle={view.customer.name} />
            <div className="mb-4 overflow-hidden rounded-2xl bg-brand-900 px-5 py-4 text-white no-print">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-brand-200">فاتورة بيع</div>
                  <div className="text-2xl font-extrabold">{view.number}</div>
                  <div className="mt-1 text-sm text-brand-100">{view.customer.name} · {view.warehouse.name} · {formatDate(view.invoiceDate)}</div>
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
                  <Th>سعر</Th>
                  <Th>الإجمالي</Th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((l, i) => (
                  <tr key={i}>
                    <Td>{l.product.name}</Td>
                    <Td>{l.quantity}</Td>
                    <Td>{formatMoney(l.unitPrice)}</Td>
                    <Td>{formatMoney(l.total)}</Td>
                  </tr>
                ))}
                {view.hasScrap && (view.scrapAmount || 0) > 0 && (
                  <tr>
                    <Td>
                      بطارية خردة مستلمة من العميل
                      <div className="text-xs text-muted">
                        {(view.scrapPieces || 0) > 0 ? `${view.scrapPieces} قطعة · ` : ''}
                        {view.scrapKg || 0} كيلو × {formatMoney(view.scrapPriceKg || 0)}
                      </div>
                    </Td>
                    <Td>{view.scrapKg || 0}</Td>
                    <Td>{formatMoney(view.scrapPriceKg || 0)}</Td>
                    <Td>{formatMoney(view.scrapAmount || 0)}</Td>
                  </tr>
                )}
              </tbody>
            </Table>
            {saleFifo && saleFifo.lines.some((l) => l.allocations.length > 0) && (
              <div className="mt-4 rounded-xl border border-slate-200 p-3 no-print">
                <div className="mb-2 text-sm font-bold text-slate-800">مسحوب من أنهي دفعة (FIFO)</div>
                <div className="space-y-2">
                  {saleFifo.lines.map((line) => (
                    <div key={line.lineId} className="rounded-lg bg-slate-50 p-2 text-sm">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-bold">{line.name} · {line.quantity}</span>
                        <span className="text-xs text-muted">
                          تكلفة الوحدة {formatMoney(line.unitCost)} · ربح البند {formatMoney((line.total ?? line.unitPrice * line.quantity) - line.unitCost * line.quantity)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {line.allocations.map((a, i) => (
                          <span key={i} className={`rounded-lg px-2 py-1 text-xs ring-1 ${a.fallback ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-white text-slate-700 ring-slate-200'}`}>
                            <b>{a.quantity}</b> من {a.fallback ? 'رصيد بدون دفعة' : (
                              <>دفعة <bdi dir="ltr" className="font-mono font-bold">{a.reference || '—'}</bdi></>
                            )}
                            {a.supplierName && <> · {a.supplierName}</>}
                            {a.viaTransfer && <> · محوّلة <bdi dir="ltr">{a.viaTransfer}</bdi></>}
                            {' · '}بسعر <b>{formatMoney(a.unitCost)}</b>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-4 space-y-1 text-sm">
              <div className="flex justify-between"><span>المجموع</span><span>{formatMoney(view.subtotal)}</span></div>
              {view.discount > 0 && <div className="flex justify-between text-amber-700"><span>الخصم</span><span>{formatMoney(view.discount)}</span></div>}
              {view.tax > 0 && <div className="flex justify-between"><span>الضريبة</span><span>{formatMoney(view.tax)}</span></div>}
              <div className="flex justify-between"><span>المدفوع</span><span>{formatMoney(view.paidAmount)}</span></div>
              <div className="flex justify-between font-bold">
                <span>المتبقي</span>
                {view.status === 'CANCELLED' ? <span>{formatMoney(0)}</span> : <DueAmount date={view.invoiceDate} remaining={view.total - view.paidAmount} />}
              </div>
              <div className="flex justify-between text-lg font-extrabold">
                <span>المطلوب من العميل</span>
                <span>{formatMoney(view.total)}</span>
              </div>
            </div>
            {(() => {
              const p = invoiceProfit(view);
              if (!p || !canSeeProfit) return null;
              return (
                <div className="mt-4 space-y-1.5 rounded-2xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm no-print">
                  <div className="flex justify-between"><span>البنود بعد الخصم</span><b>{formatMoney(view.subtotal - view.discount)}</b></div>
                  {(view.scrapAmount || 0) > 0 && (
                    <div className="flex justify-between"><span>+ خردة مستلمة من العميل</span><b>{formatMoney(view.scrapAmount || 0)}</b></div>
                  )}
                  <div className="flex justify-between border-t border-emerald-200 pt-1.5"><span>إيراد الفاتورة</span><b>{formatMoney(p.revenue)}</b></div>
                  <div className="flex justify-between"><span>− تكلفة البضاعة (FIFO)</span><b>{formatMoney(p.cost)}</b></div>
                  <div className={`flex justify-between rounded-xl px-3 py-2 text-base font-extrabold text-white ${p.profit >= 0 ? 'bg-emerald-600' : 'bg-rose-600'}`}>
                    <span>ربح الفاتورة</span>
                    <span>{formatMoney(p.profit)}</span>
                  </div>
                </div>
              );
            })()}
            <div className="mt-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">حركات التحصيل</div>
              {!view.receipts?.length ? (
                <div className="text-sm text-muted">لا توجد حركات تحصيل على الفاتورة</div>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>التاريخ</Th>
                      <Th>رقم الحركة</Th>
                      <Th>طريقة الدفع</Th>
                      <Th>المبلغ</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.receipts.map((r) => (
                      <tr key={r.id} className="row-debit">
                        <Td>{formatDate(r.receivedAt)}</Td>
                        <Td className="font-semibold">{r.number}</Td>
                        <Td>{methods.find((method) => method.id === r.paymentMethod)?.name || '—'}</Td>
                        <Td className="font-bold">{formatMoney(r.amount)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
