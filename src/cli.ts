#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { startServer } from './server';
import { startClient } from './client';
import { ensureConfig, getConfigPath } from './config';

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
  .action((opts) => {
    const config = ensureConfig();
    const brokerUrl = opts.broker || config.brokerUrl || DEFAULT_BROKER;
    const token = opts.token || config.token || config.client?.token;

    startClient({
      brokerUrl,
      token,
      cmd: opts.cmd || config.client?.cmd || DEFAULT_REMOTE_CMD,
      args: opts.args || config.client?.args,
    });
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(chalk.red(`fatal: ${e?.message || e}`));
  process.exit(1);
});
