import { useEffect, useState } from 'react';
import { CalendarDays, Eye, PackageOpen, Pencil, Plus, Redo2, Trash2, Undo2 } from 'lucide-react';
import { api, formatDate, formatMoney } from '../lib/api';
import { useConfirm, useToast } from '../lib/feedback';
import { ProductPicker } from '../components/ProductPicker';
import { productsForWarehouse } from '../lib/productWarehouse';
import { IconAction } from '../components/ListBar';
import { OldBatteriesPanel } from '../components/OldBatteriesPanel';
import {
  Badge, Button, Card, CardHeader, Empty, Input, Label, Modal, NumberInput, PageHeader, Pager, SearchBox, Select, StatCard, StatGrid, Table, Td, Th,
} from '../components/ui';

type Party = { id: string; name: string; code?: string };
type Product = { id: string; name: string; sku: string; barcode?: string | null; warehouses?: { warehouseId: string }[] };
type Account = { id: string; name: string };

type PurchaseProductLine = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  purchasedQty: number;
  returnedQty: number;
  purchaseRemaining?: number;
  returnsStock?: number;
  warehouseStock?: number;
  remainingQty: number;
  unitCost: number;
  warehouseId: string;
  selected: boolean;
  returnQty: number | '';
};

type SalesReturn = {
  id: string;
  number: string;
  returnDate: string;
  total: number;
  customerName?: string | null;
  scrapKg?: number;
  scrapPieces?: number;
  consumptionAmount?: number;
  giveReplacement?: boolean;
  replacementQty?: number;
  notes?: string | null;
  customer?: { name: string } | null;
  warehouse: { name: string };
  cashAccount?: { name: string } | null;
  cashAccountId?: string | null;
  replacementProduct?: { name: string } | null;
  replacementProductId?: string | null;
  replacementWarehouse?: { name: string } | null;
  replacementWarehouseId?: string | null;
  salesInvoice: { number: string } | null;
  lines: { productId?: string; quantity: number; unitPrice: number; total: number; product: { name: string } }[];
};

type PurchaseReturn = {
  id: string; number: string; returnDate: string; total: number; notes?: string | null;
  consumptionFee?: number; feeSettlement?: string | null; feeMethodId?: string | null;
  supplierId: string;
  warehouseId: string;
  supplier: { name: string }; warehouse: { id?: string; name: string };
  purchaseInvoice: { number: string } | null;
  lines: {
    id?: string;
    productId: string;
    quantity: number;
    unitCost: number;
    total: number;
    restockedQty?: number;
    product: { name: string };
  }[];
};

type PurchaseApiProduct = {
  productId: string; sku: string; name: string; unit: string;
  purchasedQty: number; returnedQty: number;
  purchaseRemaining?: number; returnsStock?: number; warehouseStock?: number;
  remainingQty: number; unitCost: number; warehouseId: string;
};

const emptySalesForm = {
  customerName: '',
  productId: '',
  scrapKg: '' as number | '',
  scrapPieces: '' as number | '',
  hasConsumption: false,
  consumptionAmount: '' as number | '',
  cashAccountId: '',
  giveReplacement: false,
  replacementProductId: '',
  replacementWarehouseId: '',
  replacementQty: 1 as number | '',
  notes: '',
};

const num = (v: number | '') => (v === '' ? 0 : v);

