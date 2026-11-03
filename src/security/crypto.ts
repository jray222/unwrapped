import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import { config } from '../config.js';

authenticator.options = { window: 1 };

export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const keyBuffer = Buffer.from(keyHex, 'hex');
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  if (keyBuffer.length !== derivedKey.length) return false;
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

export function generateRecoveryCodes(count = 8): { rawCodes: string[]; hashedCodes: string[] } {
  const rawCodes: string[] = [];
  const hashedCodes: string[] = [];
  for (let i = 0; i < count; i++) {
    const part1 = crypto.randomBytes(3).toString('hex').toUpperCase();
    const part2 = crypto.randomBytes(3).toString('hex').toUpperCase();
    const code = `${part1}-${part2}`;
    rawCodes.push(code);
    hashedCodes.push(hashToken(code.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  }
  return { rawCodes, hashedCodes };
}

export function normalizeRecoveryCodeHash(rawCode: string): string {
  return hashToken(rawCode.toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function generateTotpUri(email: string, secret: string): string {
  return authenticator.keyuri(email, config.rpName, secret);
}

export function verifyTotpCode(code: string, secret: string): boolean {
  if (!code || !secret) return false;
  const cleaned = code.replace(/\s+/g, '');
  return authenticator.check(cleaned, secret);
}

export function generateTotpCode(secret: string): string {
  return authenticator.generate(secret);
}

export function escapeHtml(unsafe: string): string {
  return String(unsafe ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
