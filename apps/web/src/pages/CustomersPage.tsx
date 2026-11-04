import { useEffect, useState } from 'react';
import { CircleDollarSign, FileText, Hash, MapPin, Pencil, Phone, Plus, Printer, Users, Wallet, Warehouse } from 'lucide-react';
import { loadExcel } from '../lib/excel';
import { api, formatDate, formatMoney, initialQuery } from '../lib/api';
import { urgentInvoiceDate } from '../lib/due';
import { DueAmount } from '../components/DueAmount';
import { useFeedback } from '../lib/feedback';
import { useColumns } from '../lib/columns';
import { FilterOption, IconAction, ListBar } from '../components/ListBar';
import { NotesPanel } from '../components/NotesPanel';
import { EntityWorkspace } from '../components/EntityWorkspace';
import { WarehouseMultiSelect } from '../components/WarehouseMultiSelect';
import { LedgerDetailModal } from '../components/LedgerDetailModal';
import {
  Badge, Button, Card, Empty, Field, Input, Label, Modal, PageHeader, Pager, PrintHeader, Select, StatCard, StatGrid, Table, Td, Th,
} from '../components/ui';

type Customer = {
  id: string;
  code: string;
  name: string;
  phone?: string | null;
  address?: string | null;
  balance: number;
  priceList?: string;
  isActive?: boolean;
  warehouses?: { warehouseId: string; warehouse?: { id: string; name: string } }[];
};

type CustomerForm = {
  code: string;
  name: string;
  phone: string;
  address: string;
  priceList: string;
  isActive: boolean;
  warehouseIds: string[];
};

const emptyCustomer: CustomerForm = { code: '', name: '', phone: '', address: '', priceList: 'RETAIL', isActive: true, warehouseIds: [] };
const CUSTOMER_VIEW = 'm5azen.customersView';

type StatementRow = {
  date: string; type: string; ref: string; debit: number; credit: number; balance: number;
  method?: string | null;
  kind?: string;
  id?: string;
};

