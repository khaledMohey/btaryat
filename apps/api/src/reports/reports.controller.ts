import { Controller, Get, Header, Query, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { ReportsService } from './reports.service';
import { userWarehouseIds } from '../common/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';

function parseWarehouseIds(many?: string, one?: string) {
  const raw = (many || one || '').split(',').map((id) => id.trim()).filter(Boolean);
  return raw.length ? raw : undefined;
}

/** يتقاطع اختيار التقرير مع مخازن المستخدم. */
async function scopedWarehouseIds(
  prisma: PrismaService,
  user: { userId: string; role: string },
  many?: string,
  one?: string,
) {
  const requested = parseWarehouseIds(many, one);
  const allowed = await userWarehouseIds(prisma, user);
  if (!allowed) return requested;
  if (!requested?.length) return allowed;
  return requested.filter((id) => allowed.includes(id));
}

@Controller('reports')
export class ReportsController {
  constructor(
    private service: ReportsService,
    private prisma: PrismaService,
  ) {}

  @Get('inventory')
  async inventory(
    @Req() req: { user: { userId: string; role: string } },
    @Query('warehouseIds') warehouseIdsQuery?: string,
    @Query('warehouseId') warehouseId?: string,
  ) {
    return this.service.inventory(await scopedWarehouseIds(this.prisma, req.user, warehouseIdsQuery, warehouseId));
  }

  @Get('sales')
  async sales(
    @Req() req: { user: { userId: string; role: string } },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouseIds') warehouseIdsQuery?: string,
  ) {
    return this.service.salesSummary(from, to, await scopedWarehouseIds(this.prisma, req.user, warehouseIdsQuery));
  }

  @Get('purchases')
  async purchases(
    @Req() req: { user: { userId: string; role: string } },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouseIds') warehouseIdsQuery?: string,
  ) {
    return this.service.purchasesSummary(from, to, await scopedWarehouseIds(this.prisma, req.user, warehouseIdsQuery));
  }

  @Get('profit')
  async profit(
    @Req() req: { user: { userId: string; role: string } },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouseIds') warehouseIdsQuery?: string,
  ) {
    return this.service.profit(from, to, await scopedWarehouseIds(this.prisma, req.user, warehouseIdsQuery));
  }

  @Get('cash')
  async cash(
    @Req() req: { user: { userId: string; role: string } },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouseIds') warehouseIdsQuery?: string,
  ) {
    return this.service.cashReport(from, to, await scopedWarehouseIds(this.prisma, req.user, warehouseIdsQuery));
  }

  @Get('products')
  async products(
    @Req() req: { user: { userId: string; role: string } },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouseIds') warehouseIdsQuery?: string,
  ) {
    return this.service.productInsights(from, to, await scopedWarehouseIds(this.prisma, req.user, warehouseIdsQuery));
  }

  @Get('returns')
  async returns(
    @Req() req: { user: { userId: string; role: string } },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouseIds') warehouseIdsQuery?: string,
  ) {
    return this.service.returnsSummary(from, to, await scopedWarehouseIds(this.prisma, req.user, warehouseIdsQuery));
  }

  @Get('suppliers')
  suppliers(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.suppliersActivity(from, to);
  }

  @Get('customers')
  customers(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.customersActivity(from, to);
  }

  @Get('journal')
  journal(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.journal(from, to);
  }

  @Get('old-batteries')
  oldBatteries(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.oldBatteries(from, to);
  }

  @Get('inventory/excel')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async inventoryExcel(
    @Req() req: { user: { userId: string; role: string } },
    @Query('warehouseIds') warehouseIdsQuery: string | undefined,
    @Query('warehouseId') warehouseId: string | undefined,
    @Res() res: Response,
  ) {
    const buffer = await this.service.exportInventoryExcel(
      await scopedWarehouseIds(this.prisma, req.user, warehouseIdsQuery, warehouseId),
    );
    res.setHeader('Content-Disposition', 'attachment; filename=inventory.xlsx');
    res.send(buffer);
  }
}
