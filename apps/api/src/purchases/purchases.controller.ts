import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { InvoiceStatus, Role } from '@prisma/client';
import { PurchasesService } from './purchases.service';
import { Roles } from '../common/guards';
import { assertWarehouseAllowed, userWarehouseIds } from '../common/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';

class LineDto {
  @IsOptional() @IsString() id?: string;
  @IsString() productId!: string;
  @IsNumber() quantity!: number;
  @IsNumber() unitCost!: number;
  @IsOptional() @IsNumber() discount?: number;
  @IsOptional() @IsString() batchNumber?: string;
  @IsOptional() @IsString() expiryDate?: string;
}

class TenderDto {
  @IsOptional() @IsString() id?: string;
  @IsString() methodId!: string;
  @IsNumber() amount!: number;
  @IsOptional() @IsString() referenceNo?: string;
}

class ScrapDto {
  @IsOptional() @IsBoolean() withWater?: boolean;
  @IsOptional() @IsNumber() grossKg?: number;
  @IsOptional() @IsNumber() priceKg?: number;
  @IsOptional() @IsString() notes?: string;
}

class CreatePurchaseDto {
  @IsOptional() @ValidateNested() @Type(() => ScrapDto) scrap?: ScrapDto | null;
  @IsString() supplierId!: string;
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() invoiceDate?: string;
  @IsOptional() @IsNumber() discount?: number;
  @IsOptional() @IsNumber() tax?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsNumber() paidAmount?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TenderDto) payments?: TenderDto[];
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsArray() @ValidateNested({ each: true }) @Type(() => LineDto)
  lines!: LineDto[];
}

@Controller('purchases')
export class PurchasesController {
  constructor(
    private service: PurchasesService,
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
  priceHints(@Query('supplierId') supplierId?: string, @Query('excludeInvoiceId') excludeInvoiceId?: string) {
    return this.service.priceHints(supplierId, excludeInvoiceId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  async create(
    @Body() dto: CreatePurchaseDto,
    @Req() req: { user: { userId: string; role: string } },
    @Headers('x-idempotency-key') idempotencyKey?: string,
  ) {
    await assertWarehouseAllowed(this.prisma, req.user, dto.warehouseId);
    return this.service.create({ ...dto, createdById: req.user.userId, idempotencyKey });
  }

  @Post(':id/confirm')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  confirm(@Param('id') id: string, @Body() body: { payments?: TenderDto[] }) {
    return this.service.confirm(id, body.payments);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  update(@Param('id') id: string, @Body() dto: CreatePurchaseDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
