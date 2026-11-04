import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDownLeft, ArrowUpRight, Boxes, Coins, Download, FileSpreadsheet, Package, PackageX, Percent, Printer, Redo2, ShoppingCart,
  TrendingDown, TrendingUp, Truck, Undo2, Users, Wallet, CalendarDays as CalendarIcon,
} from 'lucide-react';
import { loadExcel } from '../lib/excel';
import { api, formatDate, formatMoney, getApiBase } from '../lib/api';
import { DueAmount } from '../components/DueAmount';
import {
  Badge, Button, Card, CardHeader, Empty, Input, Label, PageHeader, PrintHeader, SearchBox, StatCard, StatGrid, StatusBadge, Table, Td, Th,
} from '../components/ui';

type ProfitLine = {
  id: string;
  kind: 'REVENUE' | 'RETURN' | 'COGS' | 'COGS_RETURN' | 'EXPENSE' | 'DISCOUNT' | 'TAX';
  date: string;
  reference: string;
  party: string;
  description: string;
  quantity: number | null;
  unitAmount: number | null;
  amount: number;
  side: 'IN' | 'OUT';
};

const PROFIT_KIND: Record<ProfitLine['kind'], { label: string; tone: 'emerald' | 'rose' | 'sky' | 'amber' | 'violet' | 'slate' }> = {
  REVENUE: { label: 'إيراد بيع', tone: 'emerald' },
  TAX: { label: 'ضريبة (خارج الربح)', tone: 'slate' },
  RETURN: { label: 'مرتجع بيع', tone: 'rose' },
  DISCOUNT: { label: 'خصم فاتورة', tone: 'amber' },
  COGS: { label: 'تكلفة بضاعة', tone: 'sky' },
  COGS_RETURN: { label: 'استرداد تكلفة', tone: 'sky' },
  EXPENSE: { label: 'مصروف', tone: 'rose' },
};

