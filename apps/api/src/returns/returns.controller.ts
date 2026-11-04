import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Role } from '@prisma/client';
import { ReturnsService } from './returns.service';
import { Roles } from '../common/guards';

class CreateSalesReturnDto {
  @IsOptional() @IsString() customerName?: string;
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsNumber() scrapKg?: number;
  @IsOptional() @IsNumber() scrapPieces?: number;
  @IsOptional() @IsNumber() consumptionAmount?: number;
  @IsOptional() @IsString() cashAccountId?: string;
  @IsOptional() @IsBoolean() giveReplacement?: boolean;
  @IsOptional() @IsString() replacementProductId?: string;
  @IsOptional() @IsString() replacementWarehouseId?: string;
  @IsOptional() @IsNumber() replacementQty?: number;
  @IsOptional() @IsString() notes?: string;
}

class PurchaseReturnLineDto {
  @IsString() productId!: string;
  @IsNumber() quantity!: number;
  @IsNumber() unitCost!: number;
}

class CreatePurchaseReturnDto {
  @IsString() supplierId!: string;
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() purchaseInvoiceId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsNumber() consumptionFee?: number;
  @IsOptional() @IsString() feeSettlement?: string;
  @IsOptional() @IsString() methodId?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PurchaseReturnLineDto)
  lines!: PurchaseReturnLineDto[];
}

class UpdatePurchaseReturnDto {
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsNumber() consumptionFee?: number;
  @IsOptional() @IsString() feeSettlement?: string;
  @IsOptional() @IsString() methodId?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PurchaseReturnLineDto)
  lines!: PurchaseReturnLineDto[];
}

class RestockLineDto {
  @IsString() productId!: string;
  @IsNumber() quantity!: number;
}

class RestockPurchaseReturnDto {
  @IsString() warehouseId!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RestockLineDto)
  lines!: RestockLineDto[];
}

@Controller('returns')
export class ReturnsController {
  constructor(private service: ReturnsService) {}

  @Get('sales')
  listSales(@Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('q') q?: string) {
    return this.service.listSalesReturns({ page, pageSize, q });
  }

  @Get('purchases')
  listPurchases(@Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('q') q?: string) {
    return this.service.listPurchaseReturns({ page, pageSize, q });
  }

  @Get('sales/returnable/:customerId')
  salesReturnable(@Param('customerId') customerId: string) {
    return this.service.salesReturnable(customerId);
  }

  @Get('purchases/returnable/:supplierId')
  purchasesReturnable(@Param('supplierId') supplierId: string) {
    return this.service.purchasesReturnable(supplierId);
  }

  @Get('purchases/products/:supplierId')
  purchasesProducts(
    @Param('supplierId') supplierId: string,
    @Query('warehouseId') warehouseId?: string,
  ) {
    return this.service.purchasesProducts(supplierId, warehouseId);
  }

  @Post('sales')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  createSales(@Body() dto: CreateSalesReturnDto) {
    return this.service.createSalesReturn(dto);
  }

  @Patch('sales/:id')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  updateSales(@Param('id') id: string, @Body() dto: CreateSalesReturnDto) {
    return this.service.updateSalesReturn(id, dto);
  }

  @Delete('sales/:id')
  @Roles(Role.ADMIN, Role.SALES, Role.ACCOUNTANT)
  deleteSales(@Param('id') id: string) {
    return this.service.deleteSalesReturn(id);
  }

  @Post('purchases')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  createPurchase(@Body() dto: CreatePurchaseReturnDto) {
    return this.service.createPurchaseReturn(dto);
  }

  @Patch('purchases/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  updatePurchase(@Param('id') id: string, @Body() dto: UpdatePurchaseReturnDto) {
    return this.service.updatePurchaseReturn(id, dto);
  }

  @Delete('purchases/:id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  deletePurchase(@Param('id') id: string) {
    return this.service.deletePurchaseReturn(id);
  }

  @Post('purchases/:id/restock')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.WAREHOUSE)
  restockPurchase(@Param('id') id: string, @Body() dto: RestockPurchaseReturnDto) {
    return this.service.restockPurchaseReturn(id, dto);
  }
}
