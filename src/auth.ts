import crypto from 'crypto';

const MAX_SKEW_MS = 60_000;

export interface SignedEnvelope<T> {
  iv: string;
  tag: string;
  data: string;
}

export function signPayload<T>(token: string, body: T): SignedEnvelope<T> {
  const payload = JSON.stringify({
    ts: Date.now(),
    nonce: crypto.randomBytes(12).toString('hex'),
    body,
  });
  const key = deriveKey(token);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('base64'),
  };
}

export function verifyPayload<T>(token: string, raw: Buffer): T {
  const msg = JSON.parse(raw.toString('utf8')) as SignedEnvelope<T>;
  if (!msg || typeof msg.iv !== 'string' || typeof msg.tag !== 'string' || typeof msg.data !== 'string') {
    throw new Error('invalid sealed payload');
  }

  const key = deriveKey(token);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(msg.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(msg.tag, 'hex'));

  let decoded: { ts: number; nonce: string; body: T };
  const ts = Date.now();
  try {
    const plain = Buffer.concat([
      decipher.update(Buffer.from(msg.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    decoded = JSON.parse(plain) as { ts: number; nonce: string; body: T };
  } catch {
    throw new Error('bad sealed payload');
  }

  if (typeof decoded.ts !== 'number' || typeof decoded.nonce !== 'string') {
    throw new Error('invalid sealed payload');
  }

  if (Math.abs(ts - decoded.ts) > MAX_SKEW_MS) {
    throw new Error('stale sealed payload');
  }

  return decoded.body;
}

function deriveKey(token: string): Buffer {
  return crypto.createHash('sha256').update(token).digest();
}
