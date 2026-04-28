import mqtt = require('mqtt');
import * as pty from 'node-pty';
import chalk from 'chalk';
import { signPayload, verifyPayload } from './auth';
import { getLocalIPs, ts, generateToken } from './util';
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
  shell?: string;
  shellArgs?: string[];
  workDir?: string;
  token?: string;
  singleSession: boolean;
}

export function startServer(opts: ServerOptions): void {
  const token = opts.token ?? generateToken(16);
  const topics = createBridgeTopics(token);
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

  let ptyProc: pty.IPty | null = null;
  let subscribed = false;

  printBanner(opts, token);

  client.on('connect', () => {
    log(`[+] connected to broker ${opts.brokerUrl}`);
    client.subscribe([topics.attach, topics.start, topics.stdin, topics.resize, topics.ctrl], (err?: Error | null) => {
      if (err) {
        console.error(chalk.red(`[server error] subscribe failed: ${err.message}`));
        process.exit(1);
      }
      subscribed = true;
      publishStatus(client, token, topics.status, { state: 'online', detail: 'waiting-client' });
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
        publishStatus(client, token, topics.status, { state: 'online', detail: 'client-attached' });
        return;
      }

      if (topicName === topics.start) {
        const req = verifyPayload<StartMessage>(token, payload);
        startProcess(req);
        return;
      }

      if (topicName === topics.stdin) {
        if (ptyProc) ptyProc.write(verifyPayload<string>(token, payload));
        return;
      }

      if (topicName === topics.resize) {
        const req = verifyPayload<ResizeMessage>(token, payload);
        if (ptyProc && req.cols > 0 && req.rows > 0) ptyProc.resize(req.cols, req.rows);
        return;
      }

      if (topicName === topics.ctrl) {
        const action = verifyPayload<string>(token, payload);
        if (action === 'kill' && ptyProc) {
          try { ptyProc.kill(); } catch { /* */ }
          ptyProc = null;
          publishStatus(client, token, topics.status, { state: 'online' });
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

  function startProcess(req: StartMessage) {
    if (ptyProc) {
      try { ptyProc.kill(); } catch { /* */ }
      ptyProc = null;
    }

    const cmd = req.cmd || opts.shell || defaultShell();
    const args = req.cmd ? (req.args || []) : (opts.shellArgs || []);
    const cols = req.cols || 80;
    const rows = req.rows || 24;
    const workDir = opts.workDir || defaultWorkDir();

    log(`[>] spawn: ${cmd} ${args.join(' ')} (${cols}x${rows}) @ ${workDir}`);
    publishStatus(client, token, topics.status, { state: 'busy', detail: cmd });

    try {
      ptyProc = pty.spawn(cmd, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: workDir,
        env: { ...process.env, ...(req.env || {}) } as Record<string, string>,
      });
    } catch (e: any) {
      client.publish(topics.stderr, JSON.stringify(signPayload(token, `\n[rome error] spawn failed: ${e.message}\n`)));
      publishStatus(client, token, topics.status, { state: 'online' });
      return;
    }

    ptyProc.onData((d) => {
      client.publish(topics.stdout, JSON.stringify(signPayload(token, d)));
    });

    ptyProc.onExit(({ exitCode }) => {
      log(`[x] pty exit ${exitCode}`);
      client.publish(topics.exit, JSON.stringify(signPayload(token, { code: exitCode ?? 0 })));
      publishStatus(client, token, topics.status, { state: 'online' });
      ptyProc = null;
      if (opts.singleSession) {
        setTimeout(() => process.exit(exitCode ?? 0), 150);
      }
    });
  }
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

function log(msg: string) {
  console.log(chalk.gray(`[${ts()}]`) + ' ' + msg);
}

function printBanner(opts: ServerOptions, token: string) {
  const ips = getLocalIPs();
  const line = '-'.repeat(60);

  console.log();
  console.log(chalk.cyan(line));
  console.log(chalk.cyan.bold('  Rome Server  ') + chalk.gray('MQTT relay mode'));
  console.log(chalk.cyan(line));
  console.log();
  console.log(chalk.white('  Local IPs   : ') + chalk.yellow(ips.join(', ') || '(none)'));
  console.log(chalk.white('  Broker      : ') + chalk.yellow(opts.brokerUrl));
  console.log(chalk.white('  Shell       : ') + chalk.yellow(opts.shell || defaultShell()));
  console.log(chalk.white('  Work Dir    : ') + chalk.yellow(opts.workDir || defaultWorkDir()));
  console.log(chalk.white('  Token       : ') + chalk.green.bold(token));
  console.log();
  console.log(chalk.gray('  server is waiting for client attach using the same broker/token'));
  console.log();
}
