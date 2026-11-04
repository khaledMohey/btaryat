import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Boxes,
  FileBarChart,
  Landmark,
  LayoutDashboard,
  LineChart,
  Package,
  ScrollText,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Truck,
  Undo2,
  Users,
  Wallet,
  Warehouse,
} from 'lucide-react';

export type AppRole = 'ADMIN' | 'ACCOUNTANT' | 'WAREHOUSE' | 'SALES';

export type NavItem = {
  to: string;
  label: string;
  page: string;
  icon: LucideIcon;
  end?: boolean;
  keywords: string;
  roles?: AppRole[];
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'مدير النظام',
  ACCOUNTANT: 'محاسب',
  WAREHOUSE: 'أمين مخزن',
  SALES: 'مبيعات',
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'نظرة عامة',
    items: [
      { to: '/', label: 'لوحة التحكم', page: 'dashboard', icon: LayoutDashboard, end: true, keywords: 'dashboard رئيسية' },
    ],
  },
  {
    label: 'المخزون',
    items: [
      { to: '/warehouses', label: 'المخازن', page: 'warehouses', icon: Warehouse, keywords: 'مخزن warehouse' },
      { to: '/products', label: 'الأصناف', page: 'products', icon: Package, keywords: 'صنف منتج product استيراد import' },
      { to: '/stock', label: 'المخزون', page: 'stock', icon: Boxes, keywords: 'رصيد حركة stock' },
    ],
  },
  {
    label: 'الأطراف',
    items: [
      { to: '/suppliers', label: 'الموردين', page: 'suppliers', icon: Truck, keywords: 'مورد supplier' },
      { to: '/customers', label: 'العملاء', page: 'customers', icon: Users, keywords: 'عميل customer' },
    ],
  },
  {
    label: 'العمليات',
    items: [
      { to: '/sales', label: 'المبيعات', page: 'sales', icon: ShoppingCart, keywords: 'فاتورة بيع sales' },
      { to: '/purchases', label: 'المشتريات', page: 'purchases', icon: ShoppingBag, keywords: 'فاتورة شراء purchase' },
      { to: '/returns', label: 'المرتجعات', page: 'returns', icon: Undo2, keywords: 'مرتجع return' },
      { to: '/cash', label: 'الخزنة', page: 'cash', icon: Wallet, keywords: 'نقدي خزنة cash' },
    ],
  },
  {
    label: 'المالية',
    items: [
      { to: '/finance', label: 'المالية', page: 'finance', icon: Landmark, keywords: 'مصروف شيك وردية' },
      { to: '/reports', label: 'التقارير', page: 'reports', icon: BarChart3, keywords: 'تقرير report' },
      { to: '/report-builder', label: 'منشئ التقارير', page: 'reportBuilder', icon: FileBarChart, keywords: 'report builder حفظ تصدير' },
      { to: '/analytics', label: 'التحليلات', page: 'analytics', icon: LineChart, keywords: 'تحليل analytics نمو' },
      { to: '/insights', label: 'التنبيهات الذكية', page: 'insights', icon: Sparkles, keywords: 'تنبيه صلاحية نقص' },
    ],
  },
  {
    label: 'النظام',
    items: [
      { to: '/audit', label: 'سجل العمليات', page: 'audit', icon: ScrollText, keywords: 'audit سجل', roles: ['ADMIN'] },
      { to: '/settings', label: 'الإعدادات', page: 'settings', icon: Settings, keywords: 'إعداد مستخدم نسخ' },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export function canAccess(role: string | undefined, roles?: AppRole[]) {
  if (!roles?.length) return true;
  if (role === 'ADMIN') return true;
  return !!role && roles.includes(role as AppRole);
}

export const QUICK_ACTIONS: { to: string; label: string; page: string; roles?: AppRole[] }[] = [
  { to: '/sales', label: 'فاتورة مبيعات', page: 'sales', roles: ['ADMIN', 'SALES', 'ACCOUNTANT'] },
  { to: '/purchases', label: 'فاتورة مشتريات', page: 'purchases', roles: ['ADMIN', 'ACCOUNTANT', 'WAREHOUSE'] },
  { to: '/products', label: 'الأصناف', page: 'products' },
  { to: '/stock', label: 'المخزون', page: 'stock' },
  { to: '/cash', label: 'حركة خزنة', page: 'cash', roles: ['ADMIN', 'ACCOUNTANT'] },
  { to: '/reports', label: 'التقارير', page: 'reports' },
  { to: '/report-builder', label: 'منشئ التقارير', page: 'reportBuilder' },
];
