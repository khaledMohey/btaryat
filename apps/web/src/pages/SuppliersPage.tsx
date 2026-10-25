import { useEffect, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, FileText, Hash, MapPin, Pencil, Phone, Plus, Printer, Truck, Wallet, Warehouse } from 'lucide-react';
import { loadExcel } from '../lib/excel';
import { api, formatDate, formatMoney, initialQuery } from '../lib/api';
import { urgentInvoiceDate } from '../lib/due';
import { DueAmount } from '../components/DueAmount';
import { useColumns } from '../lib/columns';
import { useToast } from '../lib/feedback';
import { FilterOption, IconAction, ListBar } from '../components/ListBar';
import { WarehouseMultiSelect } from '../components/WarehouseMultiSelect';
import {
  Badge, Button, Card, Empty, Field, Input, Label, Modal, PageHeader, Pager, PrintHeader, StatCard, StatGrid, Table, Td, Th,
} from '../components/ui';

type Supplier = {
  id: string;
  code: string;
  name: string;
  phone?: string | null;
  address?: string | null;
  balance: number;
  isActive?: boolean;
  warehouses?: { warehouseId: string; warehouse?: { id: string; name: string } }[];
};

type StatementRow = {
  date: string;
  type: string;
  ref: string;
  debit: number;
  credit: number;
  balance: number;
  method?: string | null;
  note?: string | null;
};

type SupplierForm = { code: string; name: string; phone: string; address: string; isActive: boolean; warehouseIds: string[] };

const emptySupplier: SupplierForm = { code: '', name: '', phone: '', address: '', isActive: true, warehouseIds: [] };
const SUPPLIER_VIEW = 'm5azen.suppliersView';

