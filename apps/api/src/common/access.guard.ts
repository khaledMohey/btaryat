import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { canDo, hiddenResponseKeys, parseAccess, type PageId } from './access-map';
import { IS_PUBLIC_KEY } from './guards';
import { PrismaService } from '../prisma/prisma.service';

const RULES = [
  { prefix: '/api/ops/audit', page: 'audit' },
  { prefix: '/api/ops/insights', page: 'insights' },
  { prefix: '/api/ops/overview', page: 'analytics' },
  { prefix: '/api/ops/search', page: 'dashboard' },
  { prefix: '/api/ops/notifications', page: 'dashboard' },
  { prefix: '/api/ops/activity', page: 'audit' },
  { prefix: '/api/sales', page: 'sales' },
  { prefix: '/api/purchases', page: 'purchases' },
  { prefix: '/api/products', page: 'products' },
  { prefix: '/api/stock', page: 'stock' },
  { prefix: '/api/warehouses', page: 'warehouses' },
  { prefix: '/api/customers', page: 'customers' },
  { prefix: '/api/suppliers', page: 'suppliers' },
  { prefix: '/api/cash', page: 'cash' },
  { prefix: '/api/finance', page: 'finance' },
  { prefix: '/api/returns', page: 'returns' },
  { prefix: '/api/reports', page: 'reports' },
  { prefix: '/api/dashboard', page: 'dashboard' },
  { prefix: '/api/settings', page: 'settings' },
  { prefix: '/api/users', page: 'settings' },
] as const;

const SKIP = [
  /^\/api\/auth(?:\/|$)/,
  /^\/api\/health(?:\/|$)/,
  /^\/api\/users\/me(?:\/|$)/,
  /^\/api\/settings\/unlock$/,
  /^\/api\/settings\/edit-unlock$/,
];

export function requestPath(req: { originalUrl?: string; url?: string }) {
  const raw = (req.originalUrl || req.url || '').split('?')[0];
  if (raw.startsWith('/api')) return raw.replace(/\/$/, '') || '/api';
  return `/api${raw.startsWith('/') ? raw : `/${raw}`}`.replace(/\/$/, '');
}

export function pageForPath(path: string) {
  return RULES.find((rule) => path === rule.prefix || path.startsWith(`${rule.prefix}/`))?.page || null;
}

export function actionFor(method: string, path: string, page: PageId) {
  const verb = method.toUpperCase();
  if (/\/backup|\/restore|\/backups/.test(path)) return 'backup';
  if (verb === 'GET' || verb === 'HEAD') return /export|xlsx/i.test(path) ? 'export' : 'view';
  if (/\/confirm$/.test(path)) return 'confirm';
  if (page === 'cash' && /\/receipts$/.test(path)) return 'receipt';
  if (page === 'cash' && /\/payments$/.test(path)) return 'payment';
  if (/import/.test(path)) return 'import';
  if (/\/adjust/.test(path)) return 'adjust';
  if (/\/transfers/.test(path)) return 'transfer';
  if (/\/periods\/(?:close|reopen)/.test(path)) return 'periods';
  if (/\/edit-password$/.test(path)) return 'company';
  if (page === 'settings' && path.startsWith('/api/users')) return 'users';
  if (page === 'settings' && path === '/api/settings') return 'company';
  if (page === 'stock' && /\/movements|\/batches|\/locations|\/product-locations/.test(path)) return 'adjust';
  if (/\/image$/.test(path)) return 'edit';
  if (verb === 'PATCH' || verb === 'PUT') return 'edit';
  if (verb === 'DELETE') return 'delete';
  return 'create';
}

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest();
    if (isPublic || !req.user) return true;
    const path = requestPath(req);
    if (SKIP.some((rule) => rule.test(path))) return true;
    const page = pageForPath(path);
    if (!page) return true;
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true, permissions: true, isActive: true },
    });
    if (!user?.isActive) throw new ForbiddenException('ليس لديك صلاحية');
    const access = parseAccess(user.permissions, user.role);
    const action = actionFor(req.method, path, page);
    // قراءة قائمة المخازن لازمة لاختيار المخزن في البيع/المخزون/المرتجات… من غير فتح صفحة إدارة المخازن.
    if (
      page === 'warehouses'
      && req.method.toUpperCase() === 'GET'
      && (path === '/api/warehouses' || /^\/api\/warehouses\/[^/]+$/.test(path))
      && !canDo(access, 'warehouses', 'view')
    ) {
      const neededBy = [
        'sales', 'purchases', 'stock', 'returns', 'products', 'reports', 'customers', 'suppliers',
      ] as const;
      if (neededBy.some((id) => canDo(access, id, 'view'))) {
        req.accessChecked = true;
        req.accessPage = page;
        req.accessKeys = [] as string[];
        return true;
      }
    }
    if (!canDo(access, page, action)) throw new ForbiddenException('ليس لديك صلاحية');
    req.accessChecked = true;
    req.accessPage = page;
    req.accessKeys = hiddenResponseKeys(access, page);
    return true;
  }
}