function ProfitView({
  revenue,
  cogs,
  expenses,
  gross,
  net,
  lines,
}: {
  revenue: number;
  cogs: number;
  expenses: number;
  gross: number;
  net: number;
  invoiceDiff?: number;
  lines: ProfitLine[];
}) {
  const [filter, setFilter] = useState<'all' | 'IN' | 'OUT' | 'REVENUE' | 'COGS' | 'EXPENSE'>('all');
  const margin = revenue > 0 ? (net / revenue) * 100 : 0;
  const cogsPct = revenue > 0 ? Math.min(100, Math.max(0, (cogs / revenue) * 100)) : 0;
  const expensePct = revenue > 0 ? Math.min(100, Math.max(0, (expenses / revenue) * 100)) : 0;
  const profitPct = Math.max(0, 100 - cogsPct - expensePct);
  const visible = lines.filter((row) => {
    if (filter === 'all') return true;
    if (filter === 'IN') return row.side === 'IN';
    if (filter === 'OUT') return row.side === 'OUT';
    if (filter === 'REVENUE') return row.kind === 'REVENUE' || row.kind === 'RETURN' || row.kind === 'TAX' || row.kind === 'DISCOUNT';
    if (filter === 'COGS') return row.kind === 'COGS' || row.kind === 'COGS_RETURN';
    return row.kind === 'EXPENSE';
  });

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatCard label="صافي الإيراد" value={formatMoney(revenue)} hint="مبيعات + خردة + استهلاك مرتجع − خصم − مرتجع بقيمة" icon={ShoppingCart} tone="emerald" />
        <StatCard label="تكلفة البضاعة" value={formatMoney(cogs)} hint="تكلفة الأصناف المباعة − استرداد مرتجع مربوط بفاتورة (الاستبدال مش داخل)" icon={Coins} tone="sky" />
        <StatCard label="المصروفات" value={formatMoney(expenses)} hint="مصروفات الفترة" icon={Wallet} tone="rose" />
        <StatCard label="صافي الربح" value={<span className={net >= 0 ? 'text-emerald-700' : 'text-rose-600'}>{formatMoney(net)}</span>} hint={`مجمل الربح ${formatMoney(gross)} = إيراد − تكلفة`} icon={TrendingUp} tone={net >= 0 ? 'amber' : 'rose'} />
      </StatGrid>
      <Card>
        <CardHeader title="تركيب الربح" subtitle={`هامش صافي ${(Number.isFinite(margin) ? margin : 0).toFixed(1)}% من الإيراد`} icon={Percent} />
        <div className="flex h-5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full bg-gradient-to-l from-sky-400 to-sky-600 transition-all" style={{ width: `${cogsPct}%` }} />
          <div className="h-full bg-gradient-to-l from-rose-400 to-rose-600 transition-all" style={{ width: `${expensePct}%` }} />
          <div className="h-full bg-gradient-to-l from-emerald-400 to-emerald-600 transition-all" style={{ width: `${profitPct}%` }} />
        </div>
        <div className="mt-3 flex flex-wrap justify-between gap-3 text-sm">
          <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-sky-500" /> تكلفة البضاعة <b className="tabular-nums">{cogsPct.toFixed(1)}%</b></span>
          <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-rose-500" /> مصروفات <b className="tabular-nums">{expensePct.toFixed(1)}%</b></span>
          <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-emerald-500" /> صافي الربح <b className="tabular-nums">{profitPct.toFixed(1)}%</b></span>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="تفاصيل احتساب الربح"
          subtitle={`${visible.length} حركة من أصل ${lines.length}`}
          icon={FileSpreadsheet}
          actions={(
            <div className="flex flex-wrap gap-1">
              {([
                ['all', 'الكل'],
                ['IN', 'دخل'],
                ['OUT', 'خرج'],
                ['REVENUE', 'إيراد ومرتجع'],
                ['COGS', 'تكلفة'],
                ['EXPENSE', 'مصروف'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-bold ${filter === key ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        />
        {visible.length === 0 ? <Empty text="مفيش حركات في الفترة دي" /> : (
          <Table>
            <thead>
              <tr>
                <Th>التاريخ</Th>
                <Th>النوع</Th>
                <Th>المرجع</Th>
                <Th>التفاصيل</Th>
                <Th>الطرف</Th>
                <Th>الكمية</Th>
                <Th>سعر/تكلفة</Th>
                <Th>المبلغ</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const meta = PROFIT_KIND[row.kind];
                const signed = row.side === 'IN' ? row.amount : -row.amount;
                return (
                  <tr key={row.id} className={row.side === 'IN' ? 'row-debit' : 'row-credit'}>
                    <Td className="whitespace-nowrap text-slate-500">{formatDate(row.date)}</Td>
                    <Td><Badge tone={meta.tone}>{meta.label}</Badge></Td>
                    <Td className="font-mono text-xs font-bold">{row.reference}</Td>
                    <Td className="max-w-xs truncate text-slate-700">{row.description}</Td>
                    <Td className="text-slate-600">{row.party}</Td>
                    <Td className="tabular-nums">{row.quantity == null ? '—' : row.quantity}</Td>
                    <Td className="tabular-nums">{row.unitAmount == null ? '—' : formatMoney(row.unitAmount)}</Td>
                    <Td className={`whitespace-nowrap font-extrabold ${signed >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {signed >= 0 ? '+' : ''}{formatMoney(signed)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

type InventoryRow = {
  quantity: number;
  product: { sku: string; name: string; unit: string; costPrice: number; salePrice: number };
  warehouse: { name: string };
};

type SalesReport = {
  invoices: { number: string; total: number; discount: number; paidAmount: number; status: string; invoiceDate: string; customer: { name: string }; warehouse: { name: string } }[];
  total: number;
  paid: number;
  count: number;
};

type PurchasesReport = {
  invoices: { number: string; total: number; paidAmount: number; status: string; invoiceDate: string; supplier: { name: string }; warehouse: { name: string } }[];
  total: number;
  paid: number;
  count: number;
};

type Profit = {
  salesTotal: number;
  purchasesTotal: number;
  grossProfit: number;
  salesCount: number;
  purchasesCount: number;
  revenue?: number;
  cogs?: number;
  expenses?: number;
  operatingProfit?: number;
  netProfit?: number;
  invoiceDiff?: number;
  lines?: ProfitLine[];
};

type ProductRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  costPrice: number;
  salePrice: number;
  stockQty: number;
  quantity: number;
  amount: number;
};

type LossRow = ProductRow & { revenue: number; cost: number; loss: number };

type UnderpricedRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  stockQty: number;
  costPrice: number;
  salePrice: number;
  gap: number;
  potentialLoss: number;
};

type UnsoldRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  stockQty: number;
  stockValue: number;
  purchasedQty: number;
  costPrice: number;
  salePrice: number;
};

type ProductInsights = {
  topSold: ProductRow[];
  topPurchased: ProductRow[];
  losses: LossRow[];
  lossTotal: number;
  underpriced: UnderpricedRow[];
  potentialLossTotal: number;
  unsold: UnsoldRow[];
  unsoldValue: number;
};

type ReportTab = 'inventory' | 'sales' | 'purchases' | 'profit' | 'cash' | 'products' | 'returns' | 'suppliers' | 'customers' | 'journal' | 'oldBatteries';

type JournalRow = {
  key: string; date: string; kind: string; group: string; reference: string | null; party: string | null; description: string;
  value: number | null; cashIn: number; cashOut: number; goodsIn: number; goodsOut: number; accounts: string[]; products: string[];
};
type Journal = {
  rows: JournalRow[];
  totals: { cashIn: number; cashOut: number; cashNet: number; goodsIn: number; goodsOut: number; goodsNet: number; count: number };
  byKind: { kind: string; count: number; cashIn: number; cashOut: number; goodsIn: number; goodsOut: number; value: number }[];
};
type OldReport = {
  intake: { count: number; value: number; saleScrap: { count: number; value: number }; warrantySwap: { count: number; value: number }; warrantyWait: { count: number; value: number }; manual: { count: number; value: number } };
  sorted: { count: number; scrap: number; used: number; warranty: number };
  now: { toSort: number; scrapPile: number; scrapPileValue: number; scrapPileKg: number; usedInStock: number; warrantyInShop: number; warrantyWithSupplier: number; customerWaitingPickup: number; rejected: number };
  warranty: { sent: number; replaced: number; shopReplaced: number; fees: number; replacementCost: number; delivered: number; pendingBySupplier: { supplier: string; count: number; oldestDays: number; shop: number; customer: number }[] };
  scrapSales: { count: number; netKg: number; revenue: number; cost: number; profit: number; rows: { number: string; date: string; supplier: string; netKg: number; amount: number; batteries: number; cost: number; profit: number; settlement: string }[] };
};

const JOURNAL_GROUPS: [string, string][] = [
  ['all', 'الكل'], ['sales', 'المبيعات والتحصيل'], ['purchases', 'المشتريات والسداد'], ['returns', 'المرتجعات'],
  ['oldBatteries', 'البطاريات القديمة والضمان'], ['scrap', 'الخردة'], ['stock', 'المخزون'], ['cash', 'الخزنة'], ['expenses', 'المصروفات'],
];
type AppliedFilter = { all: boolean; ids: string[]; from: string; to: string };

const TAB_LABEL: Record<ReportTab, string> = {
  inventory: 'المخزون',
  sales: 'المبيعات',
  purchases: 'المشتريات',
  profit: 'الأرباح',
  products: 'المنتجات',
  returns: 'المرتجعات',
  suppliers: 'الموردين',
  customers: 'العملاء',
  cash: 'الخزنة',
  journal: 'دفتر الحركة',
  oldBatteries: 'البطاريات القديمة',
};

export function ReportsPage() {
  const [tab, setTab] = useState<ReportTab>('inventory');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [sales, setSales] = useState<SalesReport | null>(null);
  const [purchases, setPurchases] = useState<PurchasesReport | null>(null);
  const [profit, setProfit] = useState<Profit | null>(null);
  const [cash, setCash] = useState<{
    totalIn: number; totalOut: number; net: number; currentTotal?: number;
    accounts?: { id: string; name: string; type: string; balance: number }[];
    transactions: { direction: string; amount: number; description: string; createdAt: string; account: { name: string } }[];
  } | null>(null);
  const [returnsReport, setReturnsReport] = useState<{
    salesReturns: any[]; purchaseReturns: any[];
    salesCount: number; purchaseCount: number; salesTotal: number; purchaseTotal: number; restockedValue: number;
  } | null>(null);
  const [suppliersReport, setSuppliersReport] = useState<any[] | null>(null);
  const [customersReport, setCustomersReport] = useState<any[] | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [allWarehouses, setAllWarehouses] = useState(false);
  const [applied, setApplied] = useState<AppliedFilter | null>(null);
  const [search, setSearch] = useState('');
  const [salesCols, setSalesCols] = useState({ customer: true, date: true, total: true, status: true });
  const [purchaseCols, setPurchaseCols] = useState({ supplier: true, date: true, total: true, status: true });
  const [products, setProducts] = useState<ProductInsights | null>(null);
  const ready = allWarehouses || picked.length > 0;
  const partyTabs = tab === 'suppliers' || tab === 'customers' || tab === 'journal' || tab === 'oldBatteries';
  const [journal, setJournal] = useState<Journal | null>(null);
  const [journalGroup, setJournalGroup] = useState('all');
  const [oldReport, setOldReport] = useState<OldReport | null>(null);
  const journalRows = (journal?.rows || []).filter((r) => {
    if (journalGroup !== 'all' && r.group !== journalGroup) return false;
    const q = search.trim();
    if (!q) return true;
    return [r.kind, r.reference || '', r.party || '', r.description, ...r.products].some((x) => x.includes(q));
  });

  const filteredInventory = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return inventory;
    return inventory.filter((r) =>
      [r.product.sku, r.product.name, r.warehouse.name].some((x) => x.toLowerCase().includes(q)),
    );
  }, [inventory, search]);

  const productQuery = search.trim().toLowerCase();
  const matchProduct = (row: { sku: string; name: string }) =>
    !productQuery || [row.sku, row.name].some((value) => value.toLowerCase().includes(productQuery));
  const visibleSold = products?.topSold.filter(matchProduct) || [];
  const visiblePurchased = products?.topPurchased.filter(matchProduct) || [];
  const visibleLosses = products?.losses.filter(matchProduct) || [];
  const visibleUnderpriced = products?.underpriced.filter(matchProduct) || [];
  const visibleUnsold = products?.unsold.filter(matchProduct) || [];

  function queryFor(next: AppliedFilter, withDates: boolean) {
    const params = new URLSearchParams();
    if (withDates && next.from) params.set('from', next.from);
    if (withDates && next.to) params.set('to', next.to);
    if (!next.all && next.ids.length) params.set('warehouseIds', next.ids.join(','));
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  async function load(next = applied, nextTab = tab) {
    if (!next) return;
    const suffix = queryFor(next, nextTab !== 'inventory');
    const dateOnly = new URLSearchParams();
    if (next.from) dateOnly.set('from', next.from);
    if (next.to) dateOnly.set('to', next.to);
    const dateQs = dateOnly.toString() ? `?${dateOnly}` : '';
    if (nextTab === 'inventory') {
      setInventory(await api<InventoryRow[]>(`/reports/inventory${suffix}`));
    } else if (nextTab === 'sales') {
      setSales(await api<SalesReport>(`/reports/sales${suffix}`));
    } else if (nextTab === 'purchases') {
      setPurchases(await api<PurchasesReport>(`/reports/purchases${suffix}`));
    } else if (nextTab === 'profit') {
      setProfit(await api<Profit>(`/reports/profit${suffix}`));
    } else if (nextTab === 'cash') {
      setCash(await api(`/reports/cash${suffix}`));
    } else if (nextTab === 'returns') {
      setReturnsReport(await api(`/reports/returns${suffix}`));
    } else if (nextTab === 'suppliers') {
      setSuppliersReport(await api(`/reports/suppliers${dateQs}`));
    } else if (nextTab === 'journal') {
      setJournal(await api<Journal>(`/reports/journal${dateQs}`));
    } else if (nextTab === 'oldBatteries') {
      setOldReport(await api<OldReport>(`/reports/old-batteries${dateQs}`));
    } else if (nextTab === 'customers') {
      setCustomersReport(await api(`/reports/customers${dateQs}`));
    } else {
      setProducts(await api<ProductInsights>(`/reports/products${suffix}`));
    }
  }

  useEffect(() => {
    const raw = localStorage.getItem('m5azen_report_range');
    if (raw) {
      try {
        const range = JSON.parse(raw) as { from?: string; to?: string };
        if (range.from) setFrom(range.from);
        if (range.to) setTo(range.to);
      } catch { /* التاريخ المحفوظ مش شرط يفضل صالح */ }
    }
    api<{ id: string; name: string }[]>('/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
  }, []);

  useEffect(() => { if (applied) load(applied, tab).catch(() => undefined); }, [tab, applied]);

  function applyPreset(kind: 'today' | 'week' | 'month' | 'year') {
    const end = new Date();
    const start = new Date();
    if (kind === 'week') start.setDate(end.getDate() - 6);
    if (kind === 'month') start.setDate(1);
    if (kind === 'year') start.setMonth(0, 1);
    const iso = (value: Date) => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const range = { from: iso(start), to: iso(end) };
    setFrom(range.from);
    setTo(range.to);
    localStorage.setItem('m5azen_report_range', JSON.stringify(range));
    if (partyTabs) {
      setApplied({ all: true, ids: [], from: range.from, to: range.to });
      return;
    }
    if (!ready) return;
    setApplied({ all: allWarehouses, ids: allWarehouses ? [] : picked, from: range.from, to: range.to });
  }

  function showReport() {
    if (partyTabs) {
      setApplied({ all: true, ids: [], from, to });
      return;
    }
    if (!ready) return;
    setApplied({ all: allWarehouses, ids: allWarehouses ? [] : picked, from, to });
  }

  async function exportExcel() {
    if (tab === 'inventory') {
      const token = localStorage.getItem('m5azen_token');
      const q = applied && !applied.all && applied.ids.length ? `?warehouseIds=${applied.ids.join(',')}` : '';
      const res = await fetch(`${getApiBase()}/api/reports/inventory/excel${q}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'inventory.xlsx';
      a.click();
      return;
    }

    const ExcelJS = await loadExcel();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('تقرير');
    if (tab === 'sales' && sales) {
      ws.columns = [
        { header: 'الرقم', key: 'number', width: 14 },
        { header: 'العميل', key: 'customer', width: 24 },
        { header: 'المخزن', key: 'warehouse', width: 18 },
        { header: 'التاريخ', key: 'date', width: 14 },
        { header: 'الخصم', key: 'discount', width: 14 },
        { header: 'الإجمالي', key: 'total', width: 14 },
        { header: 'المدفوع', key: 'paid', width: 14 },
        { header: 'الحالة', key: 'status', width: 12 },
      ];
      sales.invoices.forEach((i) => {
        ws.addRow({
          number: i.number,
          customer: i.customer.name,
          warehouse: i.warehouse.name,
          date: formatDate(i.invoiceDate),
          discount: i.discount || 0,
          total: i.total,
          paid: i.paidAmount,
          status: i.status,
        });
      });
    } else if (tab === 'purchases' && purchases) {
      ws.columns = [
        { header: 'الرقم', key: 'number', width: 14 },
        { header: 'المورد', key: 'supplier', width: 24 },
        { header: 'المخزن', key: 'warehouse', width: 18 },
        { header: 'التاريخ', key: 'date', width: 14 },
        { header: 'الإجمالي', key: 'total', width: 14 },
        { header: 'المدفوع', key: 'paid', width: 14 },
        { header: 'الحالة', key: 'status', width: 12 },
      ];
      purchases.invoices.forEach((invoice) => {
        ws.addRow({
          number: invoice.number,
          supplier: invoice.supplier.name,
          warehouse: invoice.warehouse.name,
          date: formatDate(invoice.invoiceDate),
          total: invoice.total,
          paid: invoice.paidAmount,
          status: invoice.status,
        });
      });
    } else if (tab === 'profit' && profit) {
      ws.addRow(['البند', 'القيمة']);
      ws.addRow(['صافي الإيراد', profit.revenue ?? profit.salesTotal]);
      ws.addRow(['تكلفة البضاعة', profit.cogs || 0]);
      ws.addRow(['المصروفات', profit.expenses || 0]);
      ws.addRow(['مجمل الربح', profit.operatingProfit ?? ((profit.revenue ?? profit.salesTotal) - (profit.cogs || 0))]);
      ws.addRow(['صافي الربح', profit.netProfit ?? profit.grossProfit]);
      ws.addRow([]);
      const detail = wb.addWorksheet('تفاصيل الربح');
      detail.columns = [
        { header: 'التاريخ', key: 'date', width: 14 },
        { header: 'النوع', key: 'kind', width: 16 },
        { header: 'المرجع', key: 'reference', width: 14 },
        { header: 'التفاصيل', key: 'description', width: 36 },
        { header: 'الطرف', key: 'party', width: 22 },
        { header: 'الكمية', key: 'quantity', width: 10 },
        { header: 'سعر/تكلفة', key: 'unitAmount', width: 12 },
        { header: 'المبلغ', key: 'amount', width: 14 },
        { header: 'أثر', key: 'side', width: 10 },
      ];
      (profit.lines || []).forEach((row) => {
        detail.addRow({
          date: formatDate(row.date),
          kind: PROFIT_KIND[row.kind].label,
          reference: row.reference,
          description: row.description,
          party: row.party,
          quantity: row.quantity ?? '',
          unitAmount: row.unitAmount ?? '',
          amount: row.side === 'IN' ? row.amount : -row.amount,
          side: row.side === 'IN' ? 'دخل' : 'خرج',
        });
      });
    } else if (tab === 'products' && products) {
      const soldSheet = wb.addWorksheet('الأكثر مبيعاً');
      soldSheet.columns = [
        { header: 'الصنف', key: 'name', width: 28 },
        { header: 'الكود', key: 'sku', width: 14 },
        { header: 'الكمية', key: 'quantity', width: 12 },
        { header: 'الإيراد', key: 'amount', width: 14 },
      ];
      products.topSold.forEach((row) => soldSheet.addRow(row));
      const buySheet = wb.addWorksheet('الأكثر شراءً');
      buySheet.columns = [
        { header: 'الصنف', key: 'name', width: 28 },
        { header: 'الكود', key: 'sku', width: 14 },
        { header: 'الكمية', key: 'quantity', width: 12 },
        { header: 'التكلفة', key: 'amount', width: 14 },
      ];
      products.topPurchased.forEach((row) => buySheet.addRow(row));
      const lossSheet = wb.addWorksheet('الخسارة');
      lossSheet.columns = [
        { header: 'الصنف', key: 'name', width: 28 },
        { header: 'كمية مباعة', key: 'quantity', width: 14 },
        { header: 'إيراد', key: 'revenue', width: 14 },
        { header: 'تكلفة', key: 'cost', width: 14 },
        { header: 'خسارة', key: 'loss', width: 14 },
      ];
      products.losses.forEach((row) => lossSheet.addRow(row));
      const pricedSheet = wb.addWorksheet('تحت التكلفة');
      pricedSheet.columns = [
        { header: 'الصنف', key: 'name', width: 28 },
        { header: 'المخزون', key: 'stockQty', width: 12 },
        { header: 'التكلفة', key: 'costPrice', width: 14 },
        { header: 'سعر البيع', key: 'salePrice', width: 14 },
        { header: 'خسارة متوقعة', key: 'potentialLoss', width: 16 },
      ];
      products.underpriced.forEach((row) => pricedSheet.addRow(row));
      const deadSheet = wb.addWorksheet('لا تباع');
      deadSheet.columns = [
        { header: 'الصنف', key: 'name', width: 28 },
        { header: 'الكود', key: 'sku', width: 14 },
        { header: 'المخزون', key: 'stockQty', width: 12 },
        { header: 'قيمة المخزون', key: 'stockValue', width: 16 },
      ];
      products.unsold.forEach((row) => deadSheet.addRow(row));
    } else if (tab === 'journal' && journal) {
      ws.columns = [
        { header: 'التاريخ', key: 'date', width: 14 },
        { header: 'النوع', key: 'kind', width: 22 },
        { header: 'المرجع', key: 'ref', width: 16 },
        { header: 'الطرف', key: 'party', width: 22 },
        { header: 'التفاصيل', key: 'desc', width: 40 },
        { header: 'القيمة', key: 'value', width: 12 },
        { header: 'فلوس داخلة', key: 'cin', width: 12 },
        { header: 'فلوس خارجة', key: 'cout', width: 12 },
        { header: 'بضاعة داخلة', key: 'gin', width: 12 },
        { header: 'بضاعة خارجة', key: 'gout', width: 12 },
        { header: 'الأصناف', key: 'products', width: 40 },
      ];
      journalRows.forEach((r) => ws.addRow({
        date: formatDate(r.date), kind: r.kind, ref: r.reference || '', party: r.party || '', desc: r.description,
        value: r.value ?? '', cin: r.cashIn || '', cout: r.cashOut || '', gin: r.goodsIn || '', gout: r.goodsOut || '', products: r.products.join(' · '),
      }));
    } else if (tab === 'cash' && cash) {
      ws.columns = [
        { header: 'التاريخ', key: 'date', width: 14 },
        { header: 'الحساب', key: 'account', width: 18 },
        { header: 'الوصف', key: 'desc', width: 30 },
        { header: 'النوع', key: 'dir', width: 10 },
        { header: 'المبلغ', key: 'amount', width: 12 },
      ];
      cash.transactions.forEach((t) => {
        ws.addRow({
          date: formatDate(t.createdAt),
          account: t.account.name,
          desc: t.description,
          dir: t.direction === 'IN' ? 'وارد' : 'صادر',
          amount: t.amount,
        });
      });
    }
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${tab}.xlsx`;
    a.click();
  }

  return (
    <div>
      <PageHeader
        title="التقارير"
        subtitle="مخزون، مبيعات، مشتريات، منتجات، مرتجعات، موردين، عملاء، أرباح، وخزنة — حسب المدة والمخزن"
        actions={
          <>
            <SearchBox value={search} onChange={setSearch} placeholder="بحث في التقرير..." />
            <Button variant="secondary" onClick={() => window.print()}><Printer size={16} /> طباعة / PDF</Button>
            <Button variant="secondary" onClick={exportExcel}><FileSpreadsheet size={16} /> Excel</Button>
            <Button onClick={() => load()}><Download size={16} /> تحديث</Button>
          </>
        }
      />

      <PrintHeader title="تقرير AK Tech" subtitle={`${TAB_LABEL[tab]}${applied ? ` · ${applied.all ? 'كل المخازن' : warehouses.filter((row) => applied.ids.includes(row.id)).map((row) => row.name).join('، ')}` : ''}`} />

      <div className="mb-4 flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm no-print">
        {([
          ['inventory', 'المخزون', Boxes],
          ['sales', 'المبيعات', ShoppingCart],
          ['purchases', 'المشتريات', Truck],
          ['products', 'المنتجات', Package],
          ['returns', 'المرتجعات', Undo2],
          ['suppliers', 'الموردين', Truck],
          ['customers', 'العملاء', Users],
          ['journal', 'دفتر الحركة', FileSpreadsheet],
          ['oldBatteries', 'البطاريات القديمة', Redo2],
          ['profit', 'الأرباح', TrendingUp],
          ['cash', 'الخزنة', Wallet],
        ] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`flex h-11 min-w-[120px] flex-1 items-center justify-center gap-2 rounded-xl text-[13px] font-bold transition ${tab === k ? 'bg-gradient-to-br from-brand-600 to-brand-800 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      <Card className="mb-5 !p-3 no-print">
        <div className="space-y-3">
          {!partyTabs && (
          <div>
            <Label>المخازن</Label>
            <div className="mt-1 flex flex-wrap gap-2">
              <label className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold ${allWarehouses ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600'}`}>
                <input
                  type="checkbox"
                  className="accent-[var(--color-brand-700)]"
                  checked={allWarehouses}
                  onChange={() => {
                    if (allWarehouses) {
                      setAllWarehouses(false);
                      setPicked([]);
                    } else {
                      setAllWarehouses(true);
                      setPicked(warehouses.map((row) => row.id));
                    }
                  }}
                />
                كل المخازن
              </label>
              {warehouses.map((row) => {
                const checked = allWarehouses || picked.includes(row.id);
                return (
                  <label key={row.id} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold ${checked ? 'border-brand-200 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600'}`}>
                    <input
                      type="checkbox"
                      className="accent-[var(--color-brand-700)]"
                      checked={checked}
                      onChange={() => {
                        if (allWarehouses) {
                          setAllWarehouses(false);
                          setPicked(warehouses.map((item) => item.id).filter((id) => id !== row.id));
                          return;
                        }
                        setPicked((current) => current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id]);
                      }}
                    />
                    {row.name}
                  </label>
                );
              })}
            </div>
          </div>
          )}
          {tab !== 'inventory' && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex rounded-xl bg-slate-100 p-1">
                {([['today', 'اليوم'], ['week', 'الأسبوع'], ['month', 'الشهر'], ['year', 'السنة']] as const).map(([key, label]) => (
                  <button key={key} type="button" onClick={() => applyPreset(key)} className="h-8 rounded-lg px-3 text-xs font-bold text-slate-600 transition hover:bg-white hover:text-brand-800 hover:shadow-sm">{label}</button>
                ))}
              </div>
              <div className="w-40"><Label>من تاريخ</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="w-40"><Label>إلى تاريخ</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
          )}
          <Button onClick={showReport} disabled={!partyTabs && !ready}>عرض التقرير</Button>
        </div>
      </Card>

      {!applied && (
        <Card>
          <Empty
            text="التقرير لسه مش ظاهر"
            hint={partyTabs
              ? 'اختار المدة (اختياري) وبعدين اضغط عرض التقرير'
              : 'اختار مخزن واحد أو أكتر، أو كل المخازن، وبعدين اضغط عرض التقرير'}
          />
        </Card>
      )}

      {applied && tab === 'inventory' && (
        <StatGrid cols={3}>
          <StatCard label="قيمة المخزون بالتكلفة" value={formatMoney(filteredInventory.reduce((s, r) => s + r.quantity * r.product.costPrice, 0))} icon={Coins} tone="brand" />
          <StatCard label="قيمة المخزون بسعر البيع" value={formatMoney(filteredInventory.reduce((s, r) => s + r.quantity * r.product.salePrice, 0))} icon={TrendingUp} tone="emerald" />
          <StatCard label="إجمالي الوحدات" value={filteredInventory.reduce((s, r) => s + r.quantity, 0).toLocaleString('ar-EG')} hint={`${filteredInventory.length} رصيد`} icon={Boxes} tone="sky" />
        </StatGrid>
      )}

      {applied && tab === 'inventory' && (
        <Card>
          {filteredInventory.length === 0 ? <Empty /> : (
            <Table>
              <thead>
                <tr>
                  <Th>المخزن</Th>
                  <Th>الكود</Th>
                  <Th>الصنف</Th>
                  <Th>كمية</Th>
                  <Th>تكلفة</Th>
                  <Th>بيع</Th>
                  <Th>قيمة</Th>
                </tr>
              </thead>
              <tbody>
                {filteredInventory.map((r, i) => (
                  <tr key={i} className={r.quantity <= 0 ? 'row-credit' : ''}>
                    <Td className="text-slate-600">{r.warehouse.name}</Td>
                    <Td><span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600" dir="ltr">{r.product.sku}</span></Td>
                    <Td className="font-bold text-slate-900">{r.product.name}</Td>
                    <Td className={`font-extrabold tabular-nums ${r.quantity <= 0 ? 'text-rose-600' : ''}`}>{r.quantity}</Td>
                    <Td className="tabular-nums text-slate-600">{formatMoney(r.product.costPrice)}</Td>
                    <Td className="tabular-nums text-slate-600">{formatMoney(r.product.salePrice)}</Td>
                    <Td className="whitespace-nowrap font-bold tabular-nums">{formatMoney(r.quantity * r.product.costPrice)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {applied && tab === 'sales' && sales && (
        <>
        <StatGrid>
          <StatCard label="إجمالي المبيعات" value={formatMoney(sales.total)} icon={ShoppingCart} tone="emerald" />
          <StatCard label="المحصل" value={formatMoney(sales.paid)} hint={sales.total > 0 ? `${((sales.paid / sales.total) * 100).toFixed(0)}% من الإجمالي` : undefined} icon={Wallet} tone="sky" />
          <StatCard label="المتبقي على العملاء" value={formatMoney(Math.max(0, sales.total - sales.paid))} icon={Coins} tone="rose" />
          <StatCard label="عدد الفواتير" value={sales.count} hint={sales.count ? `متوسط ${formatMoney(sales.total / sales.count)}` : undefined} icon={FileSpreadsheet} tone="amber" />
        </StatGrid>
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm no-print">
            <span className="text-xs font-bold text-slate-500">الأعمدة:</span>
            {([['customer', 'العميل'], ['date', 'التاريخ'], ['total', 'الإجمالي'], ['status', 'الحالة']] as const).map(([key, label]) => (
              <label key={key} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${salesCols[key] ? 'border-brand-200 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-500'}`}>
                <input type="checkbox" className="accent-[var(--color-brand-700)]" checked={salesCols[key]} onChange={(e) => setSalesCols({ ...salesCols, [key]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
          <Table>
            <thead>
              <tr>
                <Th>الرقم</Th>
                <Th>المخزن</Th>
                {salesCols.customer && <Th>العميل</Th>}
                {salesCols.date && <Th>التاريخ</Th>}
                <Th>الخصم</Th>
                {salesCols.total && <Th>الإجمالي</Th>}
                <Th>المتبقي</Th>
                {salesCols.status && <Th>الحالة</Th>}
              </tr>
            </thead>
            <tbody>
              {sales.invoices.map((i) => (
                <tr key={i.number} className={`status-${i.status}`}>
                  <Td><span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{i.number}</span></Td>
                  <Td className="text-slate-600">{i.warehouse.name}</Td>
                  {salesCols.customer && <Td className="font-semibold text-slate-800">{i.customer.name}</Td>}
                  {salesCols.date && <Td className="whitespace-nowrap text-slate-500">{formatDate(i.invoiceDate)}</Td>}
                  <Td className="whitespace-nowrap text-amber-700">{i.discount ? formatMoney(i.discount) : '—'}</Td>
                  {salesCols.total && <Td className="whitespace-nowrap font-bold">{formatMoney(i.total)}</Td>}
                  <Td>{i.status === 'CANCELLED' ? formatMoney(0) : <DueAmount date={i.invoiceDate} remaining={i.total - i.paidAmount} />}</Td>
                  {salesCols.status && <Td><StatusBadge status={i.status} /></Td>}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        </>
      )}

      {applied && tab === 'purchases' && purchases && (
        <>
        <StatGrid>
          <StatCard label="إجمالي المشتريات" value={formatMoney(purchases.total)} icon={Truck} tone="sky" />
          <StatCard label="المدفوع للموردين" value={formatMoney(purchases.paid)} hint={purchases.total > 0 ? `${((purchases.paid / purchases.total) * 100).toFixed(0)}% من الإجمالي` : undefined} icon={Wallet} tone="emerald" />
          <StatCard label="المتبقي للموردين" value={formatMoney(Math.max(0, purchases.total - purchases.paid))} icon={Coins} tone="rose" />
          <StatCard label="عدد الفواتير" value={purchases.count} hint={purchases.count ? `متوسط ${formatMoney(purchases.total / purchases.count)}` : undefined} icon={FileSpreadsheet} tone="amber" />
        </StatGrid>
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm no-print">
            <span className="text-xs font-bold text-slate-500">الأعمدة:</span>
            {([['supplier', 'المورد'], ['date', 'التاريخ'], ['total', 'الإجمالي'], ['status', 'الحالة']] as const).map(([key, label]) => (
              <label key={key} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${purchaseCols[key] ? 'border-brand-200 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-500'}`}>
                <input type="checkbox" className="accent-[var(--color-brand-700)]" checked={purchaseCols[key]} onChange={(e) => setPurchaseCols({ ...purchaseCols, [key]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
          {purchases.invoices.length === 0 ? <Empty text="لا توجد فواتير شراء في المخازن والفترة دي" /> : (
          <Table>
            <thead>
              <tr>
                <Th>الرقم</Th>
                <Th>المخزن</Th>
                {purchaseCols.supplier && <Th>المورد</Th>}
                {purchaseCols.date && <Th>التاريخ</Th>}
                {purchaseCols.total && <Th>الإجمالي</Th>}
                <Th>المتبقي</Th>
                {purchaseCols.status && <Th>الحالة</Th>}
              </tr>
            </thead>
            <tbody>
              {purchases.invoices.map((invoice) => (
                <tr key={invoice.number} className={`status-${invoice.status}`}>
                  <Td><span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{invoice.number}</span></Td>
                  <Td className="text-slate-600">{invoice.warehouse.name}</Td>
                  {purchaseCols.supplier && <Td className="font-semibold text-slate-800">{invoice.supplier.name}</Td>}
                  {purchaseCols.date && <Td className="whitespace-nowrap text-slate-500">{formatDate(invoice.invoiceDate)}</Td>}
                  {purchaseCols.total && <Td className="whitespace-nowrap font-bold">{formatMoney(invoice.total)}</Td>}
                  <Td>{invoice.status === 'CANCELLED' ? formatMoney(0) : <DueAmount date={invoice.invoiceDate} remaining={invoice.total - invoice.paidAmount} />}</Td>
                  {purchaseCols.status && <Td><StatusBadge status={invoice.status} /></Td>}
                </tr>
              ))}
            </tbody>
          </Table>
          )}
        </Card>
        </>
      )}

      {applied && tab === 'products' && products && (
        <div className="space-y-4">
          <StatGrid>
            <StatCard label="خسارة محققة" value={<span className="text-rose-700">{formatMoney(products.lossTotal)}</span>} hint="بيع بأقل من التكلفة" icon={TrendingDown} tone="rose" />
            <StatCard label="خسارة متوقعة على المخزون" value={<span className="text-amber-700">{formatMoney(products.potentialLossTotal)}</span>} hint="سعر البيع أقل من التكلفة" icon={AlertTriangle} tone="amber" />
            <StatCard label="أصناف لا تُباع" value={products.unsold.length} hint={`قيمة راكدة ${formatMoney(products.unsoldValue)}`} icon={PackageX} tone="slate" />
            <StatCard label="الأكثر مبيعاً" value={visibleSold.length} hint="صنف له مبيعات في الفترة" icon={TrendingUp} tone="emerald" />
          </StatGrid>

          <Card>
            <div className="mb-3 font-bold text-emerald-800">الأكثر مبيعاً</div>
            {visibleSold.length === 0 ? <Empty /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>#</Th>
                    <Th>الصنف</Th>
                    <Th>الكمية</Th>
                    <Th>الإيراد</Th>
                    <Th>متوسط السعر</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSold.map((row, index) => (
                    <tr key={row.productId} className="row-debit">
                      <Td>{index + 1}</Td>
                      <Td>
                        <div className="font-semibold">{row.name}</div>
                        <div className="font-mono text-xs text-muted">{row.sku}</div>
                      </Td>
                      <Td className="font-bold">{row.quantity} {row.unit}</Td>
                      <Td>{formatMoney(row.amount)}</Td>
                      <Td>{formatMoney(row.quantity ? row.amount / row.quantity : 0)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <div className="mb-3 font-bold text-sky-800">الأكثر شراءً</div>
            {visiblePurchased.length === 0 ? <Empty /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>#</Th>
                    <Th>الصنف</Th>
                    <Th>الكمية</Th>
                    <Th>التكلفة</Th>
                    <Th>متوسط التكلفة</Th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePurchased.map((row, index) => (
                    <tr key={row.productId}>
                      <Td>{index + 1}</Td>
                      <Td>
                        <div className="font-semibold">{row.name}</div>
                        <div className="font-mono text-xs text-muted">{row.sku}</div>
                      </Td>
                      <Td className="font-bold">{row.quantity} {row.unit}</Td>
                      <Td>{formatMoney(row.amount)}</Td>
                      <Td>{formatMoney(row.quantity ? row.amount / row.quantity : 0)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <div className="mb-1 font-bold text-rose-800">الخسارة المحققة</div>
            <div className="mb-3 text-xs text-muted">أصناف اتباعت وإيرادها أقل من تكلفتها الحالية</div>
            {visibleLosses.length === 0 ? <Empty /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>الصنف</Th>
                    <Th>كمية مباعة</Th>
                    <Th>إيراد</Th>
                    <Th>تكلفة</Th>
                    <Th>خسارة</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLosses.map((row) => (
                    <tr key={row.productId} className="row-credit">
                      <Td>
                        <div className="font-semibold">{row.name}</div>
                        <div className="font-mono text-xs text-muted">{row.sku}</div>
                      </Td>
                      <Td>{row.quantity}</Td>
                      <Td>{formatMoney(row.revenue)}</Td>
                      <Td>{formatMoney(row.cost)}</Td>
                      <Td className="font-bold text-rose-700">{formatMoney(row.loss)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <div className="mb-1 font-bold text-orange-800">سعر البيع أقل من التكلفة</div>
            <div className="mb-3 text-xs text-muted">خسارة متوقعة لو المخزون الحالي اتباع بسعر البيع المسجّل</div>
            {visibleUnderpriced.length === 0 ? <Empty /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>الصنف</Th>
                    <Th>المخزون</Th>
                    <Th>التكلفة</Th>
                    <Th>سعر البيع</Th>
                    <Th>الفرق</Th>
                    <Th>خسارة متوقعة</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUnderpriced.map((row) => (
                    <tr key={row.productId}>
                      <Td>
                        <div className="font-semibold">{row.name}</div>
                        <div className="font-mono text-xs text-muted">{row.sku}</div>
                      </Td>
                      <Td>{row.stockQty}</Td>
                      <Td>{formatMoney(row.costPrice)}</Td>
                      <Td>{formatMoney(row.salePrice)}</Td>
                      <Td>{formatMoney(row.gap)}</Td>
                      <Td className="font-bold text-orange-700">{formatMoney(row.potentialLoss)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <div className="mb-1 font-bold text-amber-900">منتجات لا تُباع</div>
            <div className="mb-3 text-xs text-muted">مخزون أو مشتريات من غير أي بيع في الفترة</div>
            {visibleUnsold.length === 0 ? <Empty /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>الصنف</Th>
                    <Th>المخزون</Th>
                    <Th>قيمة المخزون</Th>
                    <Th>مشترى</Th>
                    <Th>التكلفة</Th>
                    <Th>سعر البيع</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUnsold.map((row) => (
                    <tr key={row.productId}>
                      <Td>
                        <div className="font-semibold">{row.name}</div>
                        <div className="font-mono text-xs text-muted">{row.sku}</div>
                      </Td>
                      <Td className="font-bold">{row.stockQty} {row.unit}</Td>
                      <Td>{formatMoney(row.stockValue)}</Td>
                      <Td>{row.purchasedQty}</Td>
                      <Td>{formatMoney(row.costPrice)}</Td>
                      <Td>{formatMoney(row.salePrice)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {applied && tab === 'profit' && profit && (
        <ProfitView
          revenue={profit.revenue ?? profit.salesTotal}
          cogs={profit.cogs || 0}
          expenses={profit.expenses || 0}
          gross={profit.operatingProfit ?? profit.grossProfit ?? ((profit.revenue ?? profit.salesTotal) - (profit.cogs || 0))}
          net={profit.netProfit ?? ((profit.revenue || 0) - (profit.cogs || 0) - (profit.expenses || 0))}
          invoiceDiff={profit.invoiceDiff ?? (profit.salesTotal - profit.purchasesTotal)}
          lines={profit.lines || []}
        />
      )}

      {applied && tab === 'returns' && returnsReport && (
        <>
          <StatGrid cols={4}>
            <StatCard label="مرتجعات بيع" value={formatMoney(returnsReport.salesTotal)} hint={`${returnsReport.salesCount} مرتجع`} icon={Undo2} tone="rose" />
            <StatCard label="مرتجعات شراء" value={formatMoney(returnsReport.purchaseTotal)} hint={`${returnsReport.purchaseCount} مرتجع`} icon={Redo2} tone="sky" />
            <StatCard label="استلام بديل" value={formatMoney(returnsReport.restockedValue)} hint="قيمة الكميات المستلمة بدل المرتجع" icon={Package} tone="emerald" />
            <StatCard label="صافي مرتجع الشراء" value={formatMoney(returnsReport.purchaseTotal - returnsReport.restockedValue)} hint="مرتجع شراء − استلام بديل" icon={Coins} tone="amber" />
          </StatGrid>
          <Card>
            <CardHeader title="مرتجعات البيع" subtitle={`${returnsReport.salesCount} حركة`} icon={Undo2} />
            {returnsReport.salesReturns.length === 0 ? <Empty /> : (
              <Table>
                <thead><tr><Th>الرقم</Th><Th>العميل</Th><Th>المخزن</Th><Th>التاريخ</Th><Th>الأصناف</Th><Th>الإجمالي</Th></tr></thead>
                <tbody>
                  {returnsReport.salesReturns.map((r: any) => (
                    <tr key={r.id}>
                      <Td><span className="font-mono text-xs font-bold" dir="ltr">{r.number}</span></Td>
                      <Td>{r.customerName || r.customer?.name || '—'}</Td>
                      <Td>{r.warehouse?.name}</Td>
                      <Td>{formatDate(r.returnDate)}</Td>
                      <Td>{r.lines?.map((l: any) => l.product?.name).filter(Boolean).join(' · ') || '—'}</Td>
                      <Td className="font-bold">{formatMoney(r.consumptionAmount || r.total || 0)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="مرتجعات الشراء" subtitle={`${returnsReport.purchaseCount} حركة`} icon={Redo2} />
            {returnsReport.purchaseReturns.length === 0 ? <Empty /> : (
              <Table>
                <thead><tr><Th>الرقم</Th><Th>المورد</Th><Th>المخزن</Th><Th>التاريخ</Th><Th>الأصناف</Th><Th>الإجمالي</Th><Th>مستلم بديل</Th></tr></thead>
                <tbody>
                  {returnsReport.purchaseReturns.map((r: any) => (
                    <tr key={r.id}>
                      <Td><span className="font-mono text-xs font-bold" dir="ltr">{r.number}</span></Td>
                      <Td>{r.supplier?.name}</Td>
                      <Td>{r.warehouse?.name}</Td>
                      <Td>{formatDate(r.returnDate)}</Td>
                      <Td>{r.lines?.map((l: any) => `${l.product?.name} (${l.quantity})`).join(' · ')}</Td>
                      <Td className="font-bold">{formatMoney(r.total)}</Td>
                      <Td>{r.lines?.reduce((s: number, l: any) => s + (l.restockedQty || 0), 0) || 0}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}

      {applied && tab === 'suppliers' && suppliersReport && (
        <Card>
          <CardHeader title="حركة الموردين في الفترة" subtitle={`${suppliersReport.length} مورد · التفاصيل من صفحة الموردين ← كشف حساب`} icon={Truck} />
          <Table>
            <thead><tr><Th>الكود</Th><Th>المورد</Th><Th>مشتريات</Th><Th>سداد</Th><Th>مرتجعات</Th><Th>استلام بديل</Th><Th>خردة مبيعة</Th><Th>فواتير</Th><Th>الرصيد الحالي</Th></tr></thead>
            <tbody>
              {suppliersReport.filter((r) => !search.trim() || r.name.includes(search) || r.code.includes(search)).map((r) => (
                <tr key={r.id}>
                  <Td className="font-mono text-xs"><span dir="ltr">{r.code}</span></Td>
                  <Td className="font-bold">{r.name}</Td>
                  <Td className="tabular-nums">{formatMoney(r.purchased)}</Td>
                  <Td className="tabular-nums text-emerald-700">{formatMoney(r.paid)}</Td>
                  <Td className="tabular-nums text-sky-700">{formatMoney(r.returned)}</Td>
                  <Td className="tabular-nums text-amber-700">{formatMoney(r.restocked || 0)}</Td>
                  <Td className="tabular-nums text-emerald-700">{formatMoney(r.scrapSold || 0)}</Td>
                  <Td>{r.invoiceCount}</Td>
                  <Td className="font-extrabold">{formatMoney(r.balance)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {applied && tab === 'customers' && customersReport && (
        <Card>
          <CardHeader title="حركة العملاء في الفترة" subtitle={`${customersReport.length} عميل · التفاصيل من صفحة العملاء ← كشف حساب`} icon={Users} />
          <Table>
            <thead><tr><Th>الكود</Th><Th>العميل</Th><Th>مبيعات</Th><Th>تحصيل</Th><Th>مرتجعات</Th><Th>فواتير</Th><Th>الرصيد الحالي</Th></tr></thead>
            <tbody>
              {customersReport.filter((r) => !search.trim() || r.name.includes(search) || r.code.includes(search)).map((r) => (
                <tr key={r.id}>
                  <Td className="font-mono text-xs"><span dir="ltr">{r.code}</span></Td>
                  <Td className="font-bold">{r.name}</Td>
                  <Td className="tabular-nums">{formatMoney(r.sold)}</Td>
                  <Td className="tabular-nums text-emerald-700">{formatMoney(r.received)}</Td>
                  <Td className="tabular-nums text-rose-700">{formatMoney(r.returned)}</Td>
                  <Td>{r.invoiceCount}</Td>
                  <Td className="font-extrabold">{formatMoney(r.balance)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {applied && tab === 'journal' && journal && (
        <>
          <StatGrid cols={4}>
            <StatCard label="فلوس داخلة" value={<span className="text-emerald-700">{formatMoney(journal.totals.cashIn)}</span>} icon={ArrowDownLeft} tone="emerald" />
            <StatCard label="فلوس خارجة" value={<span className="text-rose-600">{formatMoney(journal.totals.cashOut)}</span>} icon={ArrowUpRight} tone="rose" />
            <StatCard label="صافي الفلوس" value={formatMoney(journal.totals.cashNet)} icon={Wallet} tone="brand" />
            <StatCard label="بضاعة داخلة / خارجة" value={`${journal.totals.goodsIn} / ${journal.totals.goodsOut}`} hint={`${journal.totals.count} حركة`} icon={Boxes} tone="sky" />
          </StatGrid>
          <Card>
            <CardHeader title="ملخص حسب النوع" subtitle="كل نوع عمليات اتعمل كام مرة وأثره" icon={FileSpreadsheet} />
            <Table>
              <thead><tr><Th>النوع</Th><Th>العدد</Th><Th>القيمة</Th><Th>فلوس داخلة</Th><Th>فلوس خارجة</Th><Th>بضاعة داخلة</Th><Th>بضاعة خارجة</Th></tr></thead>
              <tbody>
                {journal.byKind.map((k) => (
                  <tr key={k.kind}>
                    <Td className="font-bold">{k.kind}</Td>
                    <Td>{k.count}</Td>
                    <Td className="tabular-nums">{k.value ? formatMoney(k.value) : '—'}</Td>
                    <Td className="tabular-nums text-emerald-700">{k.cashIn ? formatMoney(k.cashIn) : '—'}</Td>
                    <Td className="tabular-nums text-rose-600">{k.cashOut ? formatMoney(k.cashOut) : '—'}</Td>
                    <Td className="tabular-nums">{k.goodsIn || '—'}</Td>
                    <Td className="tabular-nums">{k.goodsOut || '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card>
            <CardHeader
              title="كل الحركات بالترتيب"
              subtitle={`${journalRows.length} حركة`}
              icon={CalendarIcon}
              actions={(
                <div className="flex flex-wrap gap-1">
                  {JOURNAL_GROUPS.map(([key, label]) => (
                    <button key={key} type="button" onClick={() => setJournalGroup(key)} className={`rounded-lg px-2.5 py-1 text-xs font-bold ${journalGroup === key ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            />
            {journalRows.length === 0 ? <Empty text="مفيش حركات" /> : (
              <Table>
                <thead><tr><Th>التاريخ</Th><Th>النوع</Th><Th>المرجع</Th><Th>الطرف</Th><Th>التفاصيل</Th><Th>القيمة</Th><Th>فلوس داخلة</Th><Th>فلوس خارجة</Th><Th>بضاعة</Th></tr></thead>
                <tbody>
                  {journalRows.map((r) => (
                    <tr key={r.key}>
                      <Td className="whitespace-nowrap text-slate-500">{formatDate(r.date)}</Td>
                      <Td><Badge tone={r.cashIn > 0 ? 'emerald' : r.cashOut > 0 ? 'rose' : 'slate'}>{r.kind}</Badge></Td>
                      <Td><span className="font-mono text-xs font-bold" dir="ltr">{r.reference || '—'}</span></Td>
                      <Td>{r.party || '—'}</Td>
                      <Td className="max-w-sm text-xs text-slate-600">
                        {r.description}
                        {r.products.length > 0 && <div className="mt-0.5 text-muted">{r.products.join(' · ')}</div>}
                        {r.accounts.length > 0 && <div className="mt-0.5 text-muted">{r.accounts.join('، ')}</div>}
                      </Td>
                      <Td className="tabular-nums">{r.value != null ? formatMoney(r.value) : '—'}</Td>
                      <Td className="tabular-nums font-bold text-emerald-700">{r.cashIn ? formatMoney(r.cashIn) : ''}</Td>
                      <Td className="tabular-nums font-bold text-rose-600">{r.cashOut ? formatMoney(r.cashOut) : ''}</Td>
                      <Td className="whitespace-nowrap tabular-nums text-xs">
                        {r.goodsIn ? <span className="text-emerald-700">+{r.goodsIn}</span> : null}
                        {r.goodsIn && r.goodsOut ? ' / ' : null}
                        {r.goodsOut ? <span className="text-rose-600">−{r.goodsOut}</span> : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}

      {applied && tab === 'oldBatteries' && oldReport && (
        <>
          <StatGrid cols={4}>
            <StatCard label="بطاريات قديمة دخلت" value={oldReport.intake.count} hint={`قيمتها ${formatMoney(oldReport.intake.value)}`} icon={Undo2} tone="brand" />
            <StatCard label="اتفرزت" value={oldReport.sorted.count} hint={`خردة ${oldReport.sorted.scrap} · مستعمل ${oldReport.sorted.used} · ضمان ${oldReport.sorted.warranty}`} icon={Package} tone="sky" />
            <StatCard label="بدائل ضمان وصلت" value={oldReport.warranty.replaced} hint={`استهلاك ${formatMoney(oldReport.warranty.fees)} · تكلفة بدائل المحل ${formatMoney(oldReport.warranty.replacementCost)}`} icon={Truck} tone="emerald" />
            <StatCard label="ربح بيع الخردة" value={<span className={oldReport.scrapSales.profit >= 0 ? 'text-emerald-700' : 'text-rose-600'}>{formatMoney(oldReport.scrapSales.profit)}</span>} hint={`${oldReport.scrapSales.netKg} كجم بـ ${formatMoney(oldReport.scrapSales.revenue)} − تكلفة ${formatMoney(oldReport.scrapSales.cost)}`} icon={Coins} tone="amber" />
          </StatGrid>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="دخلت منين" subtitle="في الفترة" icon={Undo2} />
              <Table>
                <thead><tr><Th>المصدر</Th><Th>العدد</Th><Th>القيمة</Th></tr></thead>
                <tbody>
                  {([['خردة من فواتير البيع', oldReport.intake.saleScrap], ['ضمان — الزبون دفع فرق', oldReport.intake.warrantySwap], ['ضمان زبون مستني', oldReport.intake.warrantyWait], ['إدخال يدوي', oldReport.intake.manual]] as const).map(([label, v]) => (
                    <tr key={label}><Td>{label}</Td><Td>{v.count}</Td><Td>{formatMoney(v.value)}</Td></tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card>
              <CardHeader title="الوضع دلوقتي" subtitle="بغض النظر عن الفترة" icon={Boxes} />
              <Table>
                <tbody>
                  <tr><Td>مستنية الفرز</Td><Td className="font-bold">{oldReport.now.toSort}</Td></tr>
                  <tr><Td>كوم الخردة</Td><Td className="font-bold">{oldReport.now.scrapPile} بطارية · {oldReport.now.scrapPileKg} كجم · {formatMoney(oldReport.now.scrapPileValue)}</Td></tr>
                  <tr><Td>اتفرزت مستعمل/سيرفس</Td><Td className="font-bold">{oldReport.now.usedInStock}</Td></tr>
                  <tr><Td>ضمان في المحل لسه متبعتش</Td><Td className="font-bold">{oldReport.now.warrantyInShop}</Td></tr>
                  <tr><Td>ضمان عند الموردين (البديل لسه موصلش)</Td><Td className="font-bold">{oldReport.now.warrantyWithSupplier}</Td></tr>
                  <tr><Td>زباين البديل بتاعهم وصل ومستنيين يستلموا</Td><Td className="font-bold">{oldReport.now.customerWaitingPickup}</Td></tr>
                  <tr><Td>المورد رفضها</Td><Td className="font-bold">{oldReport.now.rejected}</Td></tr>
                </tbody>
              </Table>
            </Card>
          </div>
          <Card>
            <CardHeader title="الضمان عند الموردين" subtitle="البديل لسه موصلش — مرتب بالأقدم" icon={Truck} />
            {oldReport.warranty.pendingBySupplier.length === 0 ? <Empty text="مفيش حاجة عند الموردين" /> : (
              <Table>
                <thead><tr><Th>المورد</Th><Th>العدد</Th><Th>ملك المحل</Th><Th>ملك زباين</Th><Th>أقدم واحدة من</Th></tr></thead>
                <tbody>
                  {oldReport.warranty.pendingBySupplier.map((r) => (
                    <tr key={r.supplier}><Td className="font-bold">{r.supplier}</Td><Td>{r.count}</Td><Td>{r.shop}</Td><Td>{r.customer}</Td><Td>{r.oldestDays} يوم</Td></tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="مبيعات الخردة" subtitle={`${oldReport.scrapSales.count} بيعة`} icon={Coins} />
            {oldReport.scrapSales.rows.length === 0 ? <Empty text="مفيش مبيعات خردة في الفترة" /> : (
              <Table>
                <thead><tr><Th>الرقم</Th><Th>التاريخ</Th><Th>المورد</Th><Th>الوزن الصافي</Th><Th>البيع</Th><Th>بطاريات</Th><Th>التكلفة</Th><Th>الربح</Th></tr></thead>
                <tbody>
                  {oldReport.scrapSales.rows.map((r) => (
                    <tr key={r.number}>
                      <Td><span className="font-mono text-xs font-bold" dir="ltr">{r.number}</span></Td>
                      <Td>{formatDate(r.date)}</Td>
                      <Td>{r.supplier}</Td>
                      <Td>{r.netKg} كجم</Td>
                      <Td>{formatMoney(r.amount)}</Td>
                      <Td>{r.batteries}</Td>
                      <Td>{formatMoney(r.cost)}</Td>
                      <Td className={`font-bold ${r.profit >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{formatMoney(r.profit)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}

      {applied && tab === 'cash' && cash && (
        <>
        {!applied.all && <p className="mb-3 text-sm text-slate-500">الحركات هنا هي التحصيل والسداد المرتبطين بفواتير المخازن المختارة.</p>}
        <StatGrid cols={4}>
          <StatCard label="الرصيد الحالي" value={formatMoney(cash.currentTotal || 0)} hint="مجموع كل حسابات الخزنة" icon={Wallet} tone="brand" />
          <StatCard label="وارد الفترة" value={<span className="text-emerald-700">{formatMoney(cash.totalIn)}</span>} icon={ArrowDownLeft} tone="emerald" />
          <StatCard label="صادر الفترة" value={<span className="text-rose-600">{formatMoney(cash.totalOut)}</span>} icon={ArrowUpRight} tone="rose" />
          <StatCard label="صافي الحركة" value={formatMoney(cash.net)} hint={`${cash.transactions.length} حركة`} icon={Coins} tone="amber" />
        </StatGrid>
        {!!cash.accounts?.length && (
          <Card>
            <CardHeader title="توزيع أرصدة الخزنة الآن" subtitle={`${cash.accounts.length} حساب`} icon={Wallet} />
            <Table>
              <thead><tr><Th>الحساب</Th><Th>النوع</Th><Th>الرصيد</Th></tr></thead>
              <tbody>
                {cash.accounts.map((a) => (
                  <tr key={a.id}>
                    <Td className="font-bold">{a.name}</Td>
                    <Td className="text-muted">{a.type === 'BANK' ? 'بنك' : 'نقدي'}</Td>
                    <Td className="font-extrabold tabular-nums">{formatMoney(a.balance)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
        <Card>
          <CardHeader title="حركات الفترة" subtitle="دخل وخرج" icon={ArrowDownLeft} />
          <Table>
            <thead>
              <tr>
                <Th>التاريخ</Th>
                <Th>الحساب</Th>
                <Th>الوصف</Th>
                <Th>النوع</Th>
                <Th>المبلغ</Th>
              </tr>
            </thead>
            <tbody>
              {cash.transactions.map((t, i) => (
                <tr key={i} className={t.direction === 'IN' ? 'row-debit' : 'row-credit'}>
                  <Td className="whitespace-nowrap text-slate-500">{formatDate(t.createdAt)}</Td>
                  <Td className="font-semibold text-slate-700">{t.account.name}</Td>
                  <Td className="text-slate-600">{t.description}</Td>
                  <Td><Badge tone={t.direction === 'IN' ? 'emerald' : 'rose'}>{t.direction === 'IN' ? 'وارد' : 'صادر'}</Badge></Td>
                  <Td className={`whitespace-nowrap font-extrabold ${t.direction === 'IN' ? 'text-emerald-700' : 'text-rose-600'}`}>{formatMoney(t.amount)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        </>
      )}
    </div>
  );
}
