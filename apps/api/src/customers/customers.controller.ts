import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { PriceList, Role } from '@prisma/client';
import { CustomersService } from './customers.service';
import { Roles } from '../common/guards';
import { userWarehouseIds } from '../common/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';

class CustomerNameDto {
  @IsString() name!: string;
}

class CustomerDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsNumber() creditLimit?: number;
  @IsOptional() @IsEnum(PriceList) priceList?: PriceList;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) warehouseIds?: string[];
}

class BulkCustomerDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
  @IsBoolean() isActive!: boolean;
}

class UpdateCustomerDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsNumber() creditLimit?: number;
  @IsOptional() @IsEnum(PriceList) priceList?: PriceList;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) warehouseIds?: string[];
}

@Controller('customers')
export class CustomersController {
  constructor(
    private service: CustomersService,
    private prisma: PrismaService,
  ) {}

  @Get()
  async findAll(
    @Req() req: { user: { userId: string; role: string } },
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('balance') balance?: string,
  ) {
    const warehouseIds = await userWarehouseIds(this.prisma, req.user);
    return this.service.findAll({ search, page, pageSize, balance, warehouseIds });
  }

  @Get('movements/:kind/:id')
  movementDetail(@Param('kind') kind: string, @Param('id') id: string) {
    return this.service.movementDetail(kind, id);
  }

  @Get(':id/statement')
  statement(@Param('id') id: string) {
    return this.service.statement(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Get(':id/prices')
  prices(@Param('id') id: string) {
    return this.service.listPrices(id);
  }

  @Put(':id/prices')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES)
  setPrices(@Param('id') id: string, @Body() body: { prices: { productId: string; price: number }[] }) {
    return this.service.setPrices(id, body.prices || []);
  }

  @Post('by-name')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES)
  async byName(@Body() dto: CustomerNameDto, @Req() req: { user: { userId: string; role: string } }) {
    const warehouseIds = await userWarehouseIds(this.prisma, req.user);
    return this.service.ensureByName(dto.name, warehouseIds || undefined);
  }

  @Post('bulk')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  bulk(@Body() dto: BulkCustomerDto) {
    return this.service.bulkSetActive(dto.ids, dto.isActive);
  }

  @Post()
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES)
  async create(@Body() dto: CustomerDto, @Req() req: { user: { userId: string; role: string } }) {
    const scope = await userWarehouseIds(this.prisma, req.user);
    const warehouseIds = dto.warehouseIds?.length ? dto.warehouseIds : scope || undefined;
    return this.service.create({ ...dto, warehouseIds });
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT, Role.SALES)
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.service.update(id, dto);
  }
}
