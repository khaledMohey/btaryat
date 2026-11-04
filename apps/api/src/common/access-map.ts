export type PageId =
  | 'dashboard'
  | 'warehouses'
  | 'products'
  | 'stock'
  | 'suppliers'
  | 'customers'
  | 'sales'
  | 'purchases'
  | 'returns'
  | 'cash'
  | 'finance'
  | 'reports'
  | 'reportBuilder'
  | 'analytics'
  | 'insights'
  | 'audit'
  | 'settings';

export type PageGrant = {
  view: boolean;
  actions: string[];
  fields: string[];
};

export type AccessMap = Record<PageId, PageGrant>;

type Choice = { id: string; label: string };

export type PageDef = {
  id: PageId;
  label: string;
  group: string;
  actions: Choice[];
  fields: Choice[];
};

export const PAGES: PageDef[] = [
  {
    id: 'dashboard',
    label: 'لوحة التحكم',
    group: 'نظرة عامة',
    actions: [],
    fields: [
      { id: 'profit', label: 'الربح' },
      { id: 'cash', label: 'الخزنة' },
      { id: 'balances', label: 'الأرصدة' },
    ],
  },
  {
    id: 'warehouses',
    label: 'المخازن',
    group: 'المخزون',
    actions: [
      { id: 'create', label: 'إضافة' },
      { id: 'edit', label: 'تعديل' },
      { id: 'delete', label: 'حذف' },
    ],
    fields: [],
  },
  {
    id: 'products',
    label: 'الأصناف',
    group: 'المخزون',
    actions: [
      { id: 'create', label: 'إضافة' },
      { id: 'edit', label: 'تعديل' },
      { id: 'delete', label: 'حذف' },
      { id: 'import', label: 'استيراد' },
      { id: 'export', label: 'تصدير' },
    ],
    fields: [
      { id: 'cost', label: 'التكلفة' },
      { id: 'sellPrice', label: 'سعر البيع' },
    ],
  },
  {
    id: 'stock',
    label: 'المخزون',
    group: 'المخزون',
    actions: [
      { id: 'adjust', label: 'تسوية' },
      { id: 'transfer', label: 'تحويل' },
      { id: 'export', label: 'تصدير' },
    ],
    fields: [
      { id: 'cost', label: 'التكلفة' },
      { id: 'qty', label: 'الكميات' },
    ],
  },
  {
    id: 'suppliers',
    label: 'الموردين',
    group: 'الأطراف',
    actions: [
      { id: 'create', label: 'إضافة' },
      { id: 'edit', label: 'تعديل' },
      { id: 'delete', label: 'حذف' },
      { id: 'export', label: 'تصدير' },
    ],
    fields: [{ id: 'balance', label: 'الرصيد' }],
  },
  {
    id: 'customers',
    label: 'العملاء',
    group: 'الأطراف',
    actions: [
      { id: 'create', label: 'إضافة' },
      { id: 'edit', label: 'تعديل' },
      { id: 'delete', label: 'حذف' },
      { id: 'export', label: 'تصدير' },
    ],
    fields: [{ id: 'balance', label: 'الرصيد' }],
  },
  {
    id: 'sales',
    label: 'المبيعات',
    group: 'العمليات',
    actions: [
      { id: 'create', label: 'إضافة' },
      { id: 'edit', label: 'تعديل' },
      { id: 'delete', label: 'حذف' },
      { id: 'confirm', label: 'تأكيد' },
      { id: 'export', label: 'تصدير' },
    ],
    fields: [
      { id: 'cost', label: 'التكلفة' },
      { id: 'profit', label: 'الربح' },
      { id: 'paid', label: 'المدفوع' },
    ],
  },
  {
    id: 'purchases',
    label: 'المشتريات',
    group: 'العمليات',
    actions: [
      { id: 'create', label: 'إضافة' },
      { id: 'edit', label: 'تعديل' },
      { id: 'delete', label: 'حذف' },
      { id: 'confirm', label: 'تأكيد' },
      { id: 'export', label: 'تصدير' },
    ],
    fields: [
      { id: 'cost', label: 'التكلفة' },
      { id: 'paid', label: 'المدفوع' },
    ],
  },
  {
    id: 'returns',
    label: 'المرتجعات',
    group: 'العمليات',
    actions: [
      { id: 'create', label: 'إضافة' },
      { id: 'edit', label: 'تعديل' },
      { id: 'delete', label: 'حذف' },
    ],
    fields: [{ id: 'cost', label: 'التكلفة' }],
  },
  {
    id: 'cash',
    label: 'الخزنة',
    group: 'العمليات',
    actions: [
      { id: 'create', label: 'حركة' },
      { id: 'receipt', label: 'تحصيل' },
      { id: 'payment', label: 'سداد' },
    ],
    fields: [{ id: 'balance', label: 'الأرصدة' }],
  },
  {
    id: 'finance',
    label: 'المالية',
    group: 'المالية',
    actions: [
      { id: 'create', label: 'إضافة' },
      { id: 'edit', label: 'تعديل' },
      { id: 'delete', label: 'حذف' },
    ],
    fields: [{ id: 'amounts', label: 'المبالغ' }],
  },
  {
    id: 'reports',
    label: 'التقارير',
    group: 'المالية',
    actions: [{ id: 'export', label: 'تصدير' }],
    fields: [
      { id: 'profit', label: 'الربح' },
      { id: 'cost', label: 'التكلفة' },
      { id: 'balances', label: 'الأرصدة' },
    ],
  },
  {
    id: 'reportBuilder',
    label: 'منشئ التقارير',
    group: 'المالية',
    actions: [{ id: 'export', label: 'تصدير' }],
    fields: [],
  },
  {
    id: 'analytics',
    label: 'التحليلات',
    group: 'المالية',
    actions: [{ id: 'export', label: 'تصدير' }],
    fields: [{ id: 'profit', label: 'الربح' }],
  },
  {
    id: 'insights',
    label: 'التنبيهات الذكية',
    group: 'المالية',
    actions: [],
    fields: [],
  },
  {
    id: 'audit',
    label: 'سجل العمليات',
    group: 'النظام',
    actions: [],
    fields: [],
  },
  {
    id: 'settings',
    label: 'الإعدادات',
    group: 'النظام',
    actions: [
      { id: 'users', label: 'المستخدمين' },
      { id: 'backup', label: 'النسخ الاحتياطي' },
      { id: 'periods', label: 'الفترات' },
      { id: 'company', label: 'بيانات الشركة' },
    ],
    fields: [],
  },
];

