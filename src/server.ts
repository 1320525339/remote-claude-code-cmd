import mqtt = require('mqtt');
import * as pty from 'node-pty';
import chalk from 'chalk';
import WebSocket, { WebSocketServer } from 'ws';
import { signPayload, verifyPayload } from './auth';
import {
  DirectAttachPayload,
  DirectFrame,
  DirectReadyPayload,
  openDirectFrame,
  sealDirectFrame,
} from './direct-common';
import { getLocalIPs, ts, generateToken } from './util';
import { QuickTunnelHandle, startQuickTunnel } from './tunnel';
import {
  AttachMessage,
  createBridgeTopics,
  randomClientId,
  ResizeMessage,
  StartMessage,
  StatusMessage,
} from './mqtt-common';

export interface ServerOptions {
  brokerUrl: string;
  channelName?: string;
  directPort?: number;
  publicDirectUrl?: string;
  autoTunnel?: boolean;
  cloudflaredPath?: string;
  shell?: string;
  shellArgs?: string[];
  workDir?: string;
  token?: string;
  singleSession: boolean;
}

interface SessionTransport {
  id: string;
  name: 'mqtt' | 'direct';
  sendStdout: (data: string) => void;
  sendStderr: (data: string) => void;
  sendExit: (code: number) => void;
}

