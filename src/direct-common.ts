import { signPayload, verifyPayload } from './auth';

export type DirectFrameType = 'attach' | 'start' | 'stdin' | 'resize' | 'ctrl' | 'stdout' | 'stderr' | 'exit' | 'ready' | 'error';

export interface DirectFrame<T = unknown> {
  type: DirectFrameType;
  payload: T;
}

export interface DirectAttachPayload {
  token: string;
}

export interface DirectReadyPayload {
  brokerUrl: string;
  channelName?: string;
  directUrl?: string;
}

export function sealDirectFrame<T>(token: string, type: DirectFrameType, payload: T): string {
  return JSON.stringify(signPayload(token, { type, payload } satisfies DirectFrame<T>));
}

export function openDirectFrame(token: string, raw: Buffer | string): DirectFrame<unknown> {
  const input = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  return verifyPayload<DirectFrame<unknown>>(token, input);
}
