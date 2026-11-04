import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { InvoiceStatus, Role } from '@prisma/client';
import { SalesService } from './sales.service';
import { Roles } from '../common/guards';
import { assertWarehouseAllowed, userWarehouseIds } from '../common/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';

class LineDto {
  @IsOptional() @IsString() id?: string;
  @IsString() productId!: string;
  @IsNumber() quantity!: number;
  @IsNumber() unitPrice!: number;
  @IsOptional() @IsNumber() discount?: number;
}

class TenderDto {
  @IsOptional() @IsString() id?: string;
  @IsString() methodId!: string;
  @IsNumber() amount!: number;
  @IsOptional() @IsString() referenceNo?: string;
}

class CreateSalesDto {
  @IsString() customerId!: string;
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() invoiceDate?: string;
  @IsOptional() @IsNumber() discount?: number;
  @IsOptional() @IsNumber() tax?: number;
  @IsOptional() @IsNumber() taxRate?: number;
  @IsOptional() @IsString() shiftId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsNumber() paidAmount?: number;
  @IsOptional() @IsBoolean() hasScrap?: boolean;
  @IsOptional() @IsNumber() scrapKg?: number;
  @IsOptional() @IsNumber() scrapPieces?: number;
  @IsOptional() @IsNumber() scrapPriceKg?: number;
  @IsOptional() @IsNumber() scrapAmount?: number;
  @IsOptional() @IsIn(['SCRAP', 'WARRANTY_SWAP']) scrapKind?: 'SCRAP' | 'WARRANTY_SWAP';
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TenderDto) payments?: TenderDto[];
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsArray() @ValidateNested({ each: true }) @Type(() => LineDto)
  lines!: LineDto[];
}

@Controller('sales')
export class SalesController {
  constructor(
    private service: SalesService,
    private prisma: PrismaService,
  ) {}

  @Get()
  async findAll(
    @Req() req: { user: { userId: string; role: string } },
    @Query('status') status?: InvoiceStatus,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('q') q?: string,
    @Query('due') due?: string,
  ) {
    const warehouseIds = await userWarehouseIds(this.prisma, req.user);
    return this.service.findAll({ status, page, pageSize, q, due, warehouseIds });
  }

  @Get('dues')
  async dues(@Req() req: { user: { userId: string; role: string } }) {
    const warehouseIds = await userWarehouseIds(this.prisma, req.user);
    return this.service.dues(warehouseIds);
  }

  @Get('price-hints')
  priceHints(@Query('customerId') customerId?: string, @Query('excludeInvoiceId') excludeInvoiceId?: string) {
    return this.service.priceHints(customerId, excludeInvoiceId);
  }

  @Get('fifo-preview')
  fifoPreview(
    @Query('warehouseId') warehouseId: string,
    @Query('lines') lines: string,
    @Query('excludeInvoiceId') excludeInvoiceId?: string,
  ) {
    return this.service.fifoPreview({ warehouseId, lines, excludeInvoiceId });
  }

  @Get(':id/fifo')
  fifo(@Param('id') id: string) {
    return this.service.fifo(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  async create(
    @Body() dto: CreateSalesDto,
    @Req() req: { user: { userId: string; role: string } },
    @Headers('x-idempotency-key') idempotencyKey?: string,
  ) {
    await assertWarehouseAllowed(this.prisma, req.user, dto.warehouseId);
    return this.service.create({ ...dto, createdById: req.user.userId, idempotencyKey });
  }

  @Post(':id/confirm')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  confirm(@Param('id') id: string, @Body() body: { payments?: TenderDto[] }) {
    return this.service.confirm(id, body.payments);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  update(@Param('id') id: string, @Body() dto: CreateSalesDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
