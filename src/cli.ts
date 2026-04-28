#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import readline from 'readline';
import { startServer } from './server';
import { startClient } from './client';
import { ensureConfig, getConfigPath, isStrongToken, loadClientConfig, saveClientConnection, saveClientToken } from './config';

const DEFAULT_BROKER = 'mqtts://broker.emqx.io:8883';
const DEFAULT_REMOTE_CMD = process.platform === 'win32' ? 'cmd.exe' : undefined;

const program = new Command();
program
  .name('rome')
  .description('Remote CLI bridge over public MQTT relay')
  .version('0.2.0');

program
  .command('serve')
  .description(`Start server side. Defaults are loaded from ${getConfigPath()}`)
  .option('-b, --broker <url>', 'MQTT broker URL')
  .option('--direct-port <port>', 'direct WebSocket port', (value) => Number(value))
  .option('--public-direct-url <url>', 'public direct WebSocket URL for clients, e.g. wss://rome.example.com/ws')
  .option('--cloudflared-path <path>', 'custom cloudflared executable path')
  .option('--no-auto-tunnel', 'disable automatic Cloudflare Quick Tunnel')
  .option('-s, --shell <cmd>', 'default command to run when client does not send one')
  .option('-a, --args <args...>', 'arguments to pass to the default shell command')
  .option('-d, --dir <path>', 'working directory for the remote command')
  .option('-t, --token <token>', 'shared token used to derive the relay topic')
  .option('--keep', 'keep running after client disconnects', false)
  .action((opts) => {
    const config = ensureConfig();
    const brokerUrl = opts.broker || config.brokerUrl || DEFAULT_BROKER;
    const token = opts.token || config.token || config.server?.token;

    startServer({
      brokerUrl,
      channelName: config.channelName,
      directPort: Number.isFinite(opts.directPort) ? opts.directPort : undefined,
      publicDirectUrl: opts.publicDirectUrl || config.server?.publicDirectUrl,
      autoTunnel: opts.autoTunnel ?? config.server?.autoTunnel ?? true,
      cloudflaredPath: opts.cloudflaredPath || config.server?.cloudflaredPath,
      shell: opts.shell || config.server?.shell,
      shellArgs: opts.args || config.server?.args,
      workDir: opts.dir || config.server?.workDir,
      token,
      singleSession: !opts.keep,
    });
  });

program
  .command('connect')
  .description(`Auto-connect to the remote server using ${getConfigPath()}`)
  .option('-b, --broker <url>', 'MQTT broker URL')
  .option('-c, --cmd <cmd>', 'command to start on the remote server')
  .option('-a, --args <args...>', 'arguments for the remote command')
  .option('-t, --token <token>', 'shared token used to derive the relay topic')
  .action(async (opts) => {
    const config = loadClientConfig();
    const brokerUrl = opts.broker || config.brokerUrl || DEFAULT_BROKER;
    const token = await resolveClientToken({
      overrideToken: opts.token,
      clientToken: config.client?.token,
      rootToken: config.token,
      promptQuestion: '请输入共享 token: ',
    });

    await startClient({
      brokerUrl,
      channelName: config.channelName,
      directUrl: config.directUrl,
      token,
      cmd: opts.cmd || config.client?.cmd || DEFAULT_REMOTE_CMD,
      args: opts.args || config.client?.args,
      onResolved: (state) => {
        saveClientConnection(state);
      },
    });
  });

program
  .command('pair')
  .description('Prompt for token if needed, save it locally, then connect')
  .option('-b, --broker <url>', 'MQTT broker URL')
  .option('-c, --cmd <cmd>', 'command to start on the remote server')
  .option('-a, --args <args...>', 'arguments for the remote command')
  .option('-t, --token <token>', 'shared token used to derive the relay topic')
  .action(async (opts) => {
    const config = loadClientConfig();
    const brokerUrl = opts.broker || config.brokerUrl || DEFAULT_BROKER;
    const token = await resolveClientToken({
      overrideToken: opts.token,
      clientToken: config.client?.token,
      rootToken: config.token,
      promptQuestion: '请输入服务端显示的 token: ',
    });

    saveClientToken(token, brokerUrl);

    await startClient({
      brokerUrl,
      channelName: config.channelName,
      directUrl: config.directUrl,
      token,
      cmd: opts.cmd || config.client?.cmd || DEFAULT_REMOTE_CMD,
      args: opts.args || config.client?.args,
      onResolved: (state) => {
        saveClientConnection(state);
      },
    });
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(chalk.red(`fatal: ${e?.message || e}`));
  process.exit(1);
});

function promptToken(question = '请输入共享 token: '): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolveClientToken(opts: {
  overrideToken?: string;
  clientToken?: string;
  rootToken?: string;
  promptQuestion: string;
}): Promise<string> {
  if (opts.overrideToken !== undefined) {
    const token = opts.overrideToken.trim();
    if (!isStrongToken(token)) {
      throw new Error('token 必须至少 32 个字符，且不能使用示例占位值');
    }
    return token;
  }

  if (isStrongToken(opts.clientToken)) return opts.clientToken;
  if (isStrongToken(opts.rootToken)) return opts.rootToken;

  while (true) {
    const token = await promptToken(opts.promptQuestion);
    if (isStrongToken(token)) return token;
    process.stderr.write(chalk.yellow('[rome] token 无效，请输入服务端生成的完整 token（至少 32 个字符）。\n'));
  }
}