export function CustomersPage() {
  const [items, setItems] = useState<Customer[]>([]);
  const [listPage, setListPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ debitCount: 0, activeCount: 0, totalDue: 0 });
  const [search, setSearch] = useState(initialQuery);
  const [listView, setListView] = useState<'all' | 'debit'>('all');
  const [view, setView] = useState<'table' | 'cards'>(() => (localStorage.getItem(CUSTOMER_VIEW) === 'cards' ? 'cards' : 'table'));
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [stmtOpen, setStmtOpen] = useState(false);
  const [statement, setStatement] = useState<{ customer: Customer; statement: StatementRow[]; balance: number } | null>(null);
  const [ledgerDetail, setLedgerDetail] = useState<{ kind: string; id: string; title: string } | null>(null);
  const [form, setForm] = useState<CustomerForm>(emptyCustomer);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [views, setViews] = useState<{ id: string; name: string; query: string }[]>([]);
  const [dueDates, setDueDates] = useState<Record<string, string>>({});
  const feedback = useFeedback();

  async function load() {
    const params = new URLSearchParams({ page: String(listPage), pageSize: String(pageSize) });
    if (search.trim()) params.set('search', search.trim());
    if (listView === 'debit') params.set('balance', 'debit');
    const customers = await api<{ items: Customer[]; total: number; summary: typeof summary }>(`/customers?${params}`);
    setItems(customers.items);
    setTotal(customers.total);
    setSummary(customers.summary);
    const sales = await api<{ invoiceDate: string; total: number; paidAmount: number; customerId: string }[]>('/sales/dues').catch(() => []);
    const grouped = new Map<string, { invoiceDate: string; remaining: number }[]>();
    for (const inv of sales) {
      const rows = grouped.get(inv.customerId) || [];
      rows.push({ invoiceDate: inv.invoiceDate, remaining: inv.total - inv.paidAmount });
      grouped.set(inv.customerId, rows);
    }
    const dates: Record<string, string> = {};
    grouped.forEach((rows, id) => {
      const date = urgentInvoiceDate(rows);
      if (date) dates[id] = date;
    });
    setDueDates(dates);
  }

  function customerBalance(row: Customer) {
    const date = dueDates[row.id];
    if (row.balance > 0.009 && date) return <DueAmount date={date} remaining={row.balance} />;
    return <span className="font-extrabold">{formatMoney(row.balance)}</span>;
  }

  useEffect(() => {
    api<{ id: string; name: string; query: string }[]>('/work/views?module=customers').then(setViews).catch(() => setViews([]));
    api<{ id: string; name: string }[]>('/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
  }, []);
  useEffect(() => { setListPage(1); }, [search, listView, pageSize]);
  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch(() => undefined); }, 200);
    return () => window.clearTimeout(timer);
  }, [listPage, pageSize, search, listView]);

  useEffect(() => {
    const open = new URLSearchParams(window.location.search).get('open');
    if (open) showStatement(open);
  }, []);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageFrom = total === 0 ? 0 : (Math.min(listPage, pageCount) - 1) * pageSize + 1;
  const pageTo = Math.min(Math.min(listPage, pageCount) * pageSize, total);
  const customerColumns = useColumns('m5azen.cols.customers', [
    { id: 'balance', label: 'الرصيد' },
    { id: 'phone', label: 'الهاتف' },
    { id: 'address', label: 'العنوان' },
    { id: 'name', label: 'الاسم' },
    { id: 'code', label: 'الكود' },
  ]);
  const formErrors = {
    code: !form.code.trim() ? 'كود العميل مطلوب' : items.some((row) => row.id !== editingId && row.code.toLowerCase() === form.code.trim().toLowerCase()) ? 'الكود مستخدم لعميل آخر' : '',
    name: form.name.trim().length < 2 ? 'اسم العميل حرفين على الأقل' : '',
  };
  const debitCount = summary.debitCount;
  const activeCount = summary.activeCount;
  const totalDue = summary.totalDue;

  function openCreate() {
    setEditingId(null);
    setForm(emptyCustomer);
    setOpen(true);
  }

  function openEdit(row: Customer) {
    setEditingId(row.id);
    setForm({
      code: row.code,
      name: row.name,
      phone: row.phone || '',
      address: row.address || '',
      priceList: row.priceList || 'RETAIL',
      isActive: row.isActive !== false,
      warehouseIds: (row.warehouses || []).map((row) => row.warehouseId),
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
        priceList: form.priceList,
        warehouseIds: form.warehouseIds,
        ...(editingId ? { isActive: form.isActive } : {}),
      };
      await api(editingId ? `/customers/${editingId}` : '/customers', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      feedback.success(editingId ? 'تم تعديل العميل' : 'تم إضافة العميل');
      setOpen(false);
      await load();
    } catch (error) {
      feedback.error(error instanceof Error ? error.message : 'تعذر حفظ العميل');
    } finally {
      setSaving(false);
    }
  }

  async function exportRows() {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (listView === 'debit') params.set('balance', 'debit');
    const rows = await api<Customer[]>(`/customers${params.toString() ? `?${params}` : ''}`);
    const ExcelJS = await loadExcel();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('العملاء');
    sheet.addRow(['الكود', 'الاسم', 'الهاتف', 'العنوان', 'الرصيد', 'الحالة']);
    rows.forEach((row) => sheet.addRow([row.code, row.name, row.phone || '', row.address || '', row.balance, row.isActive === false ? 'موقوف' : 'نشط']));
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer]));
    link.download = 'customers.xlsx';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function showStatement(id: string) {
    const data = await api<{ customer: Customer; statement: StatementRow[]; balance: number }>(`/customers/${id}/statement`);
    setStatement(data);
    setStmtOpen(true);
  }

  async function bulk(isActive: boolean) {
    const result = await api<{ updated: number }>('/customers/bulk', { method: 'POST', body: JSON.stringify({ ids: selected, isActive }) });
    feedback.success(`تم تحديث ${result.updated} عميل`);
    setSelected([]);
    await load();
  }

  async function saveView() {
    const name = await feedback.prompt({ title: 'حفظ العرض', message: 'اسم يظهر لك عند فتح العملاء', defaultValue: listView === 'debit' ? 'عليهم رصيد' : 'عرض العملاء' });
    if (!name) return;
    const row = await api<{ id: string; name: string; query: string }>('/work/views', {
      method: 'POST',
      body: JSON.stringify({ module: 'customers', name, query: JSON.stringify({ search, listView }) }),
    });
    setViews((list) => [row, ...list]);
  }

  function applyView(query: string) {
    const parsed = JSON.parse(query) as { search?: string; listView?: 'all' | 'debit' | 'limit' };
    setSearch(parsed.search || '');
    setListView(parsed.listView === 'debit' ? 'debit' : 'all');
  }

  return (
    <div>
      <PageHeader
        title="العملاء"
        subtitle="بيانات العملاء وكشوف الحساب"
        actions={
          <>
            <Button onClick={openCreate}><Plus size={16} /> عميل جديد</Button>
            {selected.length > 0 && (
              <>
                <Button variant="secondary" onClick={() => bulk(false)}>إيقاف المحدد</Button>
                <Button variant="secondary" onClick={() => bulk(true)}>تنشيط المحدد</Button>
              </>
            )}
            <Button variant="secondary" onClick={saveView}>حفظ العرض</Button>
          </>
        }
      />

      <StatGrid>
        <StatCard label="إجمالي العملاء" value={items.length} hint={`${activeCount} نشط · ${items.length - activeCount} موقوف`} icon={Users} tone="brand" active={listView === 'all'} onClick={() => setListView('all')} />
        <StatCard label="إجمالي المستحقات" value={formatMoney(totalDue)} hint="مبالغ مستحقة على العملاء" icon={Wallet} tone="emerald" />
        <StatCard label="عليهم رصيد" value={debitCount} hint="اضغط لعرضهم فقط" icon={CircleDollarSign} tone="amber" active={listView === 'debit'} onClick={() => setListView('debit')} />
      </StatGrid>

      <Card>
        <ListBar
          search={search}
          onSearch={setSearch}
          placeholder="بحث بالكود أو الاسم أو الهاتف"
          view={view}
          onView={(mode) => { setView(mode); localStorage.setItem(CUSTOMER_VIEW, mode); }}
          onExport={exportRows}
          columns={customerColumns.columns}
          onToggleColumn={customerColumns.toggle}
          filterActive={listView !== 'all'}
          filter={(
            <div className="space-y-1">
              <div className="mb-2 text-xs font-bold text-muted">تصفية العملاء</div>
              {([['all', 'الكل'], ['debit', 'عليهم رصيد']] as const).map(([key, label]) => (
                <FilterOption key={key} active={listView === key} onClick={() => setListView(key)}>{label}</FilterOption>
              ))}
            </div>
          )}
        />
        {views.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {views.map((saved) => (
              <Button key={saved.id} variant="ghost" onClick={() => applyView(saved.query)}>{saved.name}</Button>
            ))}
          </div>
        )}
        {items.length === 0 ? <Empty text="لا يوجد عملاء مطابقون" hint="غيّر البحث أو التصفية" /> : view === 'cards' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((row) => (
                <div key={row.id} className="lift rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 text-sm font-extrabold text-white">{row.name.trim()[0]}</span>
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
                      {customerBalance(row)}
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
                  {customerColumns.visible('balance') && <Th>الرصيد</Th>}
                  {customerColumns.visible('phone') && <Th>الهاتف</Th>}
                  {customerColumns.visible('address') && <Th>العنوان</Th>}
                  {customerColumns.visible('name') && <Th>الاسم</Th>}
                  {customerColumns.visible('code') && <Th>الكود</Th>}
                  <Th></Th>
                  <Th>الإجراءات</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className={row.balance > 0 ? 'row-debit' : row.balance < 0 ? 'row-credit' : ''}>
                    {customerColumns.visible('balance') && <Td>{customerBalance(row)}</Td>}
                    {customerColumns.visible('phone') && <Td><bdi dir="ltr" className="font-medium text-slate-600">{row.phone || '—'}</bdi></Td>}
                    {customerColumns.visible('address') && <Td className="max-w-xs truncate text-muted">{row.address || '—'}</Td>}
                    {customerColumns.visible('name') && (
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-xs font-extrabold text-brand-700">{row.name.trim()[0]}</span>
                          <div className="min-w-0">
                            <div className="truncate font-bold text-slate-800">{row.name}</div>
                            <div className="text-[11px] text-muted">{row.priceList === 'WHOLESALE' ? 'عميل جملة' : 'عميل قطاعي'}</div>
                          </div>
                          {row.isActive === false && <Badge tone="slate">موقوف</Badge>}
                        </div>
                      </Td>
                    )}
                    {customerColumns.visible('code') && <Td><span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-700" dir="ltr">{row.code}</span></Td>}
                    <Td><input type="checkbox" checked={selected.includes(row.id)} onChange={() => setSelected((ids) => ids.includes(row.id) ? ids.filter((id) => id !== row.id) : [...ids, row.id])} /></Td>
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

      <Modal open={open} onClose={() => setOpen(false)} title={editingId ? 'تعديل عميل' : 'عميل جديد'}>
        <div className="space-y-3">
          <Field label="كود العميل" icon={<Hash size={16} />} error={formErrors.code}>
            <Input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
          </Field>
          <Field label="اسم العميل" icon={<Users size={16} />} error={formErrors.name}>
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="رقم الهاتف" icon={<Phone size={16} />} warning={form.phone && items.some((row) => row.id !== editingId && row.phone === form.phone.trim()) ? 'في عميل بنفس رقم الهاتف' : undefined}>
            <Input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </Field>
          <Field label="العنوان" icon={<MapPin size={16} />}>
            <Input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} />
          </Field>
          <Field label="قائمة السعر">
            <Select value={form.priceList} onChange={(event) => setForm({ ...form, priceList: event.target.value })}>
              <option value="RETAIL">قطاعي</option>
              <option value="WHOLESALE">جملة</option>
            </Select>
          </Field>
          <div>
            <Label>
              <span className="inline-flex items-center gap-1.5"><Warehouse size={15} className="text-slate-400" /> المخازن</span>
            </Label>
            <WarehouseMultiSelect
              warehouses={warehouses}
              value={form.warehouseIds}
              onChange={(warehouseIds) => setForm({ ...form, warehouseIds })}
              hint="العميل يظهر ليوزر المخازن دي فقط. لو مفيش اختيار يظهر للكل"
            />
          </div>
          {editingId && (
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
              العميل نشط
            </label>
          )}
          <Button className="w-full" disabled={saving || !!formErrors.code || !!formErrors.name} onClick={save}>{editingId ? 'حفظ التعديلات' : 'حفظ العميل'}</Button>
        </div>
      </Modal>

      <Modal open={stmtOpen} onClose={() => setStmtOpen(false)} title={`كشف حساب — ${statement?.customer.name || ''}`} wide>
        {statement && (
          <div>
            <PrintHeader title={`كشف حساب عميل: ${statement.customer.name}`} subtitle={`الرصيد الحالي: ${formatMoney(statement.balance)}`} />
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-muted">إجمالي المدين</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-slate-900">{formatMoney(statement.statement.reduce((s, r) => s + r.debit, 0))}</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-muted">إجمالي الدائن</div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-slate-900">{formatMoney(statement.statement.reduce((s, r) => s + r.credit, 0))}</div>
              </div>
              <div className={`rounded-xl p-3 text-white ${statement.balance > 0 ? 'bg-gradient-to-br from-brand-700 to-brand-900' : 'bg-gradient-to-br from-emerald-600 to-emerald-800'}`}>
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
                {statement.statement.map((r, i) => (
                  <tr key={i} className={r.debit > 0 ? 'row-debit' : r.credit > 0 ? 'row-credit' : ''}>
                    <Td className="whitespace-nowrap text-slate-600">{formatDate(r.date)}</Td>
                    <Td className="font-semibold">{r.type}</Td>
                    <Td>
                      {r.kind && r.id ? (
                        <button
                          type="button"
                          className="font-mono text-xs font-bold text-brand-700 underline-offset-2 hover:underline"
                          dir="ltr"
                          onClick={() => setLedgerDetail({ kind: r.kind!, id: r.id!, title: `${r.type} · ${r.ref}` })}
                        >
                          {r.ref}
                        </button>
                      ) : (
                        <span className="font-mono text-xs font-bold text-brand-700" dir="ltr">{r.ref}</span>
                      )}
                    </Td>
                    <Td className="text-muted">{r.method || '—'}</Td>
                    <Td className="font-semibold text-emerald-700">{r.debit ? formatMoney(r.debit) : '—'}</Td>
                    <Td className="font-semibold text-rose-700">{r.credit ? formatMoney(r.credit) : '—'}</Td>
                    <Td className="font-extrabold text-slate-900">{formatMoney(r.balance)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <NotesPanel entityType="customer" entityId={statement.customer.id} />
            <EntityWorkspace entityType="customer" entityId={statement.customer.id} />
          </div>
        )}
      </Modal>

      <LedgerDetailModal
        open={!!ledgerDetail}
        onClose={() => setLedgerDetail(null)}
        party="customer"
        kind={ledgerDetail?.kind}
        id={ledgerDetail?.id}
        title={ledgerDetail?.title}
      />
    </div>
  );
}
