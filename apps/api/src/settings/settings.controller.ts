import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IsNumber, IsObject, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { SettingsService } from './settings.service';
import { Roles } from '../common/guards';
import {
  SettingsGateGuard,
  desktopDownloadPasswordMatches,
  settingsPasswordMatches,
  signDesktopDownloadToken,
  signEditToken,
  signSettingsToken,
  verifyDesktopDownloadToken,
} from './settings-gate';
import * as bcrypt from 'bcryptjs';

class UpdateSettingsDto {
  @IsObject()
  data!: Record<string, string>;
}

class UnlockSettingsDto {
  @IsString() @MinLength(1) password!: string;
}

class EditPasswordDto {
  @IsString() @MinLength(4) password!: string;
}

class ClosePeriodDto {
  @IsNumber() year!: number;
  @IsNumber() month!: number;
}

class ReopenPeriodDto extends ClosePeriodDto {
  @IsString() @MinLength(3) reason!: string;
}

@Controller('settings')
export class SettingsController {
  constructor(private service: SettingsService) {}

  @Post('edit-password')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  setEditPassword(@Body() dto: EditPasswordDto) {
    return this.service.setEditPassword(dto.password);
  }

  @Post('edit-unlock')
  async unlockEdit(@Body() dto: UnlockSettingsDto) {
    const hash = await this.service.editPasswordHash();
    if (!hash) return { required: false, token: '' };
    const ok = await bcrypt.compare(dto.password, hash);
    if (!ok) throw new BadRequestException('كلمة سر التعديل غير صحيحة');
    return { required: true, token: signEditToken() };
  }

  @Post('unlock')
  unlock(@Body() dto: UnlockSettingsDto) {
    if (!process.env.SETTINGS_PASSWORD) throw new BadRequestException('تعذر فتح الإعدادات');
    if (!settingsPasswordMatches(dto.password)) throw new BadRequestException('كلمة سر الإعدادات غير صحيحة');
    return { token: signSettingsToken() };
  }

  @Get('periods')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  listPeriods() {
    return this.service.listPeriods();
  }

  @Post('periods/close')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  closePeriod(@Body() dto: ClosePeriodDto, @Req() req: { user: { userId: string } }) {
    return this.service.closePeriod(dto.year, dto.month, req.user.userId);
  }

  @Post('periods/reopen')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  reopenPeriod(@Body() dto: ReopenPeriodDto, @Req() req: { user: { userId: string } }) {
    return this.service.reopenPeriod(dto.year, dto.month, dto.reason, req.user.userId);
  }

  @Get()
  @UseGuards(SettingsGateGuard)
  getAll() {
    return this.service.getAll();
  }

  @Post()
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  update(@Body() dto: UpdateSettingsDto) {
    return this.service.updateMany(dto.data);
  }

  @Post('backup')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  backup() {
    return this.service.backup();
  }

  @Get('backups')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  listBackups() {
    return this.service.listBackups();
  }

  @Get('backups/:name')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  readBackup(@Param('name') name: string, @Res() res: Response) {
    const data = this.service.readBackup(name);
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^a-zA-Z0-9._-]/g, '')}"`);
    if (Buffer.isBuffer(data)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.send(data);
    }
    return res.json(data);
  }

  @Post('restore')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  restore(@Body() body: { version?: number; tables?: Record<string, unknown[]> }) {
    return this.service.restore(body);
  }

  @Post('desktop-download')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  requestDesktopDownload(@Body() dto: UnlockSettingsDto) {
    if (!process.env.DESKTOP_DOWNLOAD_PASSWORD) {
      throw new BadRequestException('تحميل الديسكتوب غير مفعّل على السيرفر');
    }
    if (!desktopDownloadPasswordMatches(dto.password)) {
      throw new BadRequestException('كلمة سر التحميل غير صحيحة');
    }
    const externalUrl = this.service.desktopDownloadUrl();
    if (externalUrl) {
      return { mode: 'url' as const, url: externalUrl, fileName: externalUrl.split('/').pop() || 'm5azen-desktop-setup.exe' };
    }
    const local = this.service.resolveDesktopInstaller();
    if (!local) {
      throw new BadRequestException('نسخة الديسكتوب لسه مش مرفوعة على السيرفر');
    }
    return {
      mode: 'token' as const,
      token: signDesktopDownloadToken(local.fileName),
      fileName: local.fileName,
    };
  }

  @Get('desktop-download/file')
  @Roles(Role.ADMIN)
  @UseGuards(SettingsGateGuard)
  downloadDesktopFile(@Query('token') token: string, @Res() res: Response) {
    const checked = verifyDesktopDownloadToken(token);
    if (!checked.ok) throw new BadRequestException('رابط التحميل منتهي أو غير صالح');
    const file = this.service.readDesktopInstaller(checked.fileName);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    return res.send(file.data);
  }
}
