import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('admin123', 10);

  await prisma.user.upsert({
    where: { username: 'admin' },
    create: {
      username: 'admin',
      passwordHash,
      fullName: 'مدير النظام',
      role: Role.ADMIN,
    },
    update: {},
  });

  await prisma.setting.upsert({
    where: { key: 'companyName' },
    create: { key: 'companyName', value: 'نظام AK Tech لإدارة المخازن' },
    update: {},
  });

  const warehouse = await prisma.warehouse.upsert({
    where: { code: 'WH01' },
    create: {
      code: 'WH01',
      name: 'المخزن الرئيسي',
      location: 'القاهرة',
      description: 'المخزن الافتراضي',
    },
    update: {},
  });

  await prisma.warehouse.upsert({
    where: { code: 'RETURNS' },
    create: {
      code: 'RETURNS',
      name: 'مخزن المرتجعات',
      description: 'مخزن ثابت لاستلام مرتجعات البيع',
    },
    update: { name: 'مخزن المرتجعات', isActive: true },
  });

  // احذف حقول قديمة مش مستخدمة في نظام البطاريات
  await prisma.productCustomField.deleteMany({
    where: { name: { in: ['brand', 'color', 'size'] } },
  });

  await prisma.cashAccount.upsert({
    where: { code: 'CASH01' },
    create: { code: 'CASH01', name: 'الخزنة الرئيسية', balance: 10000 },
    update: {},
  });

  await prisma.supplier.upsert({
    where: { code: 'SUP01' },
    create: { code: 'SUP01', name: 'مورد تجريبي', phone: '01000000000' },
    update: {},
  });

  await prisma.customer.upsert({
    where: { code: 'CUS01' },
    create: { code: 'CUS01', name: 'عميل تجريبي', phone: '01100000000' },
    update: {},
  });

  await prisma.customer.upsert({
    where: { code: 'WALKIN' },
    create: { code: 'WALKIN', name: 'عميل سريع', notes: 'عميل نقدي يشتري مرة ويمشي' },
    update: {},
  });

  const product = await prisma.product.upsert({
    where: { sku: 'P001' },
    create: {
      sku: 'P001',
      name: 'صنف تجريبي',
      unit: 'قطعة',
      costPrice: 50,
      salePrice: 80,
      minStock: 10,
    },
    update: {},
  });

  await prisma.stockBalance.upsert({
    where: {
      warehouseId_productId: {
        warehouseId: warehouse.id,
        productId: product.id,
      },
    },
    create: {
      warehouseId: warehouse.id,
      productId: product.id,
      quantity: 100,
    },
    update: {},
  });

  console.log('Seed completed. Login: admin / admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