const FIELD_KEYS: Record<string, string[]> = {
  cost: ['costPrice', 'unitCost', 'totalCost'],
  profit: ['profit', 'netProfit', 'grossProfit', 'margin', 'cogs', 'monthProfit'],
  cash: ['cashBalance'],
  balances: ['balance'],
  balance: ['balance'],
  paid: ['paidAmount'],
  sellPrice: ['salePrice', 'wholesalePrice'],
  qty: ['quantity'],
  amounts: ['amount'],
};

export function emptyGrant(): PageGrant {
  return { view: false, actions: [], fields: [] };
}

export function fullAccess(): AccessMap {
  const map = {} as AccessMap;
  for (const page of PAGES) {
    map[page.id] = {
      view: true,
      actions: page.actions.map((action) => action.id),
      fields: page.fields.map((field) => field.id),
    };
  }
  return map;
}

function grant(view: boolean, actions: string[], fields: string[]): PageGrant {
  return { view, actions: view ? actions : [], fields: view ? fields : [] };
}

export function templateFor(role: string): AccessMap {
  if (role === 'ADMIN') return fullAccess();
  const all = fullAccess();
  const off = emptyGrant();
  if (role === 'ACCOUNTANT') {
    return {
      ...all,
      audit: off,
      settings: off,
    };
  }
  if (role === 'SALES') {
    return {
      ...all,
      dashboard: grant(true, [], []),
      warehouses: off,
      products: grant(true, ['export'], ['sellPrice']),
      stock: grant(true, [], ['qty']),
      suppliers: off,
      customers: grant(true, ['create', 'edit', 'export'], ['balance']),
      sales: grant(true, ['create', 'edit', 'delete', 'confirm', 'export'], ['paid']),
      purchases: off,
      returns: grant(true, ['create', 'edit', 'delete'], []),
      cash: grant(true, ['receipt'], []),
      finance: off,
      reports: off,
      reportBuilder: off,
      analytics: off,
      insights: grant(true, [], []),
      audit: off,
      settings: off,
    };
  }
  return {
    ...all,
    dashboard: grant(true, [], []),
    warehouses: grant(true, ['create', 'edit'], []),
    products: grant(true, ['create', 'edit', 'import', 'export'], ['cost', 'sellPrice']),
    stock: grant(true, ['adjust', 'transfer', 'export'], ['cost', 'qty']),
    suppliers: grant(true, ['create', 'edit', 'export'], ['balance']),
    customers: off,
    sales: off,
    purchases: grant(true, ['create', 'edit', 'delete', 'confirm', 'export'], ['cost', 'paid']),
      returns: grant(true, ['create', 'edit', 'delete'], ['cost']),
      cash: off,
    finance: off,
    reports: off,
    reportBuilder: off,
    analytics: off,
    insights: grant(true, [], []),
    audit: off,
    settings: off,
  };
}

