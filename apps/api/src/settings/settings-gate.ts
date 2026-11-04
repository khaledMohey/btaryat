import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

const HEADER = 'x-settings-token';
const TTL_MS = 30 * 60 * 1000;

function secret() {
  return process.env.JWT_SECRET || 'm5azen-dev-secret';
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function settingsPasswordMatches(password: string) {
  const expected = process.env.SETTINGS_PASSWORD || '';
  if (!expected || !password) return false;
  return safeEqual(password, expected);
}

export function desktopDownloadPasswordMatches(password: string) {
  const expected = process.env.DESKTOP_DOWNLOAD_PASSWORD || '';
  if (!expected || !password) return false;
  return safeEqual(password, expected);
}

function signToken(purpose: string) {
  const exp = Date.now() + TTL_MS;
  const body = Buffer.from(JSON.stringify({ purpose, exp })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readToken(token: string | undefined, purpose: string) {
  if (!token || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { purpose?: string; exp?: number };
    return payload.purpose === purpose && typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

export function signSettingsToken() {
  return signToken('settings');
}

export function verifySettingsToken(token?: string) {
  return readToken(token, 'settings');
}

export function signEditToken() {
  return signToken('edit');
}

export function verifyEditToken(token?: string) {
  return readToken(token, 'edit');
}

const DESKTOP_TTL_MS = 2 * 60 * 1000;

export function signDesktopDownloadToken(fileName: string) {
  const exp = Date.now() + DESKTOP_TTL_MS;
  const body = Buffer.from(JSON.stringify({ purpose: 'desktop-download', exp, fileName })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyDesktopDownloadToken(token?: string): { ok: true; fileName: string } | { ok: false } {
  if (!token || !token.includes('.')) return { ok: false };
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return { ok: false };
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      purpose?: string;
      exp?: number;
      fileName?: string;
    };
    if (payload.purpose !== 'desktop-download' || typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
      return { ok: false };
    }
    return { ok: true, fileName: payload.fileName || 'm5azen-desktop-setup.exe' };
  } catch {
    return { ok: false };
  }
}

@Injectable()
export class SettingsGateGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const token = req.headers[HEADER];
    if (!verifySettingsToken(token)) {
      throw new ForbiddenException('أدخل كلمة سر الإعدادات');
    }
    return true;
  }
}
