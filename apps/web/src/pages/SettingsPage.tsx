import { useEffect, useState } from 'react';
import { Building2, DatabaseBackup, Download, FileArchive, Lock, Monitor, Save, Server, ShieldCheck, UserPlus, Users, Warehouse } from 'lucide-react';
import { api, getApiBase, setApiBase, setSettingsToken } from '../lib/api';
import { ROLE_LABELS } from '../lib/nav';
import { useAuth } from '../lib/auth';
import { useConfirm, useToast } from '../lib/feedback';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { UserAccess } from '../components/UserAccess';
import { WarehouseMultiSelect } from '../components/WarehouseMultiSelect';
import type { AccessMap } from '@m5azen/shared';
import { Badge, Button, Card, CardHeader, Empty, Input, Label, PageHeader, Select, Table, Td, Th, type Tone } from '../components/ui';

const ROLE_TONE: Record<string, Tone> = { ADMIN: 'brand', ACCOUNTANT: 'violet', WAREHOUSE: 'amber', SALES: 'emerald' };

type PeriodRow = { year: number; month: number; label: string; closed: boolean; closedAt: string | null; closedBy: string };
type PeriodLog = { id: string; label: string; action: 'CLOSE' | 'REOPEN'; reason: string; userName: string; createdAt: string };
type SettingsUser = {
  id: string;
  username: string;
  fullName: string;
  role: string;
  isActive: boolean;
  permissions: string | null;
  warehouseLinks?: { warehouseId: string; warehouse?: { id: string; name: string } }[];
};

