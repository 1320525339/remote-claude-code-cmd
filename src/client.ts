import mqtt = require('mqtt');
import chalk from 'chalk';
import WebSocket from 'ws';
import {
  DirectAttachPayload,
  DirectFrame,
  DirectReadyPayload,
  openDirectFrame,
  sealDirectFrame,
} from './direct-common';
import { signPayload, verifyPayload } from './auth';
import {
  AttachMessage,
  createBridgeTopics,
  ExitMessage,
  randomClientId,
  ResizeMessage,
  StartMessage,
  StatusMessage,
} from './mqtt-common';

export interface ClientOptions {
  brokerUrl: string;
  channelName?: string;
  directUrl?: string;
  token: string;
  cmd?: string;
  args?: string[];
  onResolved?: (state: ClientResolvedState) => void;
}

export interface ClientResolvedState {
  token: string;
  brokerUrl: string;
  channelName?: string;
  directUrl?: string;
}

export async function startClient(opts: ClientOptions): Promise<void> {
  const discoverDirectUrlFirst = shouldDiscoverDirectUrlFirst(opts.directUrl);
  if (opts.directUrl && !discoverDirectUrlFirst) {
    try {
      await startDirectClient(opts);
      return;
    } catch (e: any) {
      opts.onResolved?.({
        token: opts.token,
        brokerUrl: opts.brokerUrl,
        channelName: opts.channelName,
        directUrl: undefined,
      });
      process.stderr.write(chalk.yellow(`[rome] 直连失败，回退 MQTT: ${e.message}\n`));
    }
  }

  startMqttClient(opts, { discoverDirectUrlFirst });
}

async function startDirectClient(opts: ClientOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    let started = false;
    let exitCode = 0;
    let ready = false;
    let resolved = false;
    let resolvedChannelName = opts.channelName;
    let resolvedDirectUrl = opts.directUrl;
    const ws = new WebSocket(opts.directUrl as string);

    const finishResolve = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    const finishReject = (err: Error) => {
      if (resolved) return;
      resolved = true;
      try { ws.terminate(); } catch { /* */ }
      reject(err);
    };

    const sendFrame = <T>(type: DirectFrame<T>['type'], payload: T) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(sealDirectFrame(opts.token, type, payload));
    };

    const sendStart = () => {
      const cols = (stdout as any).columns || 80;
      const rows = (stdout as any).rows || 24;
      const msg: StartMessage = {
        cmd: opts.cmd || '',
        args: opts.args || [],
        cols,
        rows,
      };
      sendFrame('start', msg);
      setupTty();
    };

    const sendResize = () => {
      const cols = (stdout as any).columns || 80;
      const rows = (stdout as any).rows || 24;
      const msg: ResizeMessage = { cols, rows };
      sendFrame('resize', msg);
    };

    const restoreTty = () => {
      try {
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        stdin.pause();
      } catch { /* */ }
    };

    const setupTty = () => {
      if (started) return;
      started = true;

      if (stdin.isTTY) {
        stdin.setRawMode(true);
        stdin.resume();
      }

      stdin.on('data', onStdin);
      if (stdout.isTTY) process.on('SIGWINCH' as any, sendResize);
    };

    const cleanup = () => {
      restoreTty();
      stdin.off('data', onStdin);
      if (stdout.isTTY) process.off('SIGWINCH' as any, sendResize);
    };

    const onStdin = (chunk: Buffer) => {
      sendFrame('stdin', chunk.toString('utf8'));
    };

    process.on('SIGINT', () => {
      if (ready) sendFrame('ctrl', 'kill');
      cleanup();
      process.exit(130);
    });

    process.on('SIGTERM', () => {
      cleanup();
      process.exit(exitCode);
    });

    ws.once('open', () => {
      process.stderr.write(chalk.gray(`[rome] 尝试直连: ${opts.directUrl}\n`));
      ws.send(sealDirectFrame<DirectAttachPayload>(opts.token, 'attach', { token: opts.token }));
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const frame = openDirectFrame(opts.token, raw.toString());
        if (frame.type === 'ready') {
          const readyPayload = frame.payload as DirectReadyPayload;
          ready = true;
          resolvedChannelName = readyPayload.channelName || resolvedChannelName;
          resolvedDirectUrl = readyPayload.directUrl || resolvedDirectUrl;
          opts.onResolved?.({
            token: opts.token,
            brokerUrl: readyPayload.brokerUrl || opts.brokerUrl,
            channelName: resolvedChannelName,
            directUrl: resolvedDirectUrl,
          });
          process.stderr.write(chalk.gray(`[rome] 已直连通道: ${resolvedChannelName || 'rome'}\n`));
          sendStart();
          finishResolve();
          return;
        }

        if (!ready) {
          if (frame.type === 'error') {
            finishReject(new Error(String(frame.payload || 'direct attach rejected')));
            return;
          }
          finishReject(new Error('direct attach not ready'));
          return;
        }

        if (frame.type === 'stdout') {
          stdout.write(String(frame.payload || ''));
          return;
        }

        if (frame.type === 'stderr') {
          process.stderr.write(String(frame.payload || ''));
          return;
        }

        if (frame.type === 'exit') {
          const payload = (frame.payload || {}) as ExitMessage;
          exitCode = payload.code ?? 0;
          cleanup();
          try { ws.close(); } catch { /* */ }
          return;
        }

        if (frame.type === 'error') {
          process.stderr.write(chalk.red(`[rome] ${String(frame.payload || 'direct session error')}\n`));
        }
      } catch (e: any) {
        if (!ready) {
          finishReject(new Error(`invalid direct frame: ${e.message}`));
          return;
        }
        process.stderr.write(chalk.red(`[rome] invalid direct frame: ${e.message}\n`));
      }
    });

    ws.once('error', (e: Error) => {
      if (!ready) {
        finishReject(e);
        return;
      }
      cleanup();
      process.stderr.write(chalk.red(`[rome] direct connection error: ${e.message}\n`));
      process.exit(1);
    });

    ws.once('close', () => {
      if (!ready) {
        finishReject(new Error('direct socket closed'));
        return;
      }
      cleanup();
      process.exit(exitCode);
    });
  });
}

