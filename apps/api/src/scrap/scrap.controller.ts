import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import { ScrapService } from './scrap.service';

class ScrapSaleDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsString() saleDate?: string;
  @IsOptional() @IsBoolean() withWater?: boolean;
  @IsNumber() grossKg!: number;
  @IsNumber() priceKg!: number;
  @IsIn(['INVOICE', 'CASH', 'BALANCE']) settlement!: 'INVOICE' | 'CASH' | 'BALANCE';
  @IsOptional() @IsString() purchaseInvoiceId?: string;
  @IsOptional() @IsString() methodId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) oldBatteryIds?: string[];
}

@Controller('scrap')
export class ScrapController {
  constructor(private service: ScrapService) {}

  @Get('config')
  config() {
    return this.service.config();
  }

  @Get('suppliers')
  suppliers() {
    return this.service.suppliers();
  }

  @Get('pile')
  pile(@Query('scrapId') scrapId?: string) {
    return this.service.pile(scrapId);
  }

  @Get('open-invoices')
  openInvoices(@Query('supplierId') supplierId: string, @Query('scrapId') scrapId?: string) {
    return this.service.openInvoices(supplierId, scrapId);
  }

  @Get()
  list(@Query('supplierId') supplierId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.list({ supplierId, from, to });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: ScrapSaleDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: ScrapSaleDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
