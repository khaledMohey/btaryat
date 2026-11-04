import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

function describe(method: string, path: string) {
  const rules: [string, string, string][] = [
    ['POST', '/work/reports', 'حفظ أو تشغيل تقرير'],
    ['DELETE', '/work/reports', 'حذف تقرير محفوظ'],
    ['POST', '/work/tasks', 'حفظ مهمة'],
    ['PATCH', '/work/tasks', 'تحديث مهمة'],
    ['DELETE', '/work/tasks', 'حذف مهمة'],
    ['POST', '/work/automation', 'تشغيل أو حفظ أتمتة'],
    ['PATCH', '/work/automation', 'تعديل قاعدة أتمتة'],
    ['DELETE', '/work/automation', 'حذف قاعدة أتمتة'],
    ['POST', '/work/attachments', 'رفع مرفق'],
    ['DELETE', '/work/attachments', 'حذف مرفق'],
    ['POST', '/work/views', 'حفظ عرض'],
    ['POST', '/customers/bulk', 'تحديث جماعي للعملاء'],
    ['POST', '/products/import', 'استيراد أصناف'],
    ['POST', '/org', 'حفظ عنصر في الهيكل'],
    ['PATCH', '/org', 'تعديل عنصر في الهيكل'],
    ['DELETE', '/org', 'حذف عنصر من الهيكل'],
    ['POST', '/notes', 'إضافة ملاحظة'],
    ['POST', '/sales', 'إنشاء فاتورة مبيعات'],
    ['PATCH', '/sales', 'تعديل فاتورة مبيعات'],
    ['DELETE', '/sales', 'حذف فاتورة مبيعات'],
    ['POST', '/purchases', 'إنشاء فاتورة مشتريات'],
    ['PATCH', '/purchases', 'تعديل فاتورة مشتريات'],
    ['DELETE', '/purchases', 'حذف فاتورة مشتريات'],
    ['POST', '/products', 'حفظ صنف أو حقل'],
    ['PATCH', '/products', 'تعديل صنف'],
    ['DELETE', '/products', 'حذف صنف أو حقل'],
    ['POST', '/customers', 'حفظ عميل'],
    ['PATCH', '/customers', 'تعديل عميل'],
    ['POST', '/suppliers', 'حفظ مورد'],
    ['PATCH', '/suppliers', 'تعديل مورد'],
    ['POST', '/stock', 'حركة مخزون'],
    ['PATCH', '/stock', 'تعديل حركة مخزون'],
    ['DELETE', '/stock', 'حذف حركة مخزون'],
    ['POST', '/cash', 'حركة خزنة'],
    ['POST', '/returns', 'تسجيل مرتجع'],
    ['POST', '/finance', 'عملية مالية'],
    ['POST', '/users', 'إضافة مستخدم'],
    ['PATCH', '/users', 'تعديل مستخدم'],
    ['POST', '/settings', 'تغيير الإعدادات'],
    ['POST', '/warehouses', 'إضافة مخزن'],
    ['PATCH', '/warehouses', 'تعديل مخزن'],
    ['DELETE', '/warehouses', 'حذف مخزن'],
    ['POST', '/auth/login', 'تسجيل دخول'],
  ];
  const match = rules.find(([verb, part]) => method === verb && path.includes(part));
  return match?.[2] || `${method} ${path}`;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method: string;
      originalUrl?: string;
      url?: string;
      body?: { username?: string };
      user?: { userId?: string; username?: string };
    }>();
    const method = req.method;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next.handle();
    const path = (req.originalUrl || req.url || '').split('?')[0];
    if (path.includes('/ops/notifications')) return next.handle();

    return next.handle().pipe(
      tap({
        next: () => this.write(req, path, method, 'success'),
        error: () => this.write(req, path, method, 'failed'),
      }),
    );
  }

  private write(
    req: { body?: { username?: string }; user?: { userId?: string; username?: string } },
    path: string,
    method: string,
    status: string,
  ) {
    const userId = req.user?.userId;
    const fallback = path.includes('/auth/login') ? req.body?.username : req.user?.username;
    const save = (userName?: string | null) => {
      this.prisma.auditLog.create({
        data: {
          userId,
          userName: userName || fallback || 'النظام',
          action: describe(method, path),
          method,
          path,
          status,
        },
      }).catch(() => undefined);
    };
    if (!userId) {
      save(fallback);
      return;
    }
    this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } })
      .then((user) => save(user?.fullName))
      .catch(() => save(fallback));
  }
}