export function SuppliersPage() {
  const toast = useToast();
  const [items, setItems] = useState<Supplier[]>([]);
  const [listPage, setListPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ debitCount: 0, creditCount: 0 });
  const [search, setSearch] = useState(initialQuery);
  const [listView, setListView] = useState<'all' | 'debit' | 'credit'>('all');
  const [view, setView] = useState<'table' | 'cards'>(() => (localStorage.getItem(SUPPLIER_VIEW) === 'cards' ? 'cards' : 'table'));
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [stmtOpen, setStmtOpen] = useState(false);
  const [statement, setStatement] = useState<{ supplier: Supplier; statement: StatementRow[]; balance: number } | null>(null);
  const [form, setForm] = useState<SupplierForm>(emptySupplier);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [dueDates, setDueDates] = useState<Record<string, string>>({});
  const columns = useColumns('m5azen.cols.suppliers', [
    { id: 'balance', label: 'الرصيد' },
    { id: 'phone', label: 'الهاتف' },
    { id: 'address', label: 'العنوان' },
    { id: 'name', label: 'الاسم' },
    { id: 'code', label: 'الكود' },
  ]);

  async function load() {
    const params = new URLSearchParams({ page: String(listPage), pageSize: String(pageSize) });
    if (search.trim()) params.set('search', search.trim());
    if (listView !== 'all') params.set('balance', listView);
    const suppliers = await api<{ items: Supplier[]; total: number; summary: typeof summary }>(`/suppliers?${params}`);
    setItems(suppliers.items);
    setTotal(suppliers.total);
    setSummary(suppliers.summary);
    const purchases = await api<{ invoiceDate: string; total: number; paidAmount: number; supplierId: string }[]>('/purchases/dues').catch(() => []);
    const grouped = new Map<string, { invoiceDate: string; remaining: number }[]>();
    for (const inv of purchases) {
      const rows = grouped.get(inv.supplierId) || [];
      rows.push({ invoiceDate: inv.invoiceDate, remaining: inv.total - inv.paidAmount });
      grouped.set(inv.supplierId, rows);
    }
    const dates: Record<string, string> = {};
    grouped.forEach((rows, id) => {
      const date = urgentInvoiceDate(rows);
      if (date) dates[id] = date;
    });
    setDueDates(dates);
  }

  function supplierBalance(row: Supplier) {
    const date = dueDates[row.id];
    if (row.balance > 0.009 && date) return <DueAmount date={date} remaining={row.balance} />;
    return <span className="font-extrabold">{formatMoney(row.balance)}</span>;
  }

  useEffect(() => {
    api<{ id: string; name: string }[]>('/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
  }, []);
  useEffect(() => { setListPage(1); }, [search, listView, pageSize]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      load().catch((error) => toast.error(error instanceof Error ? error.message : 'تعذر تحميل الموردين'));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [listPage, pageSize, search, listView]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageFrom = total === 0 ? 0 : (Math.min(listPage, pageCount) - 1) * pageSize + 1;
  const pageTo = Math.min(Math.min(listPage, pageCount) * pageSize, total);
  const formErrors = {
    code: !form.code.trim() ? 'كود المورد مطلوب' : items.some((row) => row.id !== editingId && row.code.toLowerCase() === form.code.trim().toLowerCase()) ? 'الكود مستخدم لمورد آخر' : '',
    name: form.name.trim().length < 2 ? 'اسم المورد حرفين على الأقل' : '',
  };
  const debitCount = summary.debitCount;
  const creditCount = summary.creditCount;

  function openCreate() {
    setEditingId(null);
    setForm(emptySupplier);
    setOpen(true);
  }

  function openEdit(row: Supplier) {
    setEditingId(row.id);
    setForm({
      code: row.code,
      name: row.name,
      phone: row.phone || '',
      address: row.address || '',
      isActive: row.isActive !== false,
      warehouseIds: (row.warehouses || []).map((link) => link.warehouseId),
    });
    setOpen(true);
  }

  async function save() {
    if (formErrors.code || formErrors.name) return;
    setSaving(true);
    try {
      const body = {
        code: form.code.trim(),
        name: form.name.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        warehouseIds: form.warehouseIds,
        ...(editingId ? { isActive: form.isActive } : {}),
      };
      await api(editingId ? `/suppliers/${editingId}` : '/suppliers', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      toast.success(editingId ? 'تم تعديل المورد' : 'تم إضافة المورد');
      setOpen(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'تعذر حفظ المورد');
    } finally {
      setSaving(false);
    }
  }

  async function showStatement(id: string) {
    const data = await api<{ supplier: Supplier; statement: StatementRow[]; balance: number }>(`/suppliers/${id}/statement`);
    setStatement(data);
    setStmtOpen(true);
  }

  async function exportRows() {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (listView !== 'all') params.set('balance', listView);
    const rows = await api<Supplier[]>(`/suppliers${params.toString() ? `?${params}` : ''}`);
    const ExcelJS = await loadExcel();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('الموردين');
    sheet.addRow(['الكود', 'الاسم', 'الهاتف', 'العنوان', 'الرصيد', 'الحالة']);
    rows.forEach((row) => sheet.addRow([row.code, row.name, row.phone || '', row.address || '', row.balance, row.isActive === false ? 'موقوف' : 'نشط']));
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer]));
    link.download = 'suppliers.xlsx';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div>
      <PageHeader
        title="الموردين"
        subtitle="بيانات الموردين وكشوف الحساب"
        actions={<Button onClick={openCreate}><Plus size={16} /> مورد جديد</Button>}
      />

      <StatGrid>
        <StatCard label="إجمالي الموردين" value={items.length} hint={`${items.filter((row) => row.isActive !== false).length} مورد نشط`} icon={Truck} tone="brand" active={listView === 'all'} onClick={() => setListView('all')} />
        <StatCard label="مستحقات للموردين" value={formatMoney(items.reduce((sum, row) => sum + Math.max(0, row.balance), 0))} hint="إجمالي المطلوب سداده" icon={Wallet} tone="rose" />
        <StatCard label="رصيد مدين" value={debitCount} hint="موردين لهم مبالغ" icon={ArrowUpCircle} tone="amber" active={listView === 'debit'} onClick={() => setListView('debit')} />
        <StatCard label="رصيد دائن" value={creditCount} hint="موردين دفعنا لهم مقدماً" icon={ArrowDownCircle} tone="emerald" active={listView === 'credit'} onClick={() => setListView('credit')} />
      </StatGrid>

      <Card>
        <ListBar
          search={search}
          onSearch={setSearch}
          placeholder="بحث بالكود أو الاسم أو الهاتف"
          view={view}
          onView={(mode) => { setView(mode); localStorage.setItem(SUPPLIER_VIEW, mode); }}
          onExport={exportRows}
          columns={columns.columns}
          onToggleColumn={columns.toggle}
          filterActive={listView !== 'all'}
          filter={(
            <div className="space-y-1">
              <div className="mb-2 text-xs font-bold text-muted">تصفية الموردين</div>
              {([['all', 'الكل'], ['debit', 'رصيد مدين'], ['credit', 'رصيد دائن']] as const).map(([key, label]) => (
                <FilterOption key={key} active={listView === key} onClick={() => setListView(key)}>{label}</FilterOption>
              ))}
            </div>
          )}
        />
        {items.length === 0 ? <Empty text="لا يوجد موردين مطابقون" hint="غيّر البحث أو التصفية" /> : view === 'cards' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((row) => (
                <div key={row.id} className="lift rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-brand-700 text-white"><Truck size={18} /></span>
                      <div className="min-w-0">
                        <div className="truncate text-base font-extrabold">{row.name}</div>
                        <div className="font-mono text-xs font-bold text-brand-700" dir="ltr">{row.code}</div>
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${row.isActive === false ? 'bg-slate-200 text-slate-600' : 'bg-emerald-50 text-emerald-700'}`}>{row.isActive === false ? 'موقوف' : 'نشط'}</span>
                  </div>
                  <div className="mt-3 flex items-center gap-1.5 text-sm text-muted"><Phone size={13} /><bdi dir="ltr">{row.phone || 'بدون هاتف'}</bdi></div>
                  <div className="mt-4 flex items-end justify-between border-t border-slate-100 pt-3">
                    <div>
                      <div className="text-xs text-muted">الرصيد</div>
                      {supplierBalance(row)}
                    </div>
                    <div className="flex gap-1">
                      <IconAction label="تعديل" onClick={() => openEdit(row)}><Pencil size={14} /></IconAction>
                      <IconAction label="كشف حساب" onClick={() => showStatement(row.id)}><FileText size={14} /></IconAction>
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
                  {columns.visible('balance') && <Th>الرصيد</Th>}
                  {columns.visible('phone') && <Th>الهاتف</Th>}
                  {columns.visible('address') && <Th>العنوان</Th>}
                  {columns.visible('name') && <Th>الاسم</Th>}
                  {columns.visible('code') && <Th>الكود</Th>}
                  <Th>الإجراءات</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className={row.balance > 0 ? 'row-debit' : row.balance < 0 ? 'row-credit' : ''}>
                    {columns.visible('balance') && <Td>{supplierBalance(row)}</Td>}
                    {columns.visible('phone') && <Td><bdi dir="ltr" className="font-medium text-slate-600">{row.phone || '—'}</bdi></Td>}
                    {columns.visible('address') && <Td className="max-w-xs truncate text-muted">{row.address || '—'}</Td>}
                    {columns.visible('name') && (
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sky-50 text-sky-700"><Truck size={15} /></span>
                          <span className="truncate font-bold text-slate-800">{row.name}</span>
                          {row.isActive === false && <Badge tone="slate">موقوف</Badge>}
                        </div>
                      </Td>
                    )}
                    {columns.visible('code') && <Td><span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-700" dir="ltr">{row.code}</span></Td>}
                    <Td>
                      <div className="flex gap-1">
                        <IconAction label="تعديل" onClick={() => openEdit(row)}><Pencil size={14} /></IconAction>
                        <IconAction label="كشف حساب" onClick={() => showStatement(row.id)}><FileText size={14} /></IconAction>
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

      <Modal open={open} onClose={() => setOpen(false)} title={editingId ? 'تعديل مورد' : 'مورد جديد'}>
        <div className="space-y-3">
          <Field label="كود المورد" icon={<Hash size={16} />} error={formErrors.code}>
            <Input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
          </Field>
          <Field label="اسم المورد" icon={<Truck size={16} />} error={formErrors.name}>
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="رقم الهاتف" icon={<Phone size={16} />}>
            <Input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </Field>
          <Field label="العنوان" icon={<MapPin size={16} />}>
            <Input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} />
          </Field>
          <div>
            <Label>
              <span className="inline-flex items-center gap-1.5"><Warehouse size={15} className="text-slate-400" /> المخازن</span>
            </Label>
            <WarehouseMultiSelect
              warehouses={warehouses}
              value={form.warehouseIds}
              onChange={(warehouseIds) => setForm({ ...form, warehouseIds })}
              hint="المورد يظهر ليوزر المخازن دي فقط. لو مفيش اختيار يظهر للكل"
            />
          </div>
          {editingId && (
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
              المورد نشط
            </label>
          )}
          <Button className="w-full" disabled={saving || !!formErrors.code || !!formErrors.name} onClick={save}>{editingId ? 'حفظ التعديلات' : 'حفظ المورد'}</Button>
        </div>
      </Modal>

      <Modal open={stmtOpen} onClose={() => setStmtOpen(false)} title={`كشف حساب — ${statement?.supplier.name || ''}`} wide>
        {statement && (
          <div>
            <PrintHeader title={`كشف حساب مورد: ${statement.supplier.name}`} subtitle={`الرصيد الحالي: ${formatMoney(statement.balance)}`} />
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-muted">إجمالي المدين</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-slate-900">{formatMoney(statement.statement.reduce((s, r) => s + r.debit, 0))}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-muted">إجمالي الدائن</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-slate-900">{formatMoney(statement.statement.reduce((s, r) => s + r.credit, 0))}</div>
              </div>
              <div className="rounded-xl bg-gradient-to-br from-brand-700 to-brand-900 p-3 text-white">
                <div className="text-xs text-white/75">الرصيد الحالي</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums">{formatMoney(statement.balance)}</div>
              </div>
            </div>
            <div className="mb-4 flex justify-end no-print">
              <Button variant="secondary" onClick={() => window.print()}><Printer size={14} /> طباعة / PDF</Button>
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>التاريخ</Th>
                  <Th>النوع</Th>
                  <Th>المرجع</Th>
                  <Th>طريقة الدفع</Th>
                  <Th>مدين</Th>
                  <Th>دائن</Th>
                  <Th>الرصيد</Th>
                </tr>
              </thead>
              <tbody>
                {statement.statement.map((row, index) => (
                  <tr key={index} className={row.debit > 0 ? 'row-debit' : row.credit > 0 ? 'row-credit' : ''}>
                    <Td className="whitespace-nowrap text-slate-600">{formatDate(row.date)}</Td>
                    <Td className="font-semibold">{row.type}</Td>
                    <Td><span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{row.ref}</span></Td>
                    <Td className="text-muted">{row.method || '—'}</Td>
                    <Td className="font-semibold text-emerald-700">{row.debit ? formatMoney(row.debit) : '—'}</Td>
                    <Td className="font-semibold text-rose-700">{row.credit ? formatMoney(row.credit) : '—'}</Td>
                    <Td className="font-extrabold text-slate-900">{formatMoney(row.balance)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Modal>
    </div>
  );
}
