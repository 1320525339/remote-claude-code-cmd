import mqtt = require('mqtt');
import chalk from 'chalk';
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
  token: string;
  cmd?: string;
  args?: string[];
}

export function startClient(opts: ClientOptions): void {
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

  client.on('connect', () => {
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
        serverOnline = status.state !== 'offline';
        if (status.state === 'online' && status.detail === 'client-attached' && !sessionStarted) {
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
