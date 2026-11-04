import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FieldType, Role } from '@prisma/client';
import { ProductsService } from './products.service';
import { Roles } from '../common/guards';
import { userWarehouseIds } from '../common/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';

class FieldValueDto {
  @IsString() fieldId!: string;
  @IsString() value!: string;
}

class ProductFieldDto {
  @IsString() name!: string;
  @IsString() label!: string;
  @IsOptional() @IsEnum(FieldType) fieldType?: FieldType;
  @IsOptional() @IsString() options?: string;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

class UpdateProductFieldDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsEnum(FieldType) fieldType?: FieldType;
  @IsOptional() @IsString() options?: string;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

class ProductDto {
  @IsOptional() @IsString() sku?: string;
  @IsString() name!: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() costPrice?: number;
  @IsOptional() @IsNumber() salePrice?: number;
  @IsOptional() @IsNumber() wholesalePrice?: number;
  @IsOptional() @IsNumber() minStock?: number;
  @IsOptional() @IsNumber() packSize?: number;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() batterySize?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() packUnit?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FieldValueDto)
  fieldValues?: FieldValueDto[];
  @IsOptional() @IsArray() @IsString({ each: true })
  warehouseIds?: string[];
}

class UpdateProductDto {
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() salePrice?: number;
  @IsOptional() @IsNumber() wholesalePrice?: number;
  @IsOptional() @IsNumber() minStock?: number;
  @IsOptional() @IsNumber() packSize?: number;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() batterySize?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() packUnit?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FieldValueDto)
  fieldValues?: FieldValueDto[];
  @IsOptional() @IsArray() @IsString({ each: true })
  warehouseIds?: string[];
}

class ImportRowDto {
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() salePrice?: number;
  @IsOptional() @IsNumber() minStock?: number;
  @IsOptional() @IsString() barcode?: string;
}

class ImportDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ImportRowDto)
  rows!: ImportRowDto[];
}

@Controller('products')
export class ProductsController {
  constructor(
    private service: ProductsService,
    private prisma: PrismaService,
  ) {}

  @Get('fields')
  listFields() {
    return this.service.listFields();
  }

  @Post('fields')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  createField(@Body() dto: ProductFieldDto) {
    return this.service.createField(dto);
  }

  @Patch('fields/:fieldId')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  updateField(@Param('fieldId') fieldId: string, @Body() dto: UpdateProductFieldDto) {
    return this.service.updateField(fieldId, dto);
  }

  @Delete('fields/:fieldId')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  deleteField(@Param('fieldId') fieldId: string) {
    return this.service.deleteField(fieldId);
  }

  @Get('categories')
  categories() {
    return this.service.listCategories();
  }

  @Post('categories')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  createCategory(@Body() body: { name: string }) {
    return this.service.createCategory(body.name);
  }

  @Delete('categories/:id')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  deleteCategory(@Param('id') id: string) {
    return this.service.deleteCategory(id);
  }

  @Get('barcode/:code')
  barcode(@Param('code') code: string) {
    return this.service.findByBarcode(code);
  }

  @Get('next-sku')
  async nextSku() {
    return { sku: await this.service.nextSku() };
  }

  @Get()
  async findAll(
    @Req() req: { user: { userId: string; role: string } },
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('filter') filter?: string,
    @Query('warehouseId') warehouseId?: string,
  ) {
    const warehouseIds = await userWarehouseIds(this.prisma, req.user);
    return this.service.findAll({ search, page, pageSize, filter, warehouseId, warehouseIds });
  }

  @Get(':id/image')
  async image(@Param('id') id: string, @Res() res: Response) {
    const image = await this.service.image(id);
    if ('path' in image) return res.sendFile(image.path);
    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(image.data);
  }

  @Post(':id/image')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadImage(@Param('id') id: string, @UploadedFile() file?: { buffer?: Buffer; mimetype?: string }) {
    if (!file?.buffer?.length || !file.mimetype) throw new BadRequestException('اختر صورة');
    return this.service.saveImage(id, { buffer: file.buffer, mimetype: file.mimetype });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post('import')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  importRows(@Body() dto: ImportDto) {
    return this.service.importRows(dto.rows || []);
  }

  @Post('import-file')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  importFile(@UploadedFile() file?: { buffer?: Buffer; originalname?: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('اختر ملفًا');
    return this.service.importFile(file.buffer, file.originalname || 'products.xlsx');
  }

  @Post()
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  create(@Body() dto: ProductDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.WAREHOUSE)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