export function SettingsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = user?.role === 'ADMIN';
  const [companyName, setCompanyName] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  const [commercialRegister, setCommercialRegister] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');
  const [apiUrl, setApiUrl] = useState(getApiBase());
  const [users, setUsers] = useState<SettingsUser[]>([]);
  const [accessUser, setAccessUser] = useState<string | null>(null);
  const [warehousesUser, setWarehousesUser] = useState<string | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [userForm, setUserForm] = useState({ username: '', password: '', fullName: '', role: 'SALES', warehouseIds: [] as string[] });
  const [editWarehouseIds, setEditWarehouseIds] = useState<string[]>([]);
  const [backups, setBackups] = useState<string[]>([]);
  const [editingLook, setEditingLook] = useState(false);
  const [busy, setBusy] = useState<'' | 'settings' | 'backup' | 'user' | 'password' | 'edit' | 'period' | 'desktop'>('');
  const [gate, setGate] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ current: '', next: '', confirm: '' });
  const [editPassword, setEditPassword] = useState({ next: '', confirm: '' });
  const [desktopPassword, setDesktopPassword] = useState('');
  const [periods, setPeriods] = useState<PeriodRow[]>([]);
  const [periodLog, setPeriodLog] = useState<PeriodLog[]>([]);
  const [reopenKey, setReopenKey] = useState('');
  const [reopenReason, setReopenReason] = useState('');

  useEffect(() => {
    if (!unlocked) return;
    api<Record<string, string>>('/settings').then((s) => {
      setCompanyName(s.companyName || '');
      setTaxNumber(s.taxNumber || '');
      setCommercialRegister(s.commercialRegister || '');
      setCompanyAddress(s.companyAddress || '');
    }).catch(() => undefined);
    if (isAdmin) {
      api<SettingsUser[]>('/users').then(setUsers).catch(() => setUsers([]));
      api<{ id: string; name: string }[]>('/warehouses').then(setWarehouses).catch(() => setWarehouses([]));
      api<{ periods: PeriodRow[]; log: PeriodLog[] }>('/settings/periods').then((res) => {
        setPeriods(res.periods);
        setPeriodLog(res.log);
      }).catch(() => undefined);
    }
    api<string[]>('/settings/backups').then(setBackups).catch(() => setBackups([]));
  }, [user?.role, unlocked]);

  async function unlockSettings() {
    setBusy('settings');
    try {
      const res = await api<{ token: string }>('/settings/unlock', {
        method: 'POST',
        body: JSON.stringify({ password: gate }),
      });
      setSettingsToken(res.token);
      setGate('');
      setUnlocked(true);
    } catch (e) {
      setSettingsToken('');
      toast.error(e instanceof Error ? e.message : 'تعذر فتح الإعدادات');
    } finally {
      setBusy('');
    }
  }

  async function changeOwnPassword() {
    if (passwordForm.next.length < 4) {
      toast.error('كلمة السر الجديدة 4 أحرف على الأقل');
      return;
    }
    if (passwordForm.next !== passwordForm.confirm) {
      toast.error('تأكيد كلمة السر غير مطابق');
      return;
    }
    setBusy('password');
    try {
      await api('/users/me/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: passwordForm.current, newPassword: passwordForm.next }),
      });
      setPasswordForm({ current: '', next: '', confirm: '' });
      toast.success('تم تغيير كلمة سر الدخول');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر تغيير كلمة السر');
    } finally {
      setBusy('');
    }
  }

  async function saveEditPassword() {
    if (editPassword.next.length < 4) {
      toast.error('كلمة سر التعديل 4 أحرف على الأقل');
      return;
    }
    if (editPassword.next !== editPassword.confirm) {
      toast.error('تأكيد كلمة السر غير مطابق');
      return;
    }
    setBusy('edit');
    try {
      await api('/settings/edit-password', {
        method: 'POST',
        body: JSON.stringify({ password: editPassword.next }),
      });
      setEditPassword({ next: '', confirm: '' });
      toast.success('تم حفظ كلمة سر التعديل');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر حفظ كلمة سر التعديل');
    } finally {
      setBusy('');
    }
  }

  async function closePeriod(row: PeriodRow) {
    const ok = await confirm({
      title: `قفل ${row.label}`,
      message: 'فواتير ومصروفات ومخزون الشهر ده هتقف لحد ما يتفتح تاني بسبب.',
      confirmLabel: 'قفل الشهر',
      danger: true,
    });
    if (!ok) return;
    setBusy('period');
    try {
      const res = await api<{ periods: PeriodRow[]; log: PeriodLog[] }>('/settings/periods/close', {
        method: 'POST',
        body: JSON.stringify({ year: row.year, month: row.month }),
      });
      setPeriods(res.periods);
      setPeriodLog(res.log);
      toast.success(`تم قفل ${row.label}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر قفل الشهر');
    } finally {
      setBusy('');
    }
  }

  async function reopenPeriod(row: PeriodRow) {
    if (reopenReason.trim().length < 3) {
      toast.error('اكتب سبب فتح الشهر');
      return;
    }
    setBusy('period');
    try {
      const res = await api<{ periods: PeriodRow[]; log: PeriodLog[] }>('/settings/periods/reopen', {
        method: 'POST',
        body: JSON.stringify({ year: row.year, month: row.month, reason: reopenReason.trim() }),
      });
      setPeriods(res.periods);
      setPeriodLog(res.log);
      setReopenKey('');
      setReopenReason('');
      toast.success(`تم فتح ${row.label}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر فتح الشهر');
    } finally {
      setBusy('');
    }
  }

  async function saveSettings() {
    setApiBase(apiUrl);
    if (!isAdmin) {
      toast.success('تم حفظ عنوان السيرفر على هذا الجهاز');
      return;
    }
    setBusy('settings');
    try {
      await api('/settings', {
        method: 'POST',
        body: JSON.stringify({ data: { companyName, apiUrl, taxNumber, commercialRegister, companyAddress } }),
      });
      toast.success('تم حفظ الإعدادات');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر حفظ الإعدادات');
    } finally {
      setBusy('');
    }
  }

  async function backup() {
    setBusy('backup');
    try {
      const res = await api<{ ok: boolean; fileName?: string; snapshot?: unknown; message?: string }>('/settings/backup', { method: 'POST' });
      if (res.ok && res.snapshot && res.fileName) {
        const blob = new Blob([JSON.stringify(res.snapshot)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = res.fileName;
        link.click();
        URL.revokeObjectURL(link.href);
        toast.success(`تم تنزيل النسخة: ${res.fileName}`);
        setBackups(await api<string[]>('/settings/backups'));
      } else {
        toast.error(res.message || 'فشل النسخ');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'فشل النسخ');
    } finally {
      setBusy('');
    }
  }

  async function downloadDesktop() {
    if (!desktopPassword.trim()) {
      toast.error('اكتب كلمة سر التحميل');
      return;
    }
    setBusy('desktop');
    try {
      const res = await api<{ mode: 'url' | 'token'; url?: string; token?: string; fileName?: string }>('/settings/desktop-download', {
        method: 'POST',
        body: JSON.stringify({ password: desktopPassword }),
      });
      setDesktopPassword('');
      if (res.mode === 'url' && res.url) {
        const link = document.createElement('a');
        link.href = res.url;
        link.rel = 'noopener';
        link.download = res.fileName || 'm5azen-desktop-setup.exe';
        link.target = '_blank';
        link.click();
        toast.success('بدأ تحميل نسخة الديسكتوب');
        return;
      }
      if (res.mode !== 'token' || !res.token) {
        throw new Error('نسخة الديسكتوب غير متاحة حالياً');
      }
      const blob = await api<Blob>(`/settings/desktop-download/file?token=${encodeURIComponent(res.token)}`);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = res.fileName || 'm5azen-desktop-setup.exe';
      link.click();
      URL.revokeObjectURL(link.href);
      toast.success('بدأ تحميل نسخة الديسكتوب');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر التحميل');
    } finally {
      setBusy('');
    }
  }

  async function addUser() {
    if (!userForm.username.trim() || !userForm.password || !userForm.fullName.trim()) {
      toast.error('أدخل اسم الدخول والاسم وكلمة السر');
      return;
    }
    setBusy('user');
    try {
      const created = await api<{ id: string }>('/users', {
        method: 'POST',
        body: JSON.stringify({
          username: userForm.username,
          password: userForm.password,
          fullName: userForm.fullName,
          role: userForm.role,
        }),
      });
      if (userForm.warehouseIds.length) {
        await api(`/users/${created.id}/warehouses`, { method: 'PUT', body: JSON.stringify({ warehouseIds: userForm.warehouseIds }) });
      }
      setUserForm({ username: '', password: '', fullName: '', role: 'SALES', warehouseIds: [] });
      setUsers(await api('/users'));
      toast.success('تمت إضافة المستخدم');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر إضافة المستخدم');
    } finally {
      setBusy('');
    }
  }

  async function saveUserWarehouses(userId: string) {
    setBusy('user');
    try {
      await api(`/users/${userId}/warehouses`, { method: 'PUT', body: JSON.stringify({ warehouseIds: editWarehouseIds }) });
      setUsers(await api('/users'));
      toast.success('تم حفظ مخازن المستخدم');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذر حفظ المخازن');
    } finally {
      setBusy('');
    }
  }

  return (
    <div>
      {!editingLook && <PageHeader title="الإعدادات" subtitle="إعدادات واجهة النظام والمظهر العام، وبيانات الشركة والنسخ الاحتياطي" />}
      {!unlocked ? (
        <Card>
          <CardHeader title="كلمة سر الإعدادات" subtitle="الصفحة مقفولة لحد ما تتأكد كلمة السر من السيرفر" icon={ShieldCheck} />
          <form className="max-w-sm space-y-3" onSubmit={(e) => { e.preventDefault(); unlockSettings(); }}>
            <div>
              <Label>كلمة السر</Label>
              <Input type="password" value={gate} onChange={(e) => setGate(e.target.value)} autoComplete="off" dir="ltr" />
            </div>
            <Button type="submit" disabled={busy === 'settings' || !gate}>فتح الإعدادات</Button>
          </form>
        </Card>
      ) : (
      <>
      <AppearanceSettings onEditing={setEditingLook} />
      {editingLook ? null : (<>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="بيانات الشركة" subtitle="تظهر في رأس الفواتير والتقارير المطبوعة" icon={Building2} />
          <div className="space-y-3">
            <div>
              <Label>اسم الشركة</Label>
              <Input value={companyName} readOnly={!isAdmin} onChange={(e) => setCompanyName(e.target.value)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>الرقم الضريبي</Label>
                <Input value={taxNumber} readOnly={!isAdmin} onChange={(e) => setTaxNumber(e.target.value)} dir="ltr" />
              </div>
              <div>
                <Label>السجل التجاري</Label>
                <Input value={commercialRegister} readOnly={!isAdmin} onChange={(e) => setCommercialRegister(e.target.value)} dir="ltr" />
              </div>
            </div>
            <div>
              <Label>عنوان الفاتورة</Label>
              <Input value={companyAddress} readOnly={!isAdmin} onChange={(e) => setCompanyAddress(e.target.value)} />
            </div>
            <div className="rounded-xl border border-dashed border-slate-200 p-3">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-slate-700"><Server size={15} className="text-brand-600" /> عنوان الـ API المحلي</div>
              <Input
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="اتركه فارغاً لاستخدام نفس السيرفر"
                dir="ltr"
              />
              <p className="mt-1.5 text-xs text-muted">
                اتركه فارغاً عند الفتح من رابط البرنامج. للديسكتوب فقط: ضع IP جهاز السيرفر
              </p>
            </div>
            <Button onClick={saveSettings} disabled={busy === 'settings'}><Save size={16} /> {isAdmin ? 'حفظ الإعدادات' : 'حفظ عنوان السيرفر'}</Button>
          </div>
        </Card>

        {isAdmin && (
          <Card>
            <CardHeader title="النسخ الاحتياطي" subtitle="تنزيل ملف JSON بكل البيانات، أو استرجاعه بعد التأكيد" icon={DatabaseBackup} />
            <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-gradient-to-l from-amber-50 to-white p-4 ring-1 ring-amber-100">
              <div className="text-sm">
                <div className="font-bold text-slate-800">{backups.length} نسخة محفوظة</div>
                <div className="text-xs text-muted">{backups[0] ? `آخر نسخة: ${backups[0]}` : 'لم يتم إنشاء نسخ بعد'}</div>
              </div>
              <div className="flex gap-2">
              <Button onClick={backup} disabled={busy === 'backup'}><DatabaseBackup size={16} /> تنزيل نسخة</Button>
              <label className="inline-flex h-10 cursor-pointer items-center rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-700">
                استرجاع
                <input type="file" accept="application/json,.json" className="hidden" onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  const ok = await confirm({ title: 'استرجاع النسخة', message: 'الاسترجاع يستبدل البيانات الحالية بالنسخة المختارة.', confirmLabel: 'استرجاع', danger: true });
                  if (!ok) return;
                  setBusy('backup');
                  try {
                    await api('/settings/restore', { method: 'POST', body: await file.text() });
                    toast.success('تم استرجاع النسخة');
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'تعذر الاسترجاع');
                  } finally {
                    setBusy('');
                  }
                }} />
              </label>
            </div>
            </div>
            {backups.length === 0 ? <Empty text="لا توجد نسخ بعد" /> : (
              <ul className="max-h-72 space-y-1.5 overflow-y-auto">
                {backups.map((b) => (
                  <li key={b} className="flex items-center gap-2 rounded-lg border border-slate-100 px-3 py-2">
                    <FileArchive size={15} className="shrink-0 text-amber-600" />
                    <span className="truncate font-mono text-xs text-slate-600" dir="ltr">{b}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {isAdmin && (
        <Card className="mt-4">
          <CardHeader title="نسخة الديسكتوب أوفلاين" subtitle="تنزيل Setup يشتغل لوحده بـ SQLite من غير ما يعتمد على الويب" icon={Monitor} />
          <form className="flex max-w-xl flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); downloadDesktop(); }}>
            <div className="min-w-56 flex-1">
              <Label>كلمة سر التحميل</Label>
              <Input
                type="password"
                value={desktopPassword}
                onChange={(e) => setDesktopPassword(e.target.value)}
                autoComplete="off"
                dir="ltr"
                placeholder="••••••••"
              />
            </div>
            <Button type="submit" disabled={busy === 'desktop' || !desktopPassword}>
              <Download size={16} /> تنزيل نسخة الديسكتوب
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted">التحقق من السيرفر فقط — كلمة السر مش موجودة في الفرونت.</p>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader title="كلمة سر الدخول" subtitle="تغيير كلمة السر اللي بتدخل بيها للنظام" icon={ShieldCheck} />
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); changeOwnPassword(); }}>
          <div>
            <Label>كلمة السر الحالية</Label>
            <Input type="password" value={passwordForm.current} onChange={(e) => setPasswordForm({ ...passwordForm, current: e.target.value })} autoComplete="current-password" dir="ltr" />
          </div>
          <div>
            <Label>كلمة السر الجديدة</Label>
            <Input type="password" value={passwordForm.next} onChange={(e) => setPasswordForm({ ...passwordForm, next: e.target.value })} autoComplete="new-password" dir="ltr" />
          </div>
          <div>
            <Label>تأكيد كلمة السر</Label>
            <Input type="password" value={passwordForm.confirm} onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })} autoComplete="new-password" dir="ltr" />
          </div>
          <Button type="submit" disabled={busy === 'password'}>حفظ كلمة السر</Button>
        </form>
      </Card>

      {isAdmin && (
        <Card className="mt-4">
          <CardHeader title="كلمة سر التعديل" subtitle="أي تعديل أو حذف في النظام يطلبها. لحد ما تحفظها التعديل يفضل مفتوح" icon={ShieldCheck} />
          <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); saveEditPassword(); }}>
            <div>
              <Label>كلمة السر</Label>
              <Input type="password" value={editPassword.next} onChange={(e) => setEditPassword({ ...editPassword, next: e.target.value })} autoComplete="new-password" dir="ltr" />
            </div>
            <div>
              <Label>تأكيد كلمة السر</Label>
              <Input type="password" value={editPassword.confirm} onChange={(e) => setEditPassword({ ...editPassword, confirm: e.target.value })} autoComplete="new-password" dir="ltr" />
            </div>
            <Button type="submit" disabled={busy === 'edit'}>حفظ كلمة سر التعديل</Button>
          </form>
        </Card>
      )}

      {isAdmin && (
        <Card className="mt-4">
          <CardHeader title="الفترات المحاسبية" subtitle="قفل شهر بيمنع تعديل مستنداته. الفتح يتسجل بالسبب" icon={Lock} />
          {periods.length === 0 ? <Empty text="لا توجد فترات" /> : (
            <ul className="max-h-96 space-y-2 overflow-y-auto">
              {periods.map((row) => {
                const key = `${row.year}-${row.month}`;
                return (
                  <li key={key} className="rounded-xl border border-slate-100 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-bold text-slate-800">{row.label}</div>
                        <div className="text-xs text-slate-500">
                          {row.closed ? `مقفول${row.closedBy ? ` بواسطة ${row.closedBy}` : ''}` : 'مفتوح'}
                        </div>
                      </div>
                      {row.closed ? (
                        <Button type="button" variant="secondary" disabled={busy === 'period'} onClick={() => { setReopenKey(key); setReopenReason(''); }}>فتح</Button>
                      ) : (
                        <Button type="button" variant="danger" disabled={busy === 'period'} onClick={() => closePeriod(row)}>قفل</Button>
                      )}
                    </div>
                    {row.closed && reopenKey === key && (
                      <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); reopenPeriod(row); }}>
                        <div className="min-w-56 flex-1">
                          <Label>سبب الفتح</Label>
                          <Input value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
                        </div>
                        <Button type="submit" disabled={busy === 'period'}>تأكيد الفتح</Button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {periodLog.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 text-sm font-bold text-slate-700">سجل القفل والفتح</div>
              <ul className="max-h-48 space-y-1.5 overflow-y-auto text-sm">
                {periodLog.map((row) => (
                  <li key={row.id} className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">
                    <span className="font-bold text-slate-800">{row.action === 'CLOSE' ? 'قفل' : 'فتح'} {row.label}</span>
                    {' — '}{row.userName}
                    {row.reason ? ` — ${row.reason}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {isAdmin && (
        <Card className="mt-4">
          <CardHeader title="المستخدمين وصلاحية المخزن" subtitle={`${users.length} مستخدم`} icon={Users} />
          <form
            className="mb-5 rounded-xl border border-slate-200 bg-slate-50/60 p-4"
            onSubmit={(e) => { e.preventDefault(); addUser(); }}
          >
            <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-slate-700"><UserPlus size={15} className="text-brand-600" /> مستخدم جديد</div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div><Label>اسم الدخول</Label><Input value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} dir="ltr" autoComplete="off" /></div>
              <div><Label>الاسم</Label><Input value={userForm.fullName} onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })} /></div>
              <div><Label>كلمة السر</Label><Input type="password" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} autoComplete="new-password" /></div>
              <div>
                <Label>الدور</Label>
                <Select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}>
                  <option value="ADMIN">مدير</option>
                  <option value="ACCOUNTANT">حسابات</option>
                  <option value="WAREHOUSE">مخزن</option>
                  <option value="SALES">مبيعات</option>
                </Select>
              </div>
            </div>
            <div className="mt-3">
              <Label>المخازن المسموحة</Label>
              <WarehouseMultiSelect
                warehouses={warehouses}
                value={userForm.warehouseIds}
                onChange={(warehouseIds) => setUserForm({ ...userForm, warehouseIds })}
                hint="من غير اختيار = يشوف كل المخازن. مع اختيار = يدخل على مخازنه فقط (فواتير وأصناف وعملاء)"
              />
            </div>
            <Button type="submit" className="mt-3" disabled={busy === 'user'}><UserPlus size={16} /> إضافة المستخدم</Button>
          </form>
          {users.length === 0 ? <Empty text="لا يوجد مستخدمون" /> : (
            <Table>
              <thead><tr><Th>المستخدم</Th><Th>اسم الدخول</Th><Th>الدور</Th><Th>المخازن</Th><Th>الحالة</Th><Th></Th></tr></thead>
              <tbody>
                {users.map((u) => {
                  const links = u.warehouseLinks || [];
                  const warehouseLabel = u.role === 'ADMIN' || !links.length
                    ? 'كل المخازن'
                    : links.map((link) => link.warehouse?.name || link.warehouseId).join(' · ');
                  return (
                  <tr key={u.id}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-800 text-sm font-extrabold text-white">{u.fullName.slice(0, 1)}</span>
                        <span className="font-bold text-slate-900">{u.fullName}</span>
                      </div>
                    </Td>
                    <Td><span className="font-mono text-xs text-slate-600" dir="ltr">{u.username}</span></Td>
                    <Td><Badge tone={ROLE_TONE[u.role] || 'slate'}>{ROLE_LABELS[u.role] || u.role}</Badge></Td>
                    <Td><span className="text-xs text-slate-600">{warehouseLabel}</span></Td>
                    <Td><Badge tone={u.isActive ? 'emerald' : 'rose'}>{u.isActive ? 'نشط' : 'موقوف'}</Badge></Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const open = warehousesUser !== u.id;
                            setWarehousesUser(open ? u.id : null);
                            setEditWarehouseIds(open ? (u.warehouseLinks || []).map((link) => link.warehouseId) : []);
                          }}
                        >
                          <Warehouse size={14} /> مخازن
                        </Button>
                        <Button type="button" variant="secondary" onClick={() => setAccessUser(accessUser === u.id ? null : u.id)}>صلاحيات</Button>
                      </div>
                      {warehousesUser === u.id && u.role !== 'ADMIN' && (
                        <div className="mt-3 max-w-xl rounded-xl border border-slate-200 bg-slate-50/80 p-3">
                          <WarehouseMultiSelect
                            warehouses={warehouses}
                            value={editWarehouseIds}
                            onChange={setEditWarehouseIds}
                            hint="من غير اختيار = كل المخازن"
                          />
                          <Button type="button" className="mt-2" disabled={busy === 'user'} onClick={() => saveUserWarehouses(u.id)}>
                            <Save size={14} /> حفظ المخازن
                          </Button>
                        </div>
                      )}
                      {accessUser === u.id && (
                        <UserAccess
                          role={u.role}
                          value={u.permissions}
                          busy={busy === 'user'}
                          onSave={async (access: AccessMap) => {
                            setBusy('user');
                            try {
                              await api(`/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ permissions: access }) });
                              setUsers(await api('/users'));
                              toast.success('تم حفظ الصلاحيات');
                            } catch (error) {
                              toast.error(error instanceof Error ? error.message : 'تعذر حفظ الصلاحيات');
                            } finally {
                              setBusy('');
                            }
                          }}
                        />
                      )}
                    </Td>
                  </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          <p className="mt-3 flex items-start gap-1.5 text-xs text-muted">
            <ShieldCheck size={14} className="mt-0.5 shrink-0" />
            ربط المستخدم بمخزن يقيّد الفواتير والأصناف والمخزون والعملاء والموردين. صلاحيات الصفحات منفصلة من زر الصلاحيات.
          </p>
        </Card>
      )}
      </>)}
      </>
      )}
    </div>
  );
}
