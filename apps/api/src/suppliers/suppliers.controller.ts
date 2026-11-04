import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { Role } from '@prisma/client';
import { SuppliersService } from './suppliers.service';
import { Roles } from '../common/guards';
import { userWarehouseIds } from '../common/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';

class SupplierDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) warehouseIds?: string[];
}

class UpdateSupplierDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) warehouseIds?: string[];
}

@Controller('suppliers')
export class SuppliersController {
  constructor(
    private service: SuppliersService,
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

  @Post()
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  async create(@Body() dto: SupplierDto, @Req() req: { user: { userId: string; role: string } }) {
    const scope = await userWarehouseIds(this.prisma, req.user);
    const warehouseIds = dto.warehouseIds?.length ? dto.warehouseIds : scope || undefined;
    return this.service.create({ ...dto, warehouseIds });
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.service.update(id, dto);
  }
}
