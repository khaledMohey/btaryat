import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FieldType } from '@prisma/client';
import { existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { pageResult, readPage } from '../common/paging';
import { rowsFromProductFile } from './product-file';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  listFields() {
    return this.prisma.productCustomField.findMany({
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  createField(data: {
    name: string;
    label: string;
    fieldType?: FieldType;
    options?: string;
    isRequired?: boolean;
    sortOrder?: number;
  }) {
    return this.prisma.productCustomField.create({
      data: {
        name: data.name,
        label: data.label,
        fieldType: data.fieldType || FieldType.TEXT,
        options: data.options,
        isRequired: data.isRequired ?? false,
        sortOrder: data.sortOrder ?? 0,
      },
    });
  }

  updateField(
    id: string,
    data: Partial<{
      label: string;
      fieldType: FieldType;
      options: string;
      isRequired: boolean;
      sortOrder: number;
    }>,
  ) {
    return this.prisma.productCustomField.update({ where: { id }, data });
  }

  async deleteField(id: string) {
    await this.prisma.productFieldValue.deleteMany({ where: { fieldId: id } });
    return this.prisma.productCustomField.delete({ where: { id } });
  }

  private productInclude() {
    return {
      category: true,
      fieldValues: { include: { field: true } },
      stockBalances: { include: { warehouse: true } },
      warehouses: { include: { warehouse: true } },
    };
  }

  private warehouseScope(warehouseId?: string, warehouseIds?: string[] | null) {
    const ids = warehouseId ? [warehouseId] : warehouseIds || undefined;
    if (!ids?.length) return undefined;
    return {
      OR: [
        { warehouses: { none: {} } },
        { warehouses: { some: { warehouseId: { in: ids } } } },
      ],
    };
  }

  private async syncWarehouses(productId: string, warehouseIds?: string[]) {
    if (warehouseIds === undefined) return;
    const unique = [...new Set(warehouseIds.map((id) => id.trim()).filter(Boolean))];
    await this.prisma.productWarehouse.deleteMany({ where: { productId } });
    if (unique.length) {
      await this.prisma.productWarehouse.createMany({
        data: unique.map((warehouseId) => ({ productId, warehouseId })),
      });
    }
  }

  async findAll(query?: {
    search?: string;
    page?: string;
    pageSize?: string;
    filter?: string;
    warehouseId?: string;
    warehouseIds?: string[] | null;
  }) {
    const page = readPage(query);
    const searchWhere = query?.search
      ? {
          OR: [
            { name: { contains: query.search } },
            { sku: { contains: query.search } },
            { barcode: { contains: query.search } },
            { brand: { contains: query.search } },
            { batterySize: { contains: query.search } },
          ],
        }
      : undefined;
    const warehouseWhere = this.warehouseScope(query?.warehouseId, query?.warehouseIds);
    const where = searchWhere && warehouseWhere
      ? { AND: [searchWhere, warehouseWhere] }
      : searchWhere || warehouseWhere;
    const include = this.productInclude();
    if (!page && (!query?.filter || query.filter === 'all')) return this.prisma.product.findMany({ where, include, orderBy: { name: 'asc' } });
    const light = await this.prisma.product.findMany({
      where,
      select: { id: true, minStock: true, barcode: true, brand: true, unit: true, costPrice: true, salePrice: true, stockBalances: { select: { quantity: true } } },
      orderBy: { name: 'asc' },
    });
    const summary = { total: light.length, low: 0, noBarcode: 0, loss: 0, stockValue: 0, units: 0, brands: [] as string[], unitNames: [] as string[] };
    const brandSet = new Set<string>();
    const unitSet = new Set<string>();
    const matched: typeof light = [];
    for (const row of light) {
      const qty = row.stockBalances.reduce((sum, item) => sum + item.quantity, 0);
      const low = row.minStock > 0 && qty <= row.minStock;
      const noBarcode = !row.barcode;
      const loss = row.costPrice > 0 && row.salePrice < row.costPrice;
      if (low) summary.low += 1;
      if (noBarcode) summary.noBarcode += 1;
      if (loss) summary.loss += 1;
      summary.stockValue += row.costPrice * qty;
      summary.units += qty;
      if (row.brand) brandSet.add(row.brand);
      if (row.unit) unitSet.add(row.unit);
      const keep = query?.filter === 'low' ? low : query?.filter === 'barcode' ? noBarcode : query?.filter === 'loss' ? loss : true;
      if (keep) matched.push(row);
    }
    summary.brands = [...brandSet];
    summary.unitNames = [...unitSet];
    if (!page) {
      const allItems = matched.length
        ? await this.prisma.product.findMany({ where: { id: { in: matched.map((row) => row.id) } }, include, orderBy: { name: 'asc' } })
        : [];
      return allItems;
    }
    const slice = matched.slice(page.skip, page.skip + page.take);
    const items = slice.length
      ? await this.prisma.product.findMany({ where: { id: { in: slice.map((row) => row.id) } }, include })
      : [];
    const order = new Map(slice.map((row, index) => [row.id, index]));
    items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return pageResult(items, matched.length, page, { summary });
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: this.productInclude(),
    });
    if (!product) throw new NotFoundException('الصنف غير موجود');
    return product;
  }

  async nextSku() {
    const products = await this.prisma.product.findMany({ select: { sku: true } });
    let max = 0;
    for (const product of products) {
      const match = product.sku.match(/(\d+)\s*$/);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `SKU-${String(max + 1).padStart(4, '0')}`;
  }

  async create(data: {
    sku?: string;
    name: string;
    unit?: string;
    costPrice?: number;
    salePrice?: number;
    minStock?: number;
    description?: string;
    barcode?: string | null;
    brand?: string | null;
    batterySize?: string | null;
    categoryId?: string | null;
    wholesalePrice?: number;
    packUnit?: string | null;
    packSize?: number;
    fieldValues?: { fieldId: string; value: string }[];
    warehouseIds?: string[];
  }) {
    const { fieldValues, warehouseIds, sku: rawSku, ...rest } = data;
    const sku = rawSku?.trim() || (await this.nextSku());
    rest.barcode = rest.barcode?.trim() || null;
    rest.brand = rest.brand?.trim() || null;
    rest.batterySize = rest.batterySize?.trim() || null;
    rest.categoryId = rest.categoryId || null;
    rest.packUnit = rest.packUnit?.trim() || null;
    const cleaned = (fieldValues || []).filter((fv) => fv.value?.trim());
    const uniqueWarehouses = [...new Set((warehouseIds || []).map((id) => id.trim()).filter(Boolean))];
    return this.prisma.product.create({
      data: {
        ...rest,
        sku,
        fieldValues: cleaned.length ? { create: cleaned } : undefined,
        warehouses: uniqueWarehouses.length
          ? { create: uniqueWarehouses.map((warehouseId) => ({ warehouseId })) }
          : undefined,
      },
      include: this.productInclude(),
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    const [
      salesLines,
      purchaseLines,
      salesReturnLines,
      purchaseReturnLines,
      stockMovements,
      transferLines,
      documentLines,
      replacementReturns,
      oldBatteries,
      stockedOldBatteries,
      replacementOldBatteries,
      stockQty,
    ] = await Promise.all([
      this.prisma.salesInvoiceLine.count({ where: { productId: id } }),
      this.prisma.purchaseInvoiceLine.count({ where: { productId: id } }),
      this.prisma.salesReturnLine.count({ where: { productId: id } }),
      this.prisma.purchaseReturnLine.count({ where: { productId: id } }),
      this.prisma.stockMovement.count({ where: { productId: id } }),
      this.prisma.stockTransferLine.count({ where: { productId: id } }),
      this.prisma.tradeDocumentLine.count({ where: { productId: id } }),
      this.prisma.salesReturn.count({ where: { replacementProductId: id } }),
      this.prisma.oldBattery.count({ where: { productId: id } }),
      this.prisma.oldBattery.count({ where: { stockProductId: id } }),
      this.prisma.oldBattery.count({ where: { replacementProductId: id } }),
      this.prisma.stockBalance.aggregate({ where: { productId: id }, _sum: { quantity: true } }),
    ]);

    const reasons: string[] = [];
    if (salesLines) reasons.push('فواتير بيع');
    if (purchaseLines) reasons.push('فواتير شراء');
    if (salesReturnLines || replacementReturns) reasons.push('مرتجعات بيع');
    if (purchaseReturnLines) reasons.push('مرتجعات شراء');
    if (stockMovements) reasons.push('حركات مخزون');
    if (transferLines) reasons.push('تحويلات مخزن');
    if (documentLines) reasons.push('مستندات تجارية');
    if (oldBatteries || stockedOldBatteries || replacementOldBatteries) reasons.push('بطاريات مستعملة');
    if ((stockQty._sum.quantity || 0) !== 0) reasons.push('رصيد مخزون');

    if (reasons.length) {
      throw new BadRequestException(`لا يمكن حذف الصنف لوجود معاملات عليه: ${reasons.join('، ')}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productFieldValue.deleteMany({ where: { productId: id } });
      await tx.productWarehouse.deleteMany({ where: { productId: id } });
      await tx.customerPrice.deleteMany({ where: { productId: id } });
      await tx.productLocation.deleteMany({ where: { productId: id } });
      await tx.stockBalance.deleteMany({ where: { productId: id } });
      await tx.fileBlob.deleteMany({ where: { key: { startsWith: `products/${id}.` } } });
      await tx.product.delete({ where: { id } });
    });

    for (const ext of ['.png', '.jpg', '.webp', '.gif']) {
      const previous = join(this.imageDir(), `${id}${ext}`);
      if (existsSync(previous)) unlinkSync(previous);
    }

    return { ok: true };
  }

  async update(
    id: string,
    data: {
      sku?: string;
      name?: string;
      unit?: string;
      salePrice?: number;
      minStock?: number;
      description?: string;
      isActive?: boolean;
      barcode?: string | null;
      brand?: string | null;
      batterySize?: string | null;
      categoryId?: string | null;
      wholesalePrice?: number;
      packUnit?: string | null;
      packSize?: number;
      fieldValues?: { fieldId: string; value: string }[];
      warehouseIds?: string[];
    },
  ) {
    const { fieldValues, warehouseIds, ...rest } = data;
    if (rest.barcode !== undefined) rest.barcode = rest.barcode?.trim() || null;
    if (rest.brand !== undefined) rest.brand = rest.brand?.trim() || null;
    if (rest.batterySize !== undefined) rest.batterySize = rest.batterySize?.trim() || null;
    if (rest.categoryId !== undefined) rest.categoryId = rest.categoryId || null;
    if (rest.packUnit !== undefined) rest.packUnit = rest.packUnit?.trim() || null;
    if (fieldValues) {
      await this.prisma.productFieldValue.deleteMany({ where: { productId: id } });
      const cleaned = fieldValues.filter((fv) => fv.value?.trim());
      if (cleaned.length) {
        await this.prisma.productFieldValue.createMany({
          data: cleaned.map((fv) => ({ ...fv, productId: id })),
        });
      }
    }
    await this.syncWarehouses(id, warehouseIds);
    return this.prisma.product.update({
      where: { id },
      data: rest,
      include: this.productInclude(),
    });
  }

  listCategories() {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { products: true } } } });
  }

  createCategory(name: string) {
    return this.prisma.category.create({ data: { name: name.trim() } });
  }

  deleteCategory(id: string) {
    return this.prisma.category.delete({ where: { id } });
  }

  async importRows(rows: { sku?: string; name?: string; unit?: string; salePrice?: number; minStock?: number; barcode?: string }[]) {
    const errors: { row: number; message: string }[] = [];
    let created = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const sku = row.sku?.trim() || '';
      const name = row.name?.trim() || '';
      if (!sku || !name) {
        errors.push({ row: index + 1, message: 'الكود والاسم مطلوبان' });
        continue;
      }
      const exists = await this.prisma.product.findUnique({ where: { sku } });
      if (exists) {
        errors.push({ row: index + 1, message: `الكود ${sku} موجود مسبقًا` });
        continue;
      }
      try {
        await this.create({
          sku,
          name,
          unit: row.unit?.trim() || 'قطعة',
          salePrice: Number(row.salePrice) || 0,
          minStock: Number(row.minStock) || 0,
          barcode: row.barcode?.trim() || null,
        });
        created += 1;
      } catch {
        errors.push({ row: index + 1, message: `تعذر حفظ ${sku}` });
      }
    }
    return { created, failed: errors.length, errors };
  }

  async importFile(buffer: Buffer, filename: string) {
    const rows = await rowsFromProductFile(buffer, filename);
    return this.importRows(rows);
  }

  private imageDir() {
    return join(process.cwd(), 'uploads', 'products');
  }

  async saveImage(id: string, file: { buffer: Buffer; mimetype: string }) {
    const types: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
    };
    const ext = types[file.mimetype];
    if (!ext) throw new BadRequestException('الصورة لازم تكون png أو jpg أو webp');
    await this.findOne(id);
    for (const old of ['.png', '.jpg', '.webp', '.gif']) {
      const previous = join(this.imageDir(), `${id}${old}`);
      if (existsSync(previous)) unlinkSync(previous);
    }
    await this.prisma.fileBlob.deleteMany({ where: { key: { startsWith: `products/${id}.` } } });
    const imageFile = `${id}${ext}`;
    await this.prisma.fileBlob.create({ data: { key: `products/${imageFile}`, mimeType: file.mimetype, data: new Uint8Array(file.buffer) } });
    return this.prisma.product.update({ where: { id }, data: { imageFile } });
  }

  async image(id: string): Promise<{ data: Buffer; mimeType: string } | { path: string }> {
    const product = await this.findOne(id);
    if (!product.imageFile) throw new NotFoundException('لا توجد صورة');
    const blob = await this.prisma.fileBlob.findUnique({ where: { key: `products/${product.imageFile}` } });
    if (blob) return { data: Buffer.from(blob.data), mimeType: blob.mimeType };
    const path = resolve(this.imageDir(), product.imageFile);
    if (!path.startsWith(resolve(this.imageDir())) || !existsSync(path)) throw new NotFoundException('لا توجد صورة');
    return { path };
  }

  async findByBarcode(code: string) {
    const product = await this.prisma.product.findFirst({
      where: { OR: [{ barcode: code }, { sku: code }] },
      include: { category: true, customerPrices: true },
    });
    if (!product) throw new NotFoundException('لا يوجد صنف بهذا الباركود');
    return product;
  }
}