export function normalizeAccess(raw: unknown, role: string): AccessMap {
  const base = templateFor(role);
  if (!raw || typeof raw !== 'object') return base;
  const source = raw as Record<string, Partial<PageGrant>>;
  const map = {} as AccessMap;
  for (const page of PAGES) {
    const item = source[page.id];
    if (!item || typeof item !== 'object') {
      map[page.id] = base[page.id];
      continue;
    }
    const view = !!item.view;
    const allowedActions = new Set(page.actions.map((action) => action.id));
    const allowedFields = new Set(page.fields.map((field) => field.id));
    map[page.id] = {
      view,
      actions: view ? (item.actions || []).filter((id) => allowedActions.has(id)) : [],
      fields: view ? (item.fields || []).filter((id) => allowedFields.has(id)) : [],
    };
  }
  if (role === 'ADMIN') {
    map.settings = {
      view: true,
      actions: Array.from(new Set([...map.settings.actions, 'users'])),
      fields: map.settings.fields,
    };
  }
  return map;
}

export function parseAccess(raw: string | null | undefined, role: string): AccessMap {
  if (!raw) return templateFor(role);
  try {
    return normalizeAccess(JSON.parse(raw), role);
  } catch {
    return templateFor(role);
  }
}

export function canDo(access: AccessMap, page: PageId, action: string) {
  const grant = access[page];
  if (!grant?.view) return false;
  if (action === 'view') return true;
  return grant.actions.includes(action);
}

export function hiddenResponseKeys(access: AccessMap, page: PageId) {
  const def = PAGES.find((item) => item.id === page);
  const grant = access[page];
  if (!def || !grant?.view) return [];
  const keys = new Set<string>();
  for (const field of def.fields) {
    if (grant.fields.includes(field.id)) continue;
    for (const key of FIELD_KEYS[field.id] || []) keys.add(key);
  }
  return [...keys];
}

export function stripHidden<T>(value: T, keys: string[]): T {
  if (!keys.length) return value;
  const hidden = new Set(keys);
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (!input || typeof input !== 'object' || input instanceof Date) return input;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (hidden.has(key)) continue;
      out[key] = walk(item);
    }
    return out;
  };
  return walk(value) as T;
}