export function startServer(opts: ServerOptions): void {
  const token = opts.token ?? generateToken(16);
  const topics = createBridgeTopics(token);
  const channelName = opts.channelName || defaultChannelName();
  const directPort = opts.directPort || 31731;
  const localDirectUrl = buildDirectUrl(getLocalIPs(), directPort);
  const wantsAutoTunnel = opts.autoTunnel !== false && !opts.publicDirectUrl;
  let subscribed = false;
  let directUrl: string | undefined = opts.publicDirectUrl || (wantsAutoTunnel ? undefined : localDirectUrl);
  let ptyProc: pty.IPty | null = null;
  let activeTransport: SessionTransport | null = null;
  let quickTunnel: QuickTunnelHandle | null = null;
  let suppressSingleSessionExit = false;

  const mqttTransport: SessionTransport = {
    id: 'mqtt',
    name: 'mqtt',
    sendStdout: (data) => {
      client.publish(topics.stdout, JSON.stringify(signPayload(token, data)));
    },
    sendStderr: (data) => {
      client.publish(topics.stderr, JSON.stringify(signPayload(token, data)));
    },
    sendExit: (code) => {
      client.publish(topics.exit, JSON.stringify(signPayload(token, { code })));
    },
  };

  const directServer = startDirectServer({
    brokerUrl: opts.brokerUrl,
    channelName,
    directPort,
    token,
    getAdvertisedDirectUrl: () => directUrl,
    onListening: () => {
      log(`[+] direct websocket listening${localDirectUrl ? `: ${localDirectUrl}` : ` on :${directPort}`}`);
      if (subscribed) publishServerStatus({ state: 'online', detail: 'waiting-client' });
    },
    onClientAttached: () => {
      log('[+] direct client attached');
      publishServerStatus({ state: 'online', detail: 'client-attached' });
    },
    onStart: (req, transport) => {
      handleStart(req, transport);
    },
    onStdin: (data, transport) => {
      if (!ownsSession(transport) || !ptyProc) return;
      ptyProc.write(data);
    },
    onResize: (req, transport) => {
      if (!ownsSession(transport) || !ptyProc) return;
      if (req.cols > 0 && req.rows > 0) ptyProc.resize(req.cols, req.rows);
    },
    onCtrl: (action, transport) => {
      if (action !== 'kill' || !ownsSession(transport) || !ptyProc) return;
      try { ptyProc.kill(); } catch { /* */ }
      ptyProc = null;
      activeTransport = null;
      publishServerStatus({ state: 'online' });
    },
    onDisconnect: (transport) => {
      if (!ownsSession(transport) || !ptyProc) return;
      try { ptyProc.kill(); } catch { /* */ }
      ptyProc = null;
      activeTransport = null;
      publishServerStatus({ state: 'online' });
    },
  });

  if (wantsAutoTunnel) {
    log(`[i] starting Cloudflare Quick Tunnel for ws://127.0.0.1:${directPort}`);
    quickTunnel = startQuickTunnel({
      localPort: directPort,
      cloudflaredPath: opts.cloudflaredPath,
      onUrl: (publicUrl) => {
        directUrl = publicUrl;
        log(`[+] quick tunnel ready: ${publicUrl}`);
        if (subscribed) publishServerStatus({ state: 'online', detail: 'waiting-client' });
      },
      onLog: (message) => {
        log(message.replace(/^\[rome\]\s*/, ''));
      },
      onError: (error) => {
        console.error(chalk.yellow(`[server warn] quick tunnel unavailable: ${error.message}`));
        if (subscribed) publishServerStatus({ state: 'online', detail: 'waiting-client' });
      },
    });
  }

  const client = mqtt.connect(opts.brokerUrl, {
    clientId: randomClientId('rome-server'),
    clean: true,
    connectTimeout: 10_000,
    reconnectPeriod: 3_000,
    will: {
      topic: topics.status,
      payload: JSON.stringify(signPayload(token, { state: 'offline' satisfies StatusMessage['state'] })),
      retain: true,
    },
  });

  printBanner({ ...opts, channelName, directPort }, token, {
    localDirectUrl,
    publicDirectUrl: directUrl,
    autoTunnel: wantsAutoTunnel,
  });

  client.on('connect', () => {
    log(`[+] connected to broker ${opts.brokerUrl}`);
    client.subscribe([topics.attach, topics.start, topics.stdin, topics.resize, topics.ctrl], (err?: Error | null) => {
      if (err) {
        console.error(chalk.red(`[server error] subscribe failed: ${err.message}`));
        process.exit(1);
      }
      subscribed = true;
      publishServerStatus({ state: 'online', detail: 'waiting-client' });
      log('[i] waiting for remote client...');
    });
  });

  client.on('message', (topic: Buffer | string, payload: Buffer) => {
    const topicName = topic.toString();
    if (!subscribed) return;

    try {
      if (topicName === topics.attach) {
        const attach = verifyPayload<AttachMessage>(token, payload);
        if (attach.role !== 'client') throw new Error('invalid attach role');
        log('[+] client attached');
        publishServerStatus({ state: 'online', detail: 'client-attached' });
        return;
      }

      if (topicName === topics.start) {
        const req = verifyPayload<StartMessage>(token, payload);
        handleStart(req, mqttTransport);
        return;
      }

      if (topicName === topics.stdin) {
        if (ptyProc && ownsSession(mqttTransport)) ptyProc.write(verifyPayload<string>(token, payload));
        return;
      }

      if (topicName === topics.resize) {
        const req = verifyPayload<ResizeMessage>(token, payload);
        if (ptyProc && ownsSession(mqttTransport) && req.cols > 0 && req.rows > 0) ptyProc.resize(req.cols, req.rows);
        return;
      }

      if (topicName === topics.ctrl) {
        const action = verifyPayload<string>(token, payload);
        if (action === 'kill' && ptyProc && ownsSession(mqttTransport)) {
          try { ptyProc.kill(); } catch { /* */ }
          ptyProc = null;
          activeTransport = null;
          publishServerStatus({ state: 'online' });
        }
      }
    } catch (e: any) {
      client.publish(topics.stderr, JSON.stringify(signPayload(token, `\n[rome error] ${e.message}\n`)));
    }
  });

  client.on('error', (e: Error) => {
    console.error(chalk.red(`[server error] ${e.message}`));
    process.exit(1);
  });

  function ownsSession(transport: SessionTransport): boolean {
    return !!activeTransport && activeTransport.id === transport.id;
  }

  function handleStart(req: StartMessage, transport: SessionTransport) {
    if (ptyProc && activeTransport && activeTransport.id !== transport.id) {
      log(`[i] replacing active ${activeTransport.name} session with new ${transport.name} session`);
      activeTransport.sendStderr('\n[rome] session was taken over by a new client\n');
      stopActiveProcess(true);
    }
    startProcess(req, transport);
  }

  function startProcess(req: StartMessage, transport: SessionTransport) {
    if (ptyProc && ownsSession(transport)) {
      stopActiveProcess(true);
    }
    activeTransport = transport;

    const cmd = req.cmd || opts.shell || defaultShell();
    const args = req.cmd ? (req.args || []) : (opts.shellArgs || []);
    const cols = req.cols || 80;
    const rows = req.rows || 24;
    const workDir = opts.workDir || defaultWorkDir();

    log(`[>] spawn: ${cmd} ${args.join(' ')} (${cols}x${rows}) @ ${workDir}`);
    publishServerStatus({ state: 'busy', detail: cmd });

    try {
      ptyProc = pty.spawn(cmd, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: workDir,
        env: { ...process.env, ...(req.env || {}) } as Record<string, string>,
      });
    } catch (e: any) {
      transport.sendStderr(`\n[rome error] spawn failed: ${e.message}\n`);
      publishServerStatus({ state: 'online' });
      activeTransport = null;
      return;
    }

    const sessionTransport = transport;
    ptyProc.onData((d) => {
      sessionTransport.sendStdout(d);
    });

    ptyProc.onExit(({ exitCode }) => {
      log(`[x] pty exit ${exitCode}`);
      sessionTransport.sendExit(exitCode ?? 0);
      publishServerStatus({ state: 'online' });
      ptyProc = null;
      if (activeTransport?.id === sessionTransport.id) activeTransport = null;
      if (suppressSingleSessionExit) {
        suppressSingleSessionExit = false;
        return;
      }
      if (opts.singleSession) {
        setTimeout(() => process.exit(exitCode ?? 0), 150);
      }
    });
  }

  function stopActiveProcess(restarting = false) {
    if (!ptyProc) return;
    if (restarting) suppressSingleSessionExit = true;
    try { ptyProc.kill(); } catch { /* */ }
    ptyProc = null;
    activeTransport = null;
  }

  function publishServerStatus(status: StatusMessage) {
    publishStatus(client, token, topics.status, {
      ...status,
      channelName,
      directUrl,
    });
  }

  process.on('exit', () => {
    try { quickTunnel?.stop(); } catch { /* */ }
    try { directServer.close(); } catch { /* */ }
  });
}

