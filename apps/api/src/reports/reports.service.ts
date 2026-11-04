import { Injectable } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildJournal, oldBatteriesReport } from './journal';
async function loadExcel() {
  return import('exceljs');
}

function sliceInvoiceCost(lines: { productId: string; quantity: number; unitCost: number }[], productId: string) {
  const rows = lines.filter((line) => line.productId === productId && line.quantity > 0);
  const quantity = rows.reduce((sum, line) => sum + line.quantity, 0);
  if (quantity <= 0) return null;
  return Math.round(rows.reduce((sum, line) => sum + line.quantity * (line.unitCost || 0), 0) / quantity * 10000) / 10000;
}

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async inventory(warehouseIds?: string[]) {
    return this.prisma.stockBalance.findMany({
      where: warehouseIds?.length ? { warehouseId: { in: warehouseIds } } : undefined,
      include: { product: true, warehouse: true },
      orderBy: { product: { name: 'asc' } },
    });
  }

  async salesSummary(from?: string, to?: string, warehouseIds?: string[]) {
    const invoiceDate = this.dayRange(from, to);
    const where = {
      status: { not: 'CANCELLED' as const },
      ...(warehouseIds?.length ? { warehouseId: { in: warehouseIds } } : {}),
      ...(invoiceDate ? { invoiceDate } : {}),
    };
    const invoices = await this.prisma.salesInvoice.findMany({
      where,
      include: { customer: true, warehouse: true },
      orderBy: { invoiceDate: 'desc' },
    });
    const total = invoices.reduce((s, i) => s + i.total, 0);
    const paid = invoices.reduce((s, i) => s + i.paidAmount, 0);
    return { invoices, total, paid, count: invoices.length };
  }

  async purchasesSummary(from?: string, to?: string, warehouseIds?: string[]) {
    const invoiceDate = this.dayRange(from, to);
    const where = {
      status: { not: 'CANCELLED' as const },
      ...(warehouseIds?.length ? { warehouseId: { in: warehouseIds } } : {}),
      ...(invoiceDate ? { invoiceDate } : {}),
    };
    const invoices = await this.prisma.purchaseInvoice.findMany({
      where,
      include: { supplier: true, warehouse: true },
      orderBy: { invoiceDate: 'desc' },
    });
    const total = invoices.reduce((s, i) => s + i.total, 0);
    const paid = invoices.reduce((s, i) => s + i.paidAmount, 0);
    return { invoices, total, paid, count: invoices.length };
  }

  async profit(from?: string, to?: string, warehouseIds?: string[]) {
    const sales = await this.salesSummary(from, to, warehouseIds);
    const purchases = await this.purchasesSummary(from, to, warehouseIds);
    const invoiceDate = this.dayRange(from, to);
    const expenseDate = this.dayRange(from, to);
    const posted = { in: [InvoiceStatus.CONFIRMED, InvoiceStatus.PARTIAL, InvoiceStatus.PAID] as InvoiceStatus[] };

    const [saleInvoices, returnRows, expenses] = await Promise.all([
      this.prisma.salesInvoice.findMany({
        where: {
          status: posted,
          ...(warehouseIds?.length ? { warehouseId: { in: warehouseIds } } : {}),
          ...(invoiceDate ? { invoiceDate } : {}),
        },
        include: {
          customer: true,
          lines: { include: { product: true } },
        },
        orderBy: { invoiceDate: 'asc' },
      }),
      // مرتجعات البيع بتتخزن في مخزن المرتجعات — مش بنفلترها بمخزن الفاتورة عشان الاستهلاك/الاستبدال يظهروا في الربح
      this.prisma.salesReturn.findMany({
        where: invoiceDate ? { returnDate: invoiceDate } : undefined,
        include: {
          customer: true,
          salesInvoice: { include: { lines: true } },
          replacementProduct: true,
          lines: { include: { product: true } },
        },
        orderBy: { returnDate: 'asc' },
      }),
      this.prisma.expense.findMany({
        where: expenseDate ? { expenseDate } : undefined,
        include: { category: true, account: true },
        orderBy: { expenseDate: 'asc' },
      }),
    ]);
    const scrapSales = await this.prisma.scrapSale.findMany({
      where: invoiceDate ? { saleDate: invoiceDate } : undefined,
      include: {
        supplier: true,
        purchaseInvoice: { select: { number: true, status: true } },
        oldBatteries: { select: { intakeValue: true } },
      },
      orderBy: { saleDate: 'asc' },
    });

    type ProfitLine = {
      id: string;
      kind: 'REVENUE' | 'RETURN' | 'COGS' | 'COGS_RETURN' | 'EXPENSE' | 'DISCOUNT' | 'TAX';
      date: string;
      reference: string;
      party: string;
      description: string;
      quantity: number | null;
      unitAmount: number | null;
      amount: number;
      side: 'IN' | 'OUT';
    };

    const lines: ProfitLine[] = [];
    let revenue = 0;
    let cogs = 0;
    let expenseTotal = 0;

    for (const inv of saleInvoices) {
      const date = inv.invoiceDate.toISOString();
      const party = inv.customer.name;
      for (const line of inv.lines) {
        const unitCost = line.unitCost || line.product.costPrice || 0;
        const cost = Math.round(line.quantity * unitCost * 100) / 100;
        revenue += line.total;
        cogs += cost;
        lines.push({
          id: `rev-${line.id}`,
          kind: 'REVENUE',
          date,
          reference: inv.number,
          party,
          description: `${line.product.sku} — ${line.product.name}`,
          quantity: line.quantity,
          unitAmount: line.unitPrice,
          amount: Math.round(line.total * 100) / 100,
          side: 'IN',
        });
        lines.push({
          id: `cogs-${line.id}`,
          kind: 'COGS',
          date,
          reference: inv.number,
          party,
          description: `تكلفة ${line.product.sku} — ${line.product.name}`,
          quantity: line.quantity,
          unitAmount: unitCost,
          amount: cost,
          side: 'OUT',
        });
      }
      if (inv.discount > 0.009) {
        revenue -= inv.discount;
        lines.push({
          id: `disc-${inv.id}`,
          kind: 'DISCOUNT',
          date,
          reference: inv.number,
          party,
          description: 'خصم الفاتورة',
          quantity: null,
          unitAmount: null,
          amount: Math.round(inv.discount * 100) / 100,
          side: 'OUT',
        });
      }
      // خردة مع فاتورة البيع = إيراد إضافي (وزن × سعر الكيلو)
      if (inv.scrapAmount > 0.009) {
        revenue += inv.scrapAmount;
        lines.push({
          id: `scrap-${inv.id}`,
          kind: 'REVENUE',
          date,
          reference: inv.number,
          party,
          description: `خردة ${inv.scrapKg || 0} كجم`,
          quantity: inv.scrapKg || null,
          unitAmount: inv.scrapPriceKg || null,
          amount: Math.round(inv.scrapAmount * 100) / 100,
          side: 'IN',
        });
      }
      // الضريبة مش ربح — بنسجّلها للشفافية من غير ما تدخل في الإيراد
      if (inv.tax > 0.009) {
        lines.push({
          id: `tax-${inv.id}`,
          kind: 'TAX',
          date,
          reference: inv.number,
          party,
          description: 'ضريبة الفاتورة (لا تدخل في الربح)',
          quantity: null,
          unitAmount: null,
          amount: Math.round(inv.tax * 100) / 100,
          side: 'IN',
        });
      }
    }

    for (const ret of returnRows) {
      const date = ret.returnDate.toISOString();
      const party = ret.customer?.name || ret.customerName || '—';
      const lineRevenue = ret.lines.reduce((s, l) => s + (l.total || 0), 0);
      // مرتجع تقليدي مربوط بقيمة أصناف (يعكس بيع سابق)
      const isSaleReversal = lineRevenue > 0.009 || !!ret.salesInvoiceId;

      if (isSaleReversal) {
        for (const line of ret.lines) {
          const fromInvoice = !(line.unitCost && line.unitCost > 0) && ret.salesInvoice
            ? sliceInvoiceCost(ret.salesInvoice.lines, line.productId)
            : null;
          const unitCost = (line.unitCost && line.unitCost > 0 ? line.unitCost : null)
            ?? fromInvoice
            ?? line.product.costPrice
            ?? 0;
          const cost = Math.round(line.quantity * unitCost * 100) / 100;
          if (line.total > 0.009) {
            revenue -= line.total;
            lines.push({
              id: `ret-${line.id}`,
              kind: 'RETURN',
              date,
              reference: ret.number,
              party,
              description: `مرتجع ${line.product.sku} — ${line.product.name}`,
              quantity: line.quantity,
              unitAmount: line.unitPrice,
              amount: Math.round(line.total * 100) / 100,
              side: 'OUT',
            });
          }
          cogs -= cost;
          lines.push({
            id: `cogsret-${line.id}`,
            kind: 'COGS_RETURN',
            date,
            reference: ret.number,
            party,
            description: `استرداد تكلفة ${line.product.sku} — ${line.product.name}`,
            quantity: line.quantity,
            unitAmount: unitCost,
            amount: cost,
            side: 'IN',
          });
        }
      } else {
        // مرتجع مخزن حالي: استلام بضاعة في مخزن المرتجعات بدون عكس فاتورة البيع
        // → مش بنقلل الإيراد ولا التكلفة؛ الاستهلاك والاستبدال هما اللي يدخلوا الربح
        for (const line of ret.lines) {
          lines.push({
            id: `retstock-${line.id}`,
            kind: 'RETURN',
            date,
            reference: ret.number,
            party,
            description: `استلام مرتجع للمخزن ${line.product.sku} — ${line.product.name} (بدون أثر على الربح)`,
            quantity: line.quantity,
            unitAmount: line.unitCost || line.product.costPrice || 0,
            amount: 0,
            side: 'OUT',
          });
        }
      }

      // إيراد استهلاك / خردة على المرتجع
      const consumption = ret.consumptionAmount || 0;
      if (consumption > 0.009) {
        revenue += consumption;
        lines.push({
          id: `retcons-${ret.id}`,
          kind: 'REVENUE',
          date,
          reference: ret.number,
          party,
          description: 'إيراد استهلاك مرتجع',
          quantity: ret.scrapKg || null,
          unitAmount: null,
          amount: Math.round(consumption * 100) / 100,
          side: 'IN',
        });
      }

      // بطارية الاستبدال: حركة مخزن فقط — هتتعادل لما تترجع للمورد ويتستلم بديل، فمش بتدخل في الربح
      if (ret.giveReplacement && ret.replacementProductId && ret.replacementQty > 0) {
        const unitCost = ret.replacementProduct?.costPrice || 0;
        lines.push({
          id: `retrep-${ret.id}`,
          kind: 'COGS',
          date,
          reference: ret.number,
          party,
          description: `استبدال ${ret.replacementProduct?.sku || ''} — ${ret.replacementProduct?.name || 'بطارية'} (مخزن فقط · مش على الربح)`,
          quantity: ret.replacementQty,
          unitAmount: unitCost,
          amount: 0,
          side: 'OUT',
        });
      }
    }

    for (const s of scrapSales) {
      if (s.purchaseInvoice && (s.purchaseInvoice.status === 'DRAFT' || s.purchaseInvoice.status === 'CANCELLED')) continue;
      revenue += s.amount;
      lines.push({
        id: `scrapsale-${s.id}`,
        kind: 'REVENUE',
        date: s.saleDate.toISOString(),
        reference: s.number,
        party: s.supplier.name,
        description: `بيع خردة ${s.netKg} كجم${s.withWater ? ` (بمياه −${s.waterPercent}%)` : ''}${s.purchaseInvoice ? ` · مخصومة من ${s.purchaseInvoice.number}` : ''}`,
        quantity: s.netKg,
        unitAmount: s.priceKg,
        amount: Math.round(s.amount * 100) / 100,
        side: 'IN',
      });
      // قيمة البطاريات القديمة اللي اتحسبت للزبائن وقت الاستلام = تكلفة الخردة المبيعة
      const scrapCost = Math.round(s.oldBatteries.reduce((sum, b) => sum + (b.intakeValue || 0), 0) * 100) / 100;
      if (scrapCost > 0.009) {
        cogs += scrapCost;
        lines.push({
          id: `scrapcost-${s.id}`,
          kind: 'COGS',
          date: s.saleDate.toISOString(),
          reference: s.number,
          party: s.supplier.name,
          description: `تكلفة ${s.oldBatteries.length} بطارية خردة (قيمتها وقت الاستلام من الزبائن)`,
          quantity: s.oldBatteries.length,
          unitAmount: null,
          amount: scrapCost,
          side: 'OUT',
        });
      }
    }

    const returnFees = await this.prisma.purchaseReturn.findMany({
      where: { consumptionFee: { gt: 0 }, ...(invoiceDate ? { returnDate: invoiceDate } : {}) },
      include: { supplier: { select: { name: true } } },
    });
    for (const r of returnFees) {
      expenseTotal += r.consumptionFee;
      lines.push({
        id: `prfee-${r.id}`,
        kind: 'EXPENSE',
        date: r.returnDate.toISOString(),
        reference: r.number,
        party: r.supplier.name,
        description: 'استهلاك مدفوع للمورد على مرتجع شراء',
        quantity: null,
        unitAmount: null,
        amount: Math.round(r.consumptionFee * 100) / 100,
        side: 'OUT',
      });
    }

    for (const expense of expenses) {
      expenseTotal += expense.amount;
      lines.push({
        id: `exp-${expense.id}`,
        kind: 'EXPENSE',
        date: expense.expenseDate.toISOString(),
        reference: expense.account.name,
        party: expense.category.name,
        description: expense.notes?.trim() || expense.category.name,
        quantity: null,
        unitAmount: null,
        amount: Math.round(expense.amount * 100) / 100,
        side: 'OUT',
      });
    }

    lines.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.reference.localeCompare(b.reference));

    revenue = Math.round(revenue * 100) / 100;
    cogs = Math.round(Math.max(0, cogs) * 100) / 100;
    expenseTotal = Math.round(expenseTotal * 100) / 100;
    const grossProfit = Math.round((revenue - cogs) * 100) / 100;
    const netProfit = Math.round((revenue - cogs - expenseTotal) * 100) / 100;

    return {
      salesTotal: sales.total,
      purchasesTotal: purchases.total,
      // فرق إجمالي فواتير البيع − الشراء للمرجعية فقط (مش معادلة الربح)
      invoiceDiff: Math.round((sales.total - purchases.total) * 100) / 100,
      grossProfit,
      salesCount: sales.count,
      purchasesCount: purchases.count,
      revenue,
      cogs,
      expenses: expenseTotal,
      operatingProfit: grossProfit,
      netProfit,
      lines,
      counts: {
        revenue: lines.filter((row) => row.kind === 'REVENUE').length,
        returns: lines.filter((row) => row.kind === 'RETURN').length,
        cogs: lines.filter((row) => row.kind === 'COGS').length,
        expenses: lines.filter((row) => row.kind === 'EXPENSE').length,
        all: lines.length,
      },
    };
  }

  async productInsights(from?: string, to?: string, warehouseIds?: string[]) {
    const invoiceDate = this.dayRange(from, to);
    const confirmed = { in: [InvoiceStatus.CONFIRMED, InvoiceStatus.PARTIAL, InvoiceStatus.PAID] };
    const warehouse = warehouseIds?.length ? { warehouseId: { in: warehouseIds } } : {};

    const [saleLines, saleReturnLines, purchaseLines, purchaseReturnLines, products] = await Promise.all([
      this.prisma.salesInvoiceLine.findMany({
        where: { invoice: { status: confirmed, ...warehouse, ...(invoiceDate ? { invoiceDate } : {}) } },
        include: { product: true },
      }),
      this.prisma.salesReturnLine.findMany({
        where: { salesReturn: { ...warehouse, ...(invoiceDate ? { returnDate: invoiceDate } : {}) } },
        include: { product: true },
      }),
      this.prisma.purchaseInvoiceLine.findMany({
        where: { invoice: { status: confirmed, ...warehouse, ...(invoiceDate ? { invoiceDate } : {}) } },
        include: { product: true },
      }),
      this.prisma.purchaseReturnLine.findMany({
        where: { purchaseReturn: { ...warehouse, ...(invoiceDate ? { returnDate: invoiceDate } : {}) } },
        include: { product: true },
      }),
      this.prisma.product.findMany({
        where: { isActive: true },
        include: { stockBalances: warehouseIds?.length ? { where: { warehouseId: { in: warehouseIds } } } : true },
      }),
    ]);

    type Info = {
      productId: string;
      sku: string;
      name: string;
      unit: string;
      costPrice: number;
      salePrice: number;
      stockQty: number;
    };
    const info = new Map<string, Info>();
    const remember = (product: { id: string; sku: string; name: string; unit: string; costPrice: number; salePrice: number }, stockQty = 0) => {
      if (!info.has(product.id)) {
        info.set(product.id, {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          unit: product.unit,
          costPrice: product.costPrice,
          salePrice: product.salePrice,
          stockQty,
        });
      }
    };
    for (const product of products) {
      remember(product, product.stockBalances.reduce((sum, row) => sum + row.quantity, 0));
    }
    for (const line of saleLines) remember(line.product);
    for (const line of saleReturnLines) remember(line.product);
    for (const line of purchaseLines) remember(line.product);
    for (const line of purchaseReturnLines) remember(line.product);

    const sold = new Map<string, { qty: number; amount: number }>();
    const purchased = new Map<string, { qty: number; amount: number }>();
    const add = (map: Map<string, { qty: number; amount: number }>, productId: string, qty: number, amount: number) => {
      const current = map.get(productId) || { qty: 0, amount: 0 };
      current.qty += qty;
      current.amount += amount;
      map.set(productId, current);
    };
    for (const line of saleLines) add(sold, line.productId, line.quantity, line.total);
    for (const line of saleReturnLines) add(sold, line.productId, -line.quantity, -line.total);
    for (const line of purchaseLines) add(purchased, line.productId, line.quantity, line.total);
    for (const line of purchaseReturnLines) add(purchased, line.productId, -line.quantity, -line.total);

    const topSold = [...sold.entries()]
      .filter(([, row]) => row.qty > 0)
      .map(([productId, row]) => ({ ...info.get(productId)!, quantity: row.qty, amount: row.amount }))
      .sort((a, b) => b.quantity - a.quantity);

    const topPurchased = [...purchased.entries()]
      .filter(([, row]) => row.qty > 0)
      .map(([productId, row]) => ({ ...info.get(productId)!, quantity: row.qty, amount: row.amount }))
      .sort((a, b) => b.quantity - a.quantity);

    const losses = topSold
      .map((row) => {
        const cost = row.quantity * row.costPrice;
        const loss = Math.round((cost - row.amount) * 100) / 100;
        return { ...row, revenue: row.amount, cost, loss };
      })
      .filter((row) => row.loss > 0)
      .sort((a, b) => b.loss - a.loss);

    const lossTotal = Math.round(losses.reduce((sum, row) => sum + row.loss, 0) * 100) / 100;

    const underpriced = [...info.values()]
      .filter((row) => row.stockQty > 0 && row.salePrice > 0 && row.costPrice > row.salePrice)
      .map((row) => ({
        ...row,
        gap: row.costPrice - row.salePrice,
        potentialLoss: Math.round(row.stockQty * (row.costPrice - row.salePrice) * 100) / 100,
      }))
      .sort((a, b) => b.potentialLoss - a.potentialLoss);

    const potentialLossTotal = Math.round(underpriced.reduce((sum, row) => sum + row.potentialLoss, 0) * 100) / 100;

    const unsold = [...info.values()]
      .filter((row) => {
        const soldQty = sold.get(row.productId)?.qty || 0;
        const purchasedQty = purchased.get(row.productId)?.qty || 0;
        return soldQty <= 0 && (row.stockQty > 0 || purchasedQty > 0);
      })
      .map((row) => ({
        ...row,
        purchasedQty: Math.max(0, purchased.get(row.productId)?.qty || 0),
        stockValue: Math.round(row.stockQty * row.costPrice * 100) / 100,
      }))
      .sort((a, b) => b.stockValue - a.stockValue);

    const unsoldValue = Math.round(unsold.reduce((sum, row) => sum + row.stockValue, 0) * 100) / 100;

    return {
      topSold,
      topPurchased,
      losses,
      lossTotal,
      underpriced,
      potentialLossTotal,
      unsold,
      unsoldValue,
    };
  }

  journal(from?: string, to?: string) {
    return buildJournal(this.prisma, this.dayRange(from, to));
  }

  oldBatteries(from?: string, to?: string) {
    return oldBatteriesReport(this.prisma, this.dayRange(from, to));
  }

  private dayRange(from?: string, to?: string) {
    if (!from && !to) return undefined;
    return {
      ...(from ? { gte: new Date(`${from}T00:00:00`) } : {}),
      ...(to ? { lte: new Date(`${to}T23:59:59.999`) } : {}),
    };
  }

  async cashReport(from?: string, to?: string, warehouseIds?: string[]) {
    const createdAt = this.dayRange(from, to);
    let references: string[] | undefined;
    if (warehouseIds?.length) {
      const [receipts, payments] = await Promise.all([
        this.prisma.receipt.findMany({
          where: { salesInvoice: { warehouseId: { in: warehouseIds } } },
          select: { number: true },
        }),
        this.prisma.payment.findMany({
          where: { purchaseInvoice: { warehouseId: { in: warehouseIds } } },
          select: { number: true },
        }),
      ]);
      references = [...receipts, ...payments].map((row) => row.number);
    }
    const accounts = await this.prisma.cashAccount.findMany({ orderBy: { name: 'asc' } });
    const currentTotal = accounts.reduce((s, a) => s + (a.balance || 0), 0);
    if (warehouseIds?.length && !(references?.length)) {
      return {
        transactions: [],
        accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.accountType, balance: a.balance, isActive: a.isActive })),
        totalIn: 0,
        totalOut: 0,
        net: 0,
        currentTotal,
      };
    }
    const transactions = await this.prisma.cashTransaction.findMany({
      where: {
        ...(createdAt ? { createdAt } : {}),
        ...(references?.length ? { reference: { in: references } } : {}),
      },
      include: { account: true },
      orderBy: { createdAt: 'desc' },
    });
    const totalIn = transactions.filter((t) => t.direction === 'IN').reduce((s, t) => s + t.amount, 0);
    const totalOut = transactions.filter((t) => t.direction === 'OUT').reduce((s, t) => s + t.amount, 0);
    return {
      transactions,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.accountType, balance: a.balance, isActive: a.isActive })),
      totalIn,
      totalOut,
      net: totalIn - totalOut,
      currentTotal,
    };
  }

  async returnsSummary(from?: string, to?: string, warehouseIds?: string[]) {
    const range = this.dayRange(from, to);
    const wh = warehouseIds?.length ? { warehouseId: { in: warehouseIds } } : {};
    const [salesReturns, purchaseReturns] = await Promise.all([
      this.prisma.salesReturn.findMany({
        where: { ...wh, ...(range ? { returnDate: range } : {}) },
        include: {
          customer: true,
          warehouse: true,
          lines: { include: { product: true } },
        },
        orderBy: { returnDate: 'desc' },
      }),
      this.prisma.purchaseReturn.findMany({
        where: { ...wh, ...(range ? { returnDate: range } : {}) },
        include: {
          supplier: true,
          warehouse: true,
          lines: { include: { product: true } },
        },
        orderBy: { returnDate: 'desc' },
      }),
    ]);
    const salesTotal = salesReturns.reduce((s, r) => s + (r.consumptionAmount || r.total || 0), 0);
    const purchaseTotal = purchaseReturns.reduce((s, r) => s + r.total, 0);
    const restockedValue = purchaseReturns.reduce(
      (s, r) => s + r.lines.reduce((x, l) => x + (l.restockedQty || 0) * (l.unitCost || 0), 0),
      0,
    );
    return {
      salesReturns,
      purchaseReturns,
      salesCount: salesReturns.length,
      purchaseCount: purchaseReturns.length,
      salesTotal,
      purchaseTotal,
      restockedValue,
    };
  }

  async suppliersActivity(from?: string, to?: string) {
    const range = this.dayRange(from, to);
    const suppliers = await this.prisma.supplier.findMany({ orderBy: { name: 'asc' } });
    const scrap = await this.prisma.scrapSale.findMany({
      where: range ? { saleDate: range } : undefined,
      select: { supplierId: true, amount: true },
    });
    const [purchases, payments, returns] = await Promise.all([
      this.prisma.purchaseInvoice.findMany({
        where: { status: { notIn: ['CANCELLED', 'DRAFT'] }, ...(range ? { invoiceDate: range } : {}) },
        select: { supplierId: true, total: true, paidAmount: true, scrapAmount: true },
      }),
      this.prisma.payment.findMany({
        where: range ? { paidAt: range } : undefined,
        select: { supplierId: true, amount: true },
      }),
      this.prisma.purchaseReturn.findMany({
        where: range ? { returnDate: range } : undefined,
        select: { supplierId: true, total: true, lines: { select: { restockedQty: true, unitCost: true } } },
      }),
    ]);
    return suppliers.map((s) => {
      const buy = purchases.filter((p) => p.supplierId === s.id);
      const pay = payments.filter((p) => p.supplierId === s.id);
      const ret = returns.filter((p) => p.supplierId === s.id);
      const purchased = buy.reduce((sum, p) => sum + p.total + (p.scrapAmount || 0), 0);
      const paid = pay.reduce((sum, p) => sum + p.amount, 0);
      const returned = ret.reduce((sum, p) => sum + p.total, 0);
      const scrapSold = scrap.filter((x) => x.supplierId === s.id).reduce((sum, x) => sum + x.amount, 0);
      const restocked = ret.reduce(
        (sum, p) => sum + p.lines.reduce((x, l) => x + (l.restockedQty || 0) * (l.unitCost || 0), 0),
        0,
      );
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        balance: s.balance,
        purchased,
        paid,
        returned,
        restocked,
        scrapSold,
        invoiceCount: buy.length,
        paymentCount: pay.length,
        returnCount: ret.length,
      };
    }).filter((row) => row.invoiceCount || row.paymentCount || row.returnCount || row.scrapSold > 0.009 || Math.abs(row.balance) > 0.009);
  }

  async customersActivity(from?: string, to?: string) {
    const range = this.dayRange(from, to);
    const customers = await this.prisma.customer.findMany({ orderBy: { name: 'asc' } });
    const [sales, receipts, returns] = await Promise.all([
      this.prisma.salesInvoice.findMany({
        where: { status: { not: 'CANCELLED' }, ...(range ? { invoiceDate: range } : {}) },
        select: { customerId: true, total: true, paidAmount: true },
      }),
      this.prisma.receipt.findMany({
        where: range ? { receivedAt: range } : undefined,
        select: { customerId: true, amount: true },
      }),
      this.prisma.salesReturn.findMany({
        where: range ? { returnDate: range } : undefined,
        select: { customerId: true, total: true, consumptionAmount: true },
      }),
    ]);
    return customers.map((c) => {
      const sell = sales.filter((p) => p.customerId === c.id);
      const rec = receipts.filter((p) => p.customerId === c.id);
      const ret = returns.filter((p) => p.customerId === c.id);
      const sold = sell.reduce((sum, p) => sum + p.total, 0);
      const received = rec.reduce((sum, p) => sum + p.amount, 0);
      const returned = ret.reduce((sum, p) => sum + (p.consumptionAmount || p.total || 0), 0);
      return {
        id: c.id,
        code: c.code,
        name: c.name,
        balance: c.balance,
        sold,
        received,
        returned,
        invoiceCount: sell.length,
        receiptCount: rec.length,
        returnCount: ret.length,
      };
    }).filter((row) => row.invoiceCount || row.receiptCount || row.returnCount || Math.abs(row.balance) > 0.009);
  }

  async exportInventoryExcel(warehouseIds?: string[]) {
    const rows = await this.inventory(warehouseIds);
    const ExcelJS = await loadExcel();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('المخزون');
    ws.columns = [
      { header: 'المخزن', key: 'warehouse', width: 20 },
      { header: 'الكود', key: 'sku', width: 15 },
      { header: 'الصنف', key: 'name', width: 30 },
      { header: 'الوحدة', key: 'unit', width: 10 },
      { header: 'الكمية', key: 'qty', width: 12 },
      { header: 'تكلفة', key: 'cost', width: 12 },
      { header: 'بيع', key: 'sale', width: 12 },
    ];
    for (const r of rows) {
      ws.addRow({
        warehouse: r.warehouse.name,
        sku: r.product.sku,
        name: r.product.name,
        unit: r.product.unit,
        qty: r.quantity,
        cost: r.product.costPrice,
        sale: r.product.salePrice,
      });
    }
    ws.getRow(1).font = { bold: true };
    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
