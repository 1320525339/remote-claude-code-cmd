import fs from 'fs';
import path from 'path';
import { generateToken } from './util';

export interface RomeConfig {
  brokerUrl?: string;
  token?: string;
  channelName?: string;
  directUrl?: string;
  client?: {
    token?: string;
    cmd?: string;
    args?: string[];
  };
  server?: {
    token?: string;
    shell?: string;
    args?: string[];
    workDir?: string;
    publicDirectUrl?: string;
    autoTunnel?: boolean;
    cloudflaredPath?: string;
  };
}

const CONFIG_NAME = 'rome.config.json';

export function getConfigPath(): string {
  return path.resolve(process.cwd(), CONFIG_NAME);
}

export function loadConfig(): RomeConfig {
  const file = getConfigPath();
  if (!fs.existsSync(file)) return {};

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RomeConfig;
  } catch (e: any) {
    throw new Error(`failed to parse ${CONFIG_NAME}: ${e.message}`);
  }
}

export function ensureConfig(): RomeConfig {
  const file = getConfigPath();
  const current = loadConfig();
  const hadStrongRootToken = isStrongToken(current.token);

  const next: RomeConfig = {
    brokerUrl: current.brokerUrl || 'mqtts://broker.emqx.io:8883',
    token: isStrongToken(current.token) ? current.token : generateToken(24),
    channelName: current.channelName || defaultChannelName(),
    directUrl: current.directUrl,
    client: {
      token: isStrongToken(current.client?.token) ? current.client?.token : undefined,
      cmd: current.client?.cmd || (process.platform === 'win32' ? 'cmd.exe' : undefined),
      args: current.client?.args || [],
    },
    server: {
      token: isStrongToken(current.server?.token) ? current.server?.token : undefined,
      shell: current.server?.shell || (process.platform === 'win32' ? 'cmd.exe' : undefined),
      args: current.server?.args || [],
      workDir: current.server?.workDir || '',
      publicDirectUrl: current.server?.publicDirectUrl,
      autoTunnel: current.server?.autoTunnel ?? true,
      cloudflaredPath: current.server?.cloudflaredPath,
    },
  };

  if (!next.client) next.client = {};
  if (!next.server) next.server = {};

  if (!isStrongToken(next.client.token)) next.client.token = next.token;
  if (!isStrongToken(next.server.token)) next.server.token = next.token;

  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  if (!hadStrongRootToken) {
    process.stderr.write(`[rome] generated token and saved config to ${file}\n`);
  }
  return next;
}

export function loadClientConfig(): RomeConfig {
  return loadConfig();
}

export interface ClientConnectionState {
  token: string;
  brokerUrl?: string;
  channelName?: string;
  directUrl?: string;
}

export function saveClientToken(token: string, brokerUrl?: string): void {
  const file = getConfigPath();
  const current = loadConfig();
  const next: RomeConfig = {
    brokerUrl: brokerUrl || current.brokerUrl || 'mqtts://broker.emqx.io:8883',
    token: current.token || token,
    channelName: current.channelName,
    directUrl: current.directUrl,
    client: {
      token,
      cmd: current.client?.cmd || (process.platform === 'win32' ? 'cmd.exe' : undefined),
      args: current.client?.args || [],
    },
    server: {
      token: current.server?.token,
      shell: current.server?.shell || (process.platform === 'win32' ? 'cmd.exe' : undefined),
      args: current.server?.args || [],
      workDir: current.server?.workDir || '',
      publicDirectUrl: current.server?.publicDirectUrl,
      autoTunnel: current.server?.autoTunnel ?? true,
      cloudflaredPath: current.server?.cloudflaredPath,
    },
  };

  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export function saveClientConnection(state: ClientConnectionState): void {
  const file = getConfigPath();
  const current = loadConfig();
  const nextDirectUrl = Object.prototype.hasOwnProperty.call(state, 'directUrl')
    ? state.directUrl
    : current.directUrl;
  const next: RomeConfig = {
    brokerUrl: state.brokerUrl || current.brokerUrl || 'mqtts://broker.emqx.io:8883',
    token: current.token,
    channelName: state.channelName || current.channelName,
    directUrl: nextDirectUrl,
    client: {
      token: state.token,
      cmd: current.client?.cmd || (process.platform === 'win32' ? 'cmd.exe' : undefined),
      args: current.client?.args || [],
    },
    server: {
      token: current.server?.token,
      shell: current.server?.shell || (process.platform === 'win32' ? 'cmd.exe' : undefined),
      args: current.server?.args || [],
      workDir: current.server?.workDir || '',
      publicDirectUrl: current.server?.publicDirectUrl,
      autoTunnel: current.server?.autoTunnel ?? true,
      cloudflaredPath: current.server?.cloudflaredPath,
    },
  };

  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export function isStrongToken(token: string | undefined): token is string {
  return !!token && token.length >= 32 && !/^replace-with-/i.test(token);
}

function defaultChannelName(): string {
  return `${process.env.COMPUTERNAME || process.env.HOSTNAME || 'rome'}-${process.platform}`;
}
