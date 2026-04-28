import crypto from 'crypto';

export interface MqttBridgeConfig {
  brokerUrl: string;
  token: string;
}

export interface BridgeTopics {
  attach: string;
  start: string;
  stdin: string;
  resize: string;
  ctrl: string;
  stdout: string;
  stderr: string;
  exit: string;
  status: string;
}

export interface StartMessage {
  cmd: string;
  args: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface ResizeMessage {
  cols: number;
  rows: number;
}

export interface ExitMessage {
  code: number;
}

export interface StatusMessage {
  state: 'online' | 'busy' | 'offline';
  detail?: string;
}

export interface AttachMessage {
  role: 'client';
}

export function createBridgeTopics(token: string): BridgeTopics {
  const key = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  const base = `rome/${key}`;

  return {
    attach: `${base}/up/attach`,
    start: `${base}/up/start`,
    stdin: `${base}/up/stdin`,
    resize: `${base}/up/resize`,
    ctrl: `${base}/up/ctrl`,
    stdout: `${base}/down/stdout`,
    stderr: `${base}/down/stderr`,
    exit: `${base}/down/exit`,
    status: `${base}/down/status`,
  };
}

export function randomClientId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