function publishStatus(client: mqtt.MqttClient, token: string, topic: string, status: StatusMessage) {
  client.publish(topic, JSON.stringify(signPayload(token, status)), { retain: true });
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

function defaultWorkDir(): string {
  return process.cwd();
}

function defaultChannelName(): string {
  return `${process.env.COMPUTERNAME || process.env.HOSTNAME || 'rome'}-${process.platform}`;
}

function log(msg: string) {
  console.log(chalk.gray(`[${ts()}]`) + ' ' + msg);
}

function printBanner(
  opts: ServerOptions,
  token: string,
  directState: { localDirectUrl?: string; publicDirectUrl?: string; autoTunnel: boolean },
) {
  const ips = getLocalIPs();
  const line = '-'.repeat(60);

  console.log();
  console.log(chalk.cyan(line));
  console.log(chalk.cyan.bold('  Rome Server  ') + chalk.gray('MQTT relay mode'));
  console.log(chalk.cyan(line));
  console.log();
  console.log(chalk.white('  Local IPs   : ') + chalk.yellow(ips.join(', ') || '(none)'));
  console.log(chalk.white('  Broker      : ') + chalk.yellow(opts.brokerUrl));
  console.log(chalk.white('  Channel     : ') + chalk.yellow(opts.channelName || 'rome'));
  console.log(chalk.white('  Local WS    : ') + chalk.yellow(directState.localDirectUrl || `(listen on :${opts.directPort || 31731}, no IPv4 detected)`));
  console.log(chalk.white('  Public WS   : ') + chalk.yellow(directState.publicDirectUrl || (directState.autoTunnel ? 'auto quick tunnel pending...' : '(not configured)')));
  console.log(chalk.white('  Shell       : ') + chalk.yellow(opts.shell || defaultShell()));
  console.log(chalk.white('  Work Dir    : ') + chalk.yellow(opts.workDir || defaultWorkDir()));
  console.log(chalk.white('  Token       : ') + chalk.green.bold(token));
  console.log();
  console.log(chalk.gray('  server is waiting for client attach using the same broker/token'));
  console.log();
}

function startDirectServer(opts: {
  brokerUrl: string;
  channelName: string;
  directPort?: number;
  token: string;
  getAdvertisedDirectUrl: () => string | undefined;
  onListening: () => void;
  onClientAttached: () => void;
  onStart: (req: StartMessage, transport: SessionTransport) => void;
  onStdin: (data: string, transport: SessionTransport) => void;
  onResize: (req: ResizeMessage, transport: SessionTransport) => void;
  onCtrl: (action: string, transport: SessionTransport) => void;
  onDisconnect: (transport: SessionTransport) => void;
}): WebSocketServer {
  const directPort = opts.directPort || 31731;
  const server = new WebSocketServer({ host: '0.0.0.0', port: directPort });

  server.on('listening', () => {
    opts.onListening();
  });

  server.on('connection', (socket) => {
    const transport: SessionTransport = {
      id: `direct-${Math.random().toString(36).slice(2, 10)}`,
      name: 'direct',
      sendStdout: (data) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(sealDirectFrame(opts.token, 'stdout', data));
      },
      sendStderr: (data) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(sealDirectFrame(opts.token, 'stderr', data));
      },
      sendExit: (code) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(sealDirectFrame(opts.token, 'exit', { code }));
      },
    };
    let attached = false;

    socket.on('message', (raw) => {
      try {
        const frame = openDirectFrame(opts.token, raw.toString());
        if (!attached) {
          if (frame.type !== 'attach') throw new Error('invalid direct frame type');

          const payload = frame.payload as DirectAttachPayload;
          if (!payload || payload.token !== opts.token) throw new Error('invalid direct token');

          attached = true;
          opts.onClientAttached();
          const ready: DirectFrame<DirectReadyPayload> = {
            type: 'ready',
            payload: {
              brokerUrl: opts.brokerUrl,
              channelName: opts.channelName,
              directUrl: opts.getAdvertisedDirectUrl(),
            },
          };
          socket.send(sealDirectFrame(opts.token, ready.type, ready.payload));
          return;
        }

        if (frame.type === 'start') {
          opts.onStart(frame.payload as StartMessage, transport);
          return;
        }

        if (frame.type === 'stdin') {
          opts.onStdin(String(frame.payload || ''), transport);
          return;
        }

        if (frame.type === 'resize') {
          opts.onResize(frame.payload as ResizeMessage, transport);
          return;
        }

        if (frame.type === 'ctrl') {
          opts.onCtrl(String(frame.payload || ''), transport);
          return;
        }

        throw new Error(`unsupported direct frame: ${frame.type}`);
      } catch (e: any) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(sealDirectFrame(opts.token, 'error', e.message || 'direct attach failed'));
        }
      }
    });

    socket.on('close', () => {
      if (attached) opts.onDisconnect(transport);
    });
  });

  server.on('error', (e: Error) => {
    console.error(chalk.yellow(`[server warn] direct websocket failed: ${e.message}`));
  });

  return server;
}

function buildDirectUrl(ips: string[], port: number): string | undefined {
  const host = ips[0];
  if (!host) return undefined;
  return `ws://${host}:${port}`;
}
