import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import { OldBatteriesService } from './oldbatteries.service';

class CreateOldBatteryDto {
  @IsIn(['MANUAL', 'WARRANTY_WAIT']) kind!: 'MANUAL' | 'WARRANTY_WAIT';
  @IsOptional() @IsNumber() quantity?: number;
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() customerName?: string;
  @IsOptional() @IsString() customerPhone?: string;
  @IsOptional() @IsNumber() intakeValue?: number;
  @IsOptional() @IsString() productionDate?: string;
  @IsOptional() @IsString() ageBand?: string;
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() loanerProductId?: string;
  @IsOptional() @IsString() loanerWarehouseId?: string;
}

class UpdateOldBatteryDto {
  @IsOptional() @IsString() productId?: string | null;
  @IsOptional() @IsString() label?: string | null;
  @IsOptional() @IsString() customerName?: string | null;
  @IsOptional() @IsString() customerPhone?: string | null;
  @IsOptional() @IsNumber() intakeValue?: number;
  @IsOptional() @IsString() notes?: string | null;
}

class SortDto {
  @IsIn(['PENDING', 'SCRAP', 'USED', 'SERVICE', 'WARRANTY']) decision!: 'PENDING' | 'SCRAP' | 'USED' | 'SERVICE' | 'WARRANTY';
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() productionDate?: string | null;
  @IsOptional() @IsString() ageBand?: string | null;
  @IsOptional() @IsString() condition?: string | null;
  @IsOptional() @IsString() stockProductId?: string;
  @IsOptional() @IsString() stockWarehouseId?: string;
  @IsOptional() @IsNumber() weightKg?: number | null;
  @IsOptional() @IsString() supplierId?: string | null;
  @IsOptional() @IsString() notes?: string | null;
}

class SortBulkDto extends SortDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
}

class SendDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
  @IsString() supplierId!: string;
  @IsOptional() @IsString() sentAt?: string;
  @IsOptional() @IsString() receiverName?: string;
}

class ReceiveDto {
  @IsOptional() @IsString() replacementProductId?: string;
  @IsOptional() @IsString() replacementWarehouseId?: string;
  @IsOptional() @IsNumber() consumptionFee?: number;
  @IsOptional() @IsIn(['BALANCE', 'CASH']) feeSettlement?: 'BALANCE' | 'CASH';
  @IsOptional() @IsString() methodId?: string;
  @IsOptional() @IsString() replacementAt?: string;
}

class RejectDto {
  @IsOptional() @IsBoolean() toScrap?: boolean;
}

@Controller('returns/old-batteries')
export class OldBatteriesController {
  constructor(private service: OldBatteriesService) {}

  @Get('summary')
  summary() {
    return this.service.summary();
  }

  @Get('config')
  config() {
    return this.service.config();
  }

  @Post('sort-bulk')
  sortBulk(@Body() dto: SortBulkDto) {
    return this.service.sortBulk(dto);
  }

  @Get()
  list(@Query('view') view?: string, @Query('supplierId') supplierId?: string, @Query('q') q?: string) {
    return this.service.list({ view, supplierId, q });
  }

  @Post('send')
  send(@Body() dto: SendDto) {
    return this.service.send(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateOldBatteryDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateOldBatteryDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/sort')
  sort(@Param('id') id: string, @Body() dto: SortDto) {
    return this.service.sort(id, dto);
  }

  @Patch(':id/unsend')
  unsend(@Param('id') id: string) {
    return this.service.unsend(id);
  }

  @Patch(':id/receive')
  receive(@Param('id') id: string, @Body() dto: ReceiveDto) {
    return this.service.receive(id, dto);
  }

  @Patch(':id/undo-receive')
  undoReceive(@Param('id') id: string) {
    return this.service.undoReceive(id);
  }

  @Patch(':id/deliver')
  deliver(@Param('id') id: string) {
    return this.service.deliver(id);
  }

  @Patch(':id/undo-deliver')
  undoDeliver(@Param('id') id: string) {
    return this.service.deliver(id, true);
  }

  @Patch(':id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.service.reject(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