function startMqttClient(opts: ClientOptions, behavior?: { discoverDirectUrlFirst?: boolean }): void {
  const topics = createBridgeTopics(opts.token);
  const client = mqtt.connect(opts.brokerUrl, {
    clientId: randomClientId('rome-client'),
    clean: true,
    connectTimeout: 10_000,
    reconnectPeriod: 3_000,
  });

  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  let started = false;
  let exitCode = 0;
  let serverOnline = false;
  let sessionStarted = false;
  let savedConnection = false;
  let resolvedChannelName = opts.channelName;
  let resolvedDirectUrl = opts.directUrl;
  let upgradingToDirect = false;
  let attemptedDirectUpgrade = false;

  client.on('connect', () => {
    process.stderr.write(chalk.gray(`[rome] 正在连接通道: ${resolvedChannelName || 'rome'}\n`));
    client.subscribe([topics.stdout, topics.stderr, topics.exit, topics.status], (err?: Error | null) => {
      if (err) {
        process.stderr.write(chalk.red(`[rome] subscribe error: ${err.message}\n`));
        process.exit(1);
      }

      client.publish(topics.attach, JSON.stringify(signPayload<AttachMessage>(opts.token, { role: 'client' })));
    });
  });

  client.on('message', (topic: Buffer | string, payload: Buffer) => {
    const topicName = topic.toString();
    if (topicName === topics.stdout) {
      stdout.write(verifyPayload<string>(opts.token, payload));
      return;
    }

    if (topicName === topics.stderr) {
      process.stderr.write(verifyPayload<string>(opts.token, payload));
      return;
    }

    if (topicName === topics.exit) {
      try {
        const p = verifyPayload<ExitMessage>(opts.token, payload);
        exitCode = p.code ?? 0;
      } catch {
        exitCode = 0;
      }
      sessionStarted = false;
      return;
    }

    if (topicName === topics.status) {
      try {
        const status = verifyPayload<StatusMessage>(opts.token, payload);
        if (status.channelName) resolvedChannelName = status.channelName;
        resolvedDirectUrl = status.directUrl;
        if (status.channelName || Object.prototype.hasOwnProperty.call(status, 'directUrl')) {
          opts.onResolved?.({
            token: opts.token,
            brokerUrl: opts.brokerUrl,
            channelName: resolvedChannelName,
            directUrl: resolvedDirectUrl,
          });
        }
        serverOnline = status.state !== 'offline';
        if (status.detail === 'client-attached' && !savedConnection) {
          savedConnection = true;
          process.stderr.write(chalk.gray(`[rome] 已连接通道: ${resolvedChannelName || 'rome'}\n`));
          opts.onResolved?.({
            token: opts.token,
            brokerUrl: opts.brokerUrl,
            channelName: resolvedChannelName,
            directUrl: resolvedDirectUrl,
          });
        }
        if (status.state === 'online' && status.detail === 'client-attached' && !sessionStarted) {
          if (behavior?.discoverDirectUrlFirst && !attemptedDirectUpgrade && !upgradingToDirect && isUsableDirectUrl(resolvedDirectUrl)) {
            void attemptDirectUpgrade();
            return;
          }
          sendStart();
        }
      } catch {
        serverOnline = true;
      }
    }
  });

  client.on('error', (e: Error) => {
    restoreTty();
    process.stderr.write(chalk.red(`[rome] connection error: ${e.message}\n`));
    process.exit(1);
  });

  const sendStart = () => {
    if (sessionStarted) return;
    const cols = (stdout as any).columns || 80;
    const rows = (stdout as any).rows || 24;
    const msg: StartMessage = {
      cmd: opts.cmd || '',
      args: opts.args || [],
      cols,
      rows,
    };
    client.publish(topics.start, JSON.stringify(signPayload(opts.token, msg)));
    sessionStarted = true;
    setupTty();
  };

  const attemptDirectUpgrade = async () => {
    if (!resolvedDirectUrl || !isUsableDirectUrl(resolvedDirectUrl)) {
      sendStart();
      return;
    }

    upgradingToDirect = true;
    attemptedDirectUpgrade = true;
    process.stderr.write(chalk.gray(`[rome] 已获取最新地址，升级到直连: ${resolvedDirectUrl}\n`));

    try {
      await startDirectClient({
        ...opts,
        channelName: resolvedChannelName,
        directUrl: resolvedDirectUrl,
      });
      client.end(true);
      return;
    } catch (e: any) {
      process.stderr.write(chalk.yellow(`[rome] 最新直连失败，继续使用 MQTT: ${e.message}\n`));
      upgradingToDirect = false;
      sendStart();
    }
  };

  const setupTty = () => {
    if (started) return;
    started = true;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
    }

    stdin.on('data', (chunk: Buffer) => {
      client.publish(topics.stdin, JSON.stringify(signPayload(opts.token, chunk.toString('utf8'))));
    });

    if (stdout.isTTY) {
      process.on('SIGWINCH' as any, sendResize);
    }
  };

  const sendResize = () => {
    const cols = (stdout as any).columns || 80;
    const rows = (stdout as any).rows || 24;
    const msg: ResizeMessage = { cols, rows };
    client.publish(topics.resize, JSON.stringify(signPayload(opts.token, msg)));
  };

  const restoreTty = () => {
    try {
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    } catch { /* */ }
  };

  process.on('SIGINT', () => {
    if (serverOnline) client.publish(topics.ctrl, JSON.stringify(signPayload(opts.token, 'kill')));
    restoreTty();
    process.exit(130);
  });

  process.on('SIGTERM', () => {
    restoreTty();
    process.exit(exitCode);
  });
}

function shouldDiscoverDirectUrlFirst(directUrl?: string): boolean {
  if (!directUrl) return false;
  try {
    return /\.trycloudflare\.com$/i.test(new URL(directUrl).hostname);
  } catch {
    return false;
  }
}

function isUsableDirectUrl(directUrl?: string): boolean {
  return !!directUrl && /^wss?:\/\//i.test(directUrl);
}