export function ReturnsPage() {
  const [tab, setTab] = useState<'sales' | 'purchases' | 'old' | 'warranty'>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'old' || t === 'warranty' || t === 'purchases' ? t : 'sales';
  });
  const [oldCounts, setOldCounts] = useState<{ toSort: number; inShop: number; withSupplier: number } | null>(null);
  const batteriesTab = tab === 'old' || tab === 'warranty';
  useEffect(() => {
    api<{ toSort: number; inShop: number; withSupplier: number }>('/returns/old-batteries/summary').then(setOldCounts).catch(() => setOldCounts(null));
  }, []);
  const [salesReturns, setSalesReturns] = useState<SalesReturn[]>([]);
  const [purchaseReturns, setPurchaseReturns] = useState<PurchaseReturn[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [warehouses, setWarehouses] = useState<Party[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [listPage, setListPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [salesTotal, setSalesTotal] = useState(0);
  const [purchaseTotal, setPurchaseTotal] = useState(0);
  const [salesSummary, setSalesSummary] = useState({ count: 0, amount: 0, monthCount: 0, monthAmount: 0 });
  const [purchaseSummary, setPurchaseSummary] = useState({ count: 0, amount: 0 });
  const [detail, setDetail] = useState<SalesReturn | PurchaseReturn | null>(null);
  const [restockFor, setRestockFor] = useState<PurchaseReturn | null>(null);
  const [restockWarehouseId, setRestockWarehouseId] = useState('');
  const [restockQtys, setRestockQtys] = useState<Record<string, number | ''>>({});
  const [restockError, setRestockError] = useState('');
  const toast = useToast();
  const confirm = useConfirm();

  const [salesForm, setSalesForm] = useState(emptySalesForm);
  const [purchaseForm, setPurchaseForm] = useState({
    supplierId: '', warehouseId: '', notes: '',
    hasFee: false, consumptionFee: '' as number | '', feeSettlement: 'BALANCE' as 'BALANCE' | 'CASH', methodId: '',
  });
  const [payMethods, setPayMethods] = useState<{ id: string; name: string; kind: string }[]>([]);
  useEffect(() => {
    api<{ id: string; name: string; kind: string }[]>('/cash/methods').then((m) => setPayMethods(m.filter((x) => x.kind === 'IMMEDIATE'))).catch(() => setPayMethods([]));
  }, []);
  const [purchaseProducts, setPurchaseProducts] = useState<PurchaseProductLine[]>([]);

  const returnsWarehouse = warehouses.find((w) => w.code === 'RETURNS' || w.name === 'مخزن المرتجعات');

  async function load() {
    const params = new URLSearchParams({ page: String(listPage), pageSize: String(pageSize) });
    if (search.trim()) params.set('q', search.trim());
    const [sr, pr, s, w, p, a] = await Promise.all([
      api<{ items: SalesReturn[]; total: number; summary: typeof salesSummary }>(`/returns/sales?${params}`),
      api<{ items: PurchaseReturn[]; total: number; summary: typeof purchaseSummary }>(`/returns/purchases?${params}`),
      api<Party[]>('/suppliers'),
      api<Party[]>('/warehouses'),
      api<Product[]>('/products'),
      api<Account[]>('/cash/accounts'),
    ]);
    setSalesReturns(sr.items);
    setPurchaseReturns(pr.items);
    setSalesTotal(sr.total);
    setPurchaseTotal(pr.total);
    setSalesSummary(sr.summary);
    setPurchaseSummary(pr.summary);
    setSuppliers(s);
    setWarehouses(w);
    setProducts(p);
    setAccounts(a);
  }

  useEffect(() => { setListPage(1); }, [search, pageSize, tab]);
  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch(() => undefined); }, 200);
    return () => window.clearTimeout(timer);
  }, [listPage, pageSize, search]);

  const filteredSales = salesReturns;
  const filteredPurchases = purchaseReturns;
  const listTotal = tab === 'sales' ? salesTotal : purchaseTotal;
  const pageCount = Math.max(1, Math.ceil(listTotal / pageSize));
  const pageFrom = listTotal === 0 ? 0 : (Math.min(listPage, pageCount) - 1) * pageSize + 1;
  const pageTo = Math.min(Math.min(listPage, pageCount) * pageSize, listTotal);

  async function loadPurchaseProducts(supplierId: string, warehouseId?: string) {
    if (!supplierId) {
      setPurchaseProducts([]);
      return;
    }
    setLoadingItems(true);
    setError('');
    try {
      const qs = warehouseId ? `?warehouseId=${encodeURIComponent(warehouseId)}` : '';
      const res = await api<{ products: PurchaseApiProduct[] }>(`/returns/purchases/products/${supplierId}${qs}`);
      setPurchaseProducts(
        res.products.map((line) => ({ ...line, selected: false, returnQty: '' })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تحميل الأصناف');
      setPurchaseProducts([]);
    } finally {
      setLoadingItems(false);
    }
  }

  function openModal() {
    setError('');
    setEditingId(null);
    setSalesForm({
      ...emptySalesForm,
      cashAccountId: accounts[0]?.id || '',
      replacementQty: 1,
    });
    const defaultWh = returnsWarehouse?.id || warehouses[0]?.id || '';
    setPurchaseForm({ supplierId: '', warehouseId: defaultWh, notes: '', hasFee: false, consumptionFee: '', feeSettlement: 'BALANCE', methodId: payMethods[0]?.id || '' });
    setPurchaseProducts([]);
    setOpen(true);
  }

  function openEditSales(row: SalesReturn) {
    setError('');
    setEditingId(row.id);
    setTab('sales');
    setSalesForm({
      customerName: row.customerName || '',
      productId: row.lines[0]?.productId || '',
      scrapKg: row.scrapKg || '',
      scrapPieces: row.scrapPieces || '',
      hasConsumption: (row.consumptionAmount || 0) > 0,
      consumptionAmount: row.consumptionAmount || '',
      cashAccountId: row.cashAccountId || accounts[0]?.id || '',
      giveReplacement: !!row.giveReplacement,
      replacementProductId: row.replacementProductId || '',
      replacementWarehouseId: row.replacementWarehouseId || '',
      replacementQty: row.replacementQty || 1,
      notes: row.notes || '',
    });
    setOpen(true);
  }

  async function openEditPurchase(row: PurchaseReturn) {
    setError('');
    setEditingId(row.id);
    setTab('purchases');
    const supplierId = row.supplierId;
    const warehouseId = row.warehouseId || row.warehouse.id || returnsWarehouse?.id || '';
    setPurchaseForm({
      supplierId,
      warehouseId,
      notes: row.notes || '',
      hasFee: (row.consumptionFee || 0) > 0,
      consumptionFee: row.consumptionFee || '',
      feeSettlement: row.feeSettlement === 'CASH' ? 'CASH' : 'BALANCE',
      methodId: row.feeMethodId || payMethods[0]?.id || '',
    });
    setOpen(true);
    setLoadingItems(true);
    try {
      const qs = warehouseId ? `?warehouseId=${encodeURIComponent(warehouseId)}` : '';
      const res = await api<{ products: PurchaseApiProduct[] }>(`/returns/purchases/products/${supplierId}${qs}`);
      const selectedIds = new Set(row.lines.map((l) => l.productId));
      const qtyByProduct = new Map(row.lines.map((l) => [l.productId, l.quantity]));
      const costByProduct = new Map(row.lines.map((l) => [l.productId, l.unitCost]));
      const merged = new Map<string, PurchaseProductLine>();
      for (const line of res.products) {
        const selected = selectedIds.has(line.productId);
        const editQty = qtyByProduct.get(line.productId) || 0;
        merged.set(line.productId, {
          ...line,
          remainingQty: line.remainingQty + (selected ? editQty : 0),
          returnsStock: (line.returnsStock || line.warehouseStock || 0) + (selected ? editQty : 0),
          unitCost: costByProduct.get(line.productId) ?? line.unitCost,
          selected,
          returnQty: selected ? editQty : '',
        });
      }
      for (const line of row.lines) {
        if (merged.has(line.productId)) continue;
        merged.set(line.productId, {
          productId: line.productId,
          sku: '',
          name: line.product.name,
          unit: '',
          purchasedQty: line.quantity,
          returnedQty: 0,
          purchaseRemaining: line.quantity,
          returnsStock: line.quantity,
          remainingQty: line.quantity,
          unitCost: line.unitCost,
          warehouseId: row.warehouseId,
          selected: true,
          returnQty: line.quantity,
        });
      }
      setPurchaseProducts(Array.from(merged.values()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تحميل الأصناف');
    } finally {
      setLoadingItems(false);
    }
  }

  async function removeReturn(row: SalesReturn | PurchaseReturn, kind: 'sales' | 'purchases') {
    const ok = await confirm({
      title: 'حذف المرتجع',
      message: `حذف المرتجع ${row.number} وعكس أثره على المخزون؟`,
      confirmLabel: 'حذف',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/returns/${kind}/${row.id}`, { method: 'DELETE' });
      toast.success('تم حذف المرتجع');
      if (detail?.id === row.id) setDetail(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر الحذف');
    }
  }

  function openRestock(row: PurchaseReturn) {
    setRestockError('');
    setRestockFor(row);
    setRestockWarehouseId(warehouses.find((w) => w.code !== 'RETURNS')?.id || warehouses[0]?.id || '');
    const qtys: Record<string, number | ''> = {};
    for (const line of row.lines) {
      const key = line.productId || line.product.name;
      const left = Math.max(0, line.quantity - (line.restockedQty || 0));
      qtys[key] = left > 0 ? left : '';
    }
    setRestockQtys(qtys);
  }

  async function saveRestock() {
    if (!restockFor) return;
    setRestockError('');
    if (!restockWarehouseId) {
      setRestockError('اختر المخزن الجديد');
      return;
    }
    const lines = restockFor.lines
      .map((line) => {
        const key = line.productId || line.product.name;
        return {
          productId: line.productId || '',
          quantity: num(restockQtys[key] ?? ''),
        };
      })
      .filter((line) => line.productId && line.quantity > 0);
    if (!lines.length) {
      setRestockError('حدد كمية واحدة على الأقل');
      return;
    }
    try {
      await api(`/returns/purchases/${restockFor.id}/restock`, {
        method: 'POST',
        body: JSON.stringify({ warehouseId: restockWarehouseId, lines }),
      });
      toast.success('تم إضافة الكمية للمخزن الجديد');
      setRestockFor(null);
      load();
    } catch (e) {
      setRestockError(e instanceof Error ? e.message : 'تعذر الاستلام');
    }
  }

  async function save() {
    setError('');
    try {
      if (tab === 'sales') {
        if (!salesForm.productId && !(num(salesForm.scrapKg) > 0) && !(num(salesForm.scrapPieces) > 0)) {
          setError('اختَر صنفًا أو أدخل كيلوهات/قطع');
          return;
        }
        if (salesForm.hasConsumption) {
          if (!(num(salesForm.consumptionAmount) > 0)) {
            setError('أدخل مبلغ الاستهلاك');
            return;
          }
          if (!salesForm.cashAccountId) {
            setError('اختَر الحساب لاستلام الاستهلاك');
            return;
          }
        }
        if (salesForm.giveReplacement) {
          if (!salesForm.replacementProductId) {
            setError('اختَر البطارية الجديدة');
            return;
          }
          if (!salesForm.replacementWarehouseId) {
            setError('اختَر مخزن البطارية الجديدة');
            return;
          }
          if (!(num(salesForm.replacementQty) > 0)) {
            setError('أدخل كمية البطارية الجديدة');
            return;
          }
        }
        const body = {
          customerName: salesForm.customerName.trim() || undefined,
          productId: salesForm.productId || undefined,
          scrapKg: num(salesForm.scrapKg),
          scrapPieces: num(salesForm.scrapPieces),
          consumptionAmount: salesForm.hasConsumption ? num(salesForm.consumptionAmount) : 0,
          cashAccountId: salesForm.hasConsumption ? salesForm.cashAccountId : undefined,
          giveReplacement: salesForm.giveReplacement,
          replacementProductId: salesForm.giveReplacement ? salesForm.replacementProductId : undefined,
          replacementWarehouseId: salesForm.giveReplacement ? salesForm.replacementWarehouseId : undefined,
          replacementQty: salesForm.giveReplacement ? num(salesForm.replacementQty) : 0,
          notes: salesForm.notes || undefined,
        };
        if (editingId) {
          await api(`/returns/sales/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
        } else {
          await api('/returns/sales', { method: 'POST', body: JSON.stringify(body) });
        }
      } else {
        const chosen = purchaseProducts.filter((line) => line.selected && line.returnQty !== '' && Number(line.returnQty) > 0);
        if (!purchaseForm.supplierId && !editingId) {
          setError('اختر المورد');
          return;
        }
        if (!purchaseForm.warehouseId) {
          setError('اختر المخزن الخارج منه المرتجع');
          return;
        }
        if (!chosen.length) {
          setError('حدد أصنافاً وكمية الإرجاع');
          return;
        }
        for (const line of chosen) {
          const qty = Number(line.returnQty || 0);
          if (qty > line.remainingQty) {
            setError(`الكمية المرتجعة للصنف ${line.name} أكبر من المتاح (${line.remainingQty})`);
            return;
          }
        }
        const fee = purchaseForm.hasFee ? num(purchaseForm.consumptionFee) : 0;
        if (purchaseForm.hasFee && fee <= 0) {
          setError('اكتب مبلغ الاستهلاك');
          return;
        }
        if (fee > 0 && purchaseForm.feeSettlement === 'CASH' && !purchaseForm.methodId) {
          setError('اختار طريقة دفع الاستهلاك');
          return;
        }
        const feeBody = {
          consumptionFee: fee,
          feeSettlement: fee > 0 ? purchaseForm.feeSettlement : undefined,
          methodId: fee > 0 && purchaseForm.feeSettlement === 'CASH' ? purchaseForm.methodId : undefined,
        };
        const body = {
          supplierId: purchaseForm.supplierId,
          warehouseId: purchaseForm.warehouseId,
          notes: purchaseForm.notes || undefined,
          ...feeBody,
          lines: chosen.map((line) => ({
            productId: line.productId,
            quantity: Number(line.returnQty),
            unitCost: line.unitCost,
          })),
        };
        if (editingId) {
          await api(`/returns/purchases/${editingId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              warehouseId: body.warehouseId,
              notes: body.notes,
              ...feeBody,
              lines: body.lines,
            }),
          });
        } else {
          await api('/returns/purchases', { method: 'POST', body: JSON.stringify(body) });
        }
      }
      setOpen(false);
      setEditingId(null);
      toast.success(editingId ? 'تم تعديل المرتجع' : (tab === 'sales' ? 'تم حفظ المرتجع' : 'تم حفظ مرتجع الشراء'));
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشل حفظ المرتجع');
    }
  }

  const replacementProducts = productsForWarehouse(products, salesForm.replacementWarehouseId);
  const allProducts = products;

  return (
    <div>
      <PageHeader
        title="المرتجعات"
        subtitle="مرتجع البيع يدخل مخزن المرتجعات · مرتجع الشراء من أصناف المورد مع استلام بديل"
        actions={
          <>
            {!batteriesTab && <SearchBox value={search} onChange={setSearch} placeholder="بحث مرتجع..." />}
            {!batteriesTab && (
              <Button onClick={openModal}>
                <Plus size={16} /> {tab === 'sales' ? 'مرتجع جديد' : 'مرتجع شراء'}
              </Button>
            )}
          </>
        }
      />

      <StatGrid>
        <StatCard label="مرتجعات البيع" value={formatMoney(salesSummary.amount)} hint={`${salesSummary.count} مرتجع`} icon={Undo2} tone="rose" onClick={() => setTab('sales')} active={tab === 'sales'} />
        <StatCard label="مرتجعات الشراء" value={formatMoney(purchaseSummary.amount)} hint={`${purchaseSummary.count} مرتجع للموردين`} icon={Redo2} tone="sky" onClick={() => setTab('purchases')} active={tab === 'purchases'} />
        <StatCard label="مرتجعات بيع هذا الشهر" value={formatMoney(salesSummary.monthAmount)} hint={`${salesSummary.monthCount} مرتجع`} icon={CalendarDays} tone="amber" />
        <StatCard label="وحدات مرتجعة" value={[...salesReturns, ...purchaseReturns].reduce((s, r) => s + r.lines.reduce((x, l) => x + l.quantity, 0), 0).toLocaleString('ar-EG')} hint="بيع + شراء" icon={PackageOpen} tone="violet" />
      </StatGrid>

      <div className="mb-4 flex w-fit rounded-xl border border-slate-200 bg-white p-1 shadow-sm no-print">
        {([
          ['sales', 'مرتجعات البيع', salesSummary.count],
          ['purchases', 'مرتجعات الشراء', purchaseSummary.count],
          ['old', 'فرز البطاريات القديمة', oldCounts?.toSort ?? 0],
          ['warranty', 'ضمان الموردين', (oldCounts?.inShop ?? 0) + (oldCounts?.withSupplier ?? 0)],
        ] as const).map(([id, label, count]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={`inline-flex h-9 items-center gap-2 rounded-lg px-4 text-[13px] font-bold transition ${tab === id ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
            {label}
            <span className={`rounded-md px-1.5 text-[11px] tabular-nums ${tab === id ? 'bg-white/20' : 'bg-slate-100'}`}>{count}</span>
          </button>
        ))}
      </div>

      {batteriesTab && (
        <OldBatteriesPanel key={tab} mode={tab === 'old' ? 'sort' : 'warranty'} onCountsChange={setOldCounts} />
      )}
      {!batteriesTab && (
      <Card>
        <CardHeader
          title={tab === 'sales' ? 'سجل مرتجعات البيع' : 'سجل مرتجعات الشراء'}
          subtitle={`${listTotal} مرتجع`}
          icon={tab === 'sales' ? Undo2 : Redo2}
        />
        {(tab === 'sales' ? filteredSales.length : filteredPurchases.length) === 0 ? (
          <Empty
            text={listTotal ? 'لا توجد نتائج مطابقة' : 'لا توجد مرتجعات بعد'}
            action={<Button onClick={openModal}><Plus size={16} /> {tab === 'sales' ? 'مرتجع جديد' : 'مرتجع شراء'}</Button>}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>الرقم</Th>
                {tab === 'sales' ? <Th>العميل</Th> : <Th>المورد</Th>}
                {tab === 'sales' ? <Th>المخزن</Th> : <Th>المخزن</Th>}
                {tab === 'sales' ? <Th>الخردة / الصنف</Th> : <Th>الأصناف</Th>}
                {tab === 'sales' ? <Th>استهلاك</Th> : <Th>استلام بديل</Th>}
                {tab === 'sales' ? <Th>استبدال</Th> : <Th>الإجمالي</Th>}
                <Th>التاريخ</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {tab === 'sales'
                ? filteredSales.map((r) => (
                  <tr key={r.id} className="row-credit">
                    <Td><span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{r.number}</span></Td>
                    <Td className="font-semibold text-slate-800">{r.customerName || r.customer?.name || '—'}</Td>
                    <Td className="font-bold text-slate-900">{r.warehouse.name}</Td>
                    <Td>
                      {r.lines[0]?.product.name || 'بدون صنف'}
                      <div className="text-xs text-muted">
                        {(r.scrapKg || 0) > 0 ? `${r.scrapKg} كيلو` : ''}
                        {(r.scrapKg || 0) > 0 && (r.scrapPieces || 0) > 0 ? ' · ' : ''}
                        {(r.scrapPieces || 0) > 0 ? `${r.scrapPieces} قطعة` : ''}
                        {!(r.scrapKg || r.scrapPieces) && r.lines[0] ? `${r.lines[0].quantity} وحدة` : ''}
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap font-extrabold text-emerald-700">
                      {(r.consumptionAmount || 0) > 0 ? formatMoney(r.consumptionAmount || 0) : '—'}
                      {(r.consumptionAmount || 0) > 0 && r.cashAccount && (
                        <div className="text-xs font-semibold text-muted">{r.cashAccount.name}</div>
                      )}
                    </Td>
                    <Td>
                      {r.giveReplacement ? (
                        <div>
                          <Badge tone="brand">نعم</Badge>
                          <div className="mt-1 text-xs text-muted">
                            {r.replacementProduct?.name || '—'}
                            {r.replacementWarehouse ? ` · ${r.replacementWarehouse.name}` : ''}
                            {(r.replacementQty || 0) > 0 ? ` · ${r.replacementQty}` : ''}
                          </div>
                        </div>
                      ) : <span className="text-muted">لا</span>}
                    </Td>
                    <Td className="whitespace-nowrap text-slate-500">{formatDate(r.returnDate)}</Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        <IconAction label="عرض" onClick={() => setDetail(r)}><Eye size={14} /></IconAction>
                        <IconAction label="تعديل" onClick={() => openEditSales(r)}><Pencil size={14} /></IconAction>
                        <IconAction label="حذف" onClick={() => removeReturn(r, 'sales')}><Trash2 size={14} /></IconAction>
                      </div>
                    </Td>
                  </tr>
                ))
                : filteredPurchases.map((r) => {
                  const restockLeft = r.lines.reduce((s, l) => s + Math.max(0, l.quantity - (l.restockedQty || 0)), 0);
                  return (
                    <tr key={r.id} className="row-debit">
                      <Td><span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{r.number}</span></Td>
                      <Td className="font-bold text-slate-900">{r.supplier.name}</Td>
                      <Td className="text-slate-600">{r.warehouse.name}</Td>
                      <Td><Badge tone="slate">{r.lines.length} صنف · {r.lines.reduce((s, l) => s + l.quantity, 0)} وحدة</Badge></Td>
                      <Td>
                        {restockLeft > 0 ? (
                          <Button size="sm" variant="soft" onClick={() => openRestock(r)}>
                            تم اخذ كمية جديدة
                          </Button>
                        ) : (
                          <Badge tone="emerald">مكتمل</Badge>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap font-extrabold text-sky-700">
                        {formatMoney(r.total)}
                        {(r.consumptionFee || 0) > 0 && (
                          <div className="text-[11px] font-semibold text-amber-700">استهلاك {formatMoney(r.consumptionFee || 0)}{r.feeSettlement === 'CASH' ? ' (اتدفع)' : ' (على الحساب)'}</div>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-slate-500">{formatDate(r.returnDate)}</Td>
                      <Td>
                        <div className="flex items-center gap-1">
                          <IconAction label="عرض" onClick={() => setDetail(r)}><Eye size={14} /></IconAction>
                          <IconAction label="تعديل" onClick={() => openEditPurchase(r)}><Pencil size={14} /></IconAction>
                          <IconAction label="حذف" onClick={() => removeReturn(r, 'purchases')}><Trash2 size={14} /></IconAction>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
            </tbody>
          </Table>
        )}
        <Pager page={listPage} pages={pageCount} total={listTotal} from={pageFrom} to={pageTo} pageSize={pageSize} onPage={setListPage} />
      </Card>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `تفاصيل المرتجع ${detail.number}` : ''} wide>
        {detail && 'warehouse' in detail && (
          <div className="space-y-4">
            {'supplier' in detail ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-muted">المورد</div><div className="font-bold">{detail.supplier.name}</div></div>
                  <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-muted">المخزن · التاريخ</div><div className="font-bold">{detail.warehouse.name} · {formatDate(detail.returnDate)}</div></div>
                  <div className="rounded-xl bg-brand-50 p-3"><div className="text-xs text-brand-700">الإجمالي</div><div className="text-lg font-extrabold text-brand-800">{formatMoney(detail.total)}</div></div>
                </div>
                <Table>
                  <thead><tr><Th>الصنف</Th><Th>الكمية</Th><Th>مستلم بديل</Th><Th>التكلفة</Th><Th>الإجمالي</Th></tr></thead>
                  <tbody>
                    {detail.lines.map((l, i) => (
                      <tr key={i}>
                        <Td className="font-semibold">{l.product.name}</Td>
                        <Td className="tabular-nums">{l.quantity}</Td>
                        <Td className="tabular-nums">{l.restockedQty || 0}</Td>
                        <Td className="tabular-nums">{formatMoney(l.unitCost)}</Td>
                        <Td className="font-bold tabular-nums">{formatMoney(l.total)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-muted">العميل</div><div className="font-bold">{detail.customerName || detail.customer?.name || '—'}</div></div>
                  <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-muted">المخزن</div><div className="font-bold">{detail.warehouse.name}</div></div>
                  <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-muted">التاريخ</div><div className="font-bold">{formatDate(detail.returnDate)}</div></div>
                  <div className="rounded-xl bg-emerald-50 p-3">
                    <div className="text-xs text-emerald-700">استهلاك</div>
                    <div className="text-lg font-extrabold text-emerald-800">{formatMoney(detail.consumptionAmount || 0)}</div>
                    {detail.cashAccount && <div className="text-xs text-muted">{detail.cashAccount.name}</div>}
                  </div>
                </div>
                {detail.lines.length > 0 && (
                  <Table>
                    <thead><tr><Th>الصنف المرتجع</Th><Th>الكمية</Th></tr></thead>
                    <tbody>
                      {detail.lines.map((l, i) => (
                        <tr key={i}>
                          <Td className="font-semibold">{l.product.name}</Td>
                          <Td className="tabular-nums">{l.quantity}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
                {detail.giveReplacement && (
                  <div className="rounded-xl border border-brand-200 bg-brand-50/50 p-3 text-sm">
                    <div className="font-bold text-brand-900">تم استبدال ببطارية جديدة</div>
                    <div className="mt-1 text-brand-800">
                      {detail.replacementProduct?.name || '—'}
                      {detail.replacementWarehouse ? ` من ${detail.replacementWarehouse.name}` : ''}
                      {(detail.replacementQty || 0) > 0 ? ` · كمية ${detail.replacementQty}` : ''}
                    </div>
                  </div>
                )}
                {detail.notes && <div className="text-sm text-muted">ملاحظات: {detail.notes}</div>}
              </>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={!!restockFor}
        onClose={() => setRestockFor(null)}
        title={restockFor ? `استلام كمية جديدة · ${restockFor.number}` : ''}
        wide
      >
        {restockFor && (
          <div className="space-y-3">
            <p className="text-sm text-muted">هتضيف للمخزن الجديد نفس الأصناف اللي رجّعتها للمورد — تقدر تقلّل الكمية.</p>
            <div>
              <Label>المخزن الجديد</Label>
              <Select value={restockWarehouseId} onChange={(e) => setRestockWarehouseId(e.target.value)}>
                <option value="">اختر المخزن</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>الصنف</Th>
                  <Th>مرتجع</Th>
                  <Th>مستلم قبل كده</Th>
                  <Th>متاح</Th>
                  <Th>كمية الاستلام</Th>
                </tr>
              </thead>
              <tbody>
                {restockFor.lines.map((line) => {
                  const key = line.productId || line.product.name;
                  const left = Math.max(0, line.quantity - (line.restockedQty || 0));
                  return (
                    <tr key={key}>
                      <Td className="font-semibold">{line.product.name}</Td>
                      <Td className="tabular-nums">{line.quantity}</Td>
                      <Td className="tabular-nums">{line.restockedQty || 0}</Td>
                      <Td className="font-bold text-brand-700 tabular-nums">{left}</Td>
                      <Td>
                        <NumberInput
                          className="w-24"
                          value={restockQtys[key] ?? ''}
                          onValueChange={(v) => setRestockQtys((prev) => ({ ...prev, [key]: v }))}
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            {restockError && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{restockError}</div>}
            <Button className="w-full" onClick={saveRestock}>إضافة للمخزن</Button>
          </div>
        )}
      </Modal>

      <Modal open={open} onClose={() => { setOpen(false); setEditingId(null); }} title={tab === 'sales' ? (editingId ? 'تعديل مرتجع بيع' : 'مرتجع بيع جديد') : (editingId ? 'تعديل مرتجع شراء' : 'مرتجع شراء')} wide>
        {tab === 'sales' ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm font-semibold text-amber-950">
              الاستلام تلقائي على: {returnsWarehouse?.name || 'مخزن المرتجعات'}
            </div>

            <div>
              <Label>اسم العميل (اختياري)</Label>
              <Input
                value={salesForm.customerName}
                onChange={(e) => setSalesForm({ ...salesForm, customerName: e.target.value })}
                placeholder="مثال: محمد أحمد"
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <Label>الصنف المرتجع (اختياري)</Label>
                {salesForm.productId && (
                  <button type="button" className="text-xs font-bold text-brand-700" onClick={() => setSalesForm({ ...salesForm, productId: '' })}>
                    مسح الصنف
                  </button>
                )}
              </div>
              <ProductPicker
                products={allProducts.map((product) => ({
                  id: product.id,
                  name: product.name,
                  sku: product.sku,
                  barcode: product.barcode,
                }))}
                value={salesForm.productId}
                placeholder="اكتب اسم الصنف أو اتركه فاضي"
                onChange={(productId) => setSalesForm({ ...salesForm, productId })}
              />
              <p className="mt-1 text-xs text-muted">
                لو سجّلت كيلوهات/قطع قديمة تحت، الصنف ده بيتسجّل في «فرز البطاريات القديمة». من غير خردة، يدخل مخزن المرتجعات.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>عدد الكيلوهات</Label>
                <NumberInput value={salesForm.scrapKg} onValueChange={(v) => setSalesForm({ ...salesForm, scrapKg: v })} />
              </div>
              <div>
                <Label>عدد القطع</Label>
                <NumberInput value={salesForm.scrapPieces} onValueChange={(v) => setSalesForm({ ...salesForm, scrapPieces: v })} />
              </div>
            </div>
            <p className="text-xs text-muted">القطع/الكيلوهات القديمة تظهر في تبويب «فرز البطاريات القديمة» بعد الحفظ.</p>

            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold">
              <input
                type="checkbox"
                checked={salesForm.hasConsumption}
                onChange={(e) => setSalesForm({
                  ...salesForm,
                  hasConsumption: e.target.checked,
                  ...(e.target.checked ? {} : { consumptionAmount: '', cashAccountId: accounts[0]?.id || '' }),
                })}
              />
              في استهلاك فلوس؟
            </label>

            {salesForm.hasConsumption && (
              <div className="grid gap-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 sm:grid-cols-2">
                <div>
                  <Label>مبلغ الاستهلاك</Label>
                  <NumberInput value={salesForm.consumptionAmount} onValueChange={(v) => setSalesForm({ ...salesForm, consumptionAmount: v })} />
                </div>
                <div>
                  <Label>الحساب (إيراد)</Label>
                  <Select value={salesForm.cashAccountId} onChange={(e) => setSalesForm({ ...salesForm, cashAccountId: e.target.value })}>
                    <option value="">اختر الحساب</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </div>
              </div>
            )}

            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold">
              <input
                type="checkbox"
                checked={salesForm.giveReplacement}
                onChange={(e) => setSalesForm({
                  ...salesForm,
                  giveReplacement: e.target.checked,
                  ...(e.target.checked ? { replacementQty: salesForm.replacementQty || 1 } : {
                    replacementProductId: '',
                    replacementWarehouseId: '',
                    replacementQty: 1,
                  }),
                })}
              />
              هديله بطارية (سيرفس/جديدة) بدلها؟
            </label>

            {salesForm.giveReplacement && (
              <div className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-3">
                <p className="text-xs text-muted">
                  لو دي بطارية سيرفس مؤقتة لحد ضمان المورد: بعد ما تفرز القديمة ضمان وتوصل البديل، زر «تسليم للزبون» هيرجّع السيرفس للمخزن.
                </p>
                <div>
                  <Label>مخزن البطارية الجديدة</Label>
                  <Select
                    value={salesForm.replacementWarehouseId}
                    onChange={(e) => setSalesForm({ ...salesForm, replacementWarehouseId: e.target.value, replacementProductId: '' })}
                  >
                    <option value="">اختر المخزن</option>
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>البطارية الجديدة</Label>
                  <ProductPicker
                    products={replacementProducts.map((product) => ({
                      id: product.id,
                      name: product.name,
                      sku: product.sku,
                      barcode: product.barcode,
                    }))}
                    value={salesForm.replacementProductId}
                    disabled={!salesForm.replacementWarehouseId}
                    placeholder={salesForm.replacementWarehouseId ? 'اكتب اسم البطارية' : 'اختر المخزن أولاً'}
                    onChange={(replacementProductId) => setSalesForm({ ...salesForm, replacementProductId })}
                  />
                </div>
                <div>
                  <Label>الكمية</Label>
                  <NumberInput value={salesForm.replacementQty} onValueChange={(v) => setSalesForm({ ...salesForm, replacementQty: v })} />
                </div>
              </div>
            )}

            <div>
              <Label>ملاحظات</Label>
              <Input value={salesForm.notes} onChange={(e) => setSalesForm({ ...salesForm, notes: e.target.value })} />
            </div>
            {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
            <Button className="w-full" onClick={save}>{editingId ? 'حفظ التعديلات' : 'حفظ المرتجع'}</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>المورد</Label>
                <Select
                  value={purchaseForm.supplierId}
                  disabled={!!editingId}
                  onChange={(e) => {
                    const supplierId = e.target.value;
                    setPurchaseForm({ ...purchaseForm, supplierId });
                    loadPurchaseProducts(supplierId, purchaseForm.warehouseId);
                  }}
                >
                  <option value="">اختر المورد</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>المخزن الخارج منه المرتجع</Label>
                <Select
                  value={purchaseForm.warehouseId}
                  onChange={(e) => {
                    const warehouseId = e.target.value;
                    setPurchaseForm({ ...purchaseForm, warehouseId });
                    if (purchaseForm.supplierId) loadPurchaseProducts(purchaseForm.supplierId, warehouseId);
                  }}
                >
                  <option value="">اختر المخزن</option>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </div>
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-950">
              المتاح = الأقل بين (مشترى − مرتجع للمورد) ورصيد المخزن المختار — تقدر ترجع من مخزن المرتجعات أو أي مخزن تاني
            </div>

            {loadingItems && <div className="text-sm text-muted">جاري تحميل أصناف المورد...</div>}

            {!loadingItems && purchaseForm.supplierId && purchaseProducts.length === 0 && (
              <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
                لا توجد أصناف قابلة للإرجاع من هذا المورد في المخزن المختار
              </div>
            )}

            {purchaseProducts.length > 0 && (
              <div className="rounded-xl border border-sky-200 bg-sky-50/40 p-3">
                <div className="mb-2 font-bold text-sky-950">أصناف مستلمة من المورد</div>
                <Table>
                  <thead>
                    <tr>
                      <Th></Th>
                      <Th>الصنف</Th>
                      <Th>مشترى</Th>
                      <Th>مرتجع للمورد</Th>
                      <Th>رصيد المخزن</Th>
                      <Th>متاح</Th>
                      <Th>التكلفة</Th>
                      <Th>كمية الإرجاع</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseProducts.map((line) => (
                      <tr key={line.productId} className={line.selected ? 'bg-white' : ''}>
                        <Td>
                          <input
                            type="checkbox"
                            checked={line.selected}
                            disabled={line.remainingQty <= 0}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setPurchaseProducts((prev) => prev.map((item) => item.productId !== line.productId ? item : {
                                ...item,
                                selected: checked,
                                returnQty: checked ? (item.returnQty === '' ? item.remainingQty : item.returnQty) : '',
                              }));
                            }}
                          />
                        </Td>
                        <Td>
                          <div className="font-semibold">{line.name}</div>
                          <div className="font-mono text-xs text-muted">{line.sku}</div>
                        </Td>
                        <Td>{line.purchasedQty}</Td>
                        <Td>{line.returnedQty}</Td>
                        <Td>{line.warehouseStock ?? line.returnsStock ?? 0}</Td>
                        <Td className="font-bold text-brand-700">{line.remainingQty}</Td>
                        <Td>{formatMoney(line.unitCost)}</Td>
                        <Td>
                          <NumberInput
                            className="w-24"
                            value={line.returnQty}
                            onValueChange={(v) => {
                              setPurchaseProducts((prev) => prev.map((item) => item.productId !== line.productId ? item : {
                                ...item, selected: true, returnQty: v,
                              }));
                            }}
                          />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}

            <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
              <label className="flex items-center gap-2 text-sm font-bold text-amber-900">
                <input
                  type="checkbox"
                  checked={purchaseForm.hasFee}
                  onChange={(e) => setPurchaseForm({ ...purchaseForm, hasFee: e.target.checked, methodId: purchaseForm.methodId || payMethods[0]?.id || '' })}
                />
                هدفع للمورد استهلاك على المرتجع ده
              </label>
              {purchaseForm.hasFee && (
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <div>
                    <Label>مبلغ الاستهلاك</Label>
                    <NumberInput value={purchaseForm.consumptionFee} onValueChange={(v) => setPurchaseForm({ ...purchaseForm, consumptionFee: v })} />
                  </div>
                  <div>
                    <Label>هتدفعه إزاي</Label>
                    <div className="flex rounded-xl bg-slate-100 p-1">
                      {([['BALANCE', 'على حسابه'], ['CASH', 'دفع فوري']] as const).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setPurchaseForm({ ...purchaseForm, feeSettlement: key })}
                          className={`h-8 flex-1 rounded-lg text-xs font-bold transition ${purchaseForm.feeSettlement === key ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {purchaseForm.feeSettlement === 'CASH' && (
                    <div>
                      <Label>من</Label>
                      <Select value={purchaseForm.methodId} onChange={(e) => setPurchaseForm({ ...purchaseForm, methodId: e.target.value })}>
                        <option value="">اختار</option>
                        {payMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </Select>
                    </div>
                  )}
                  <p className="text-xs text-amber-800 sm:col-span-3">
                    {purchaseForm.feeSettlement === 'BALANCE'
                      ? 'المبلغ هيتضاف على اللي عليك للمورد في كشف حسابه.'
                      : 'المبلغ هيتخصم من الخزنة ويظهر في كشف المورد كاستهلاك ومسدد.'}
                    {' '}وبيتحسب مصروف في تقرير الأرباح.
                  </p>
                </div>
              )}
            </div>

            <div>
              <Label>ملاحظات</Label>
              <Input value={purchaseForm.notes} onChange={(e) => setPurchaseForm({ ...purchaseForm, notes: e.target.value })} />
            </div>
            {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
            <Button className="w-full" onClick={save}>{editingId ? 'حفظ التعديلات' : 'حفظ المرتجع'}</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
