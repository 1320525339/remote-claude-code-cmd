import * as crypto from 'crypto';
import * as os from 'os';

export function generateToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function getLocalIPs(): string[] {
  const ifaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) ips.push(info.address);
    }
  }
  return ips;
}

export function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
