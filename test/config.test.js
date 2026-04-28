const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureConfig, isStrongToken, loadConfig, saveClientConnection, saveClientToken } = require('../dist/config.js');

function topicKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
}

const token = '0123456789abcdef0123456789abcdef';
const key = topicKey(token);

assert.strictEqual(key.length, 24);
assert.ok(/^[0-9a-f]+$/.test(key));
assert.notStrictEqual(topicKey(token), topicKey(token + 'x'));
assert.strictEqual(isStrongToken(token), true);
assert.strictEqual(isStrongToken('replace-with-a-random-32-plus-char-token'), false);
assert.strictEqual(isStrongToken('short-token'), false);

const prevCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rome-config-'));

try {
  process.chdir(tempDir);

  saveClientConnection({
    token,
    brokerUrl: 'mqtts://broker.example.test:8883',
    channelName: 'server-win11',
    directUrl: 'ws://192.168.1.10:31731',
  });

  let saved = loadConfig();
  assert.strictEqual(saved.channelName, 'server-win11');
  assert.strictEqual(saved.directUrl, 'ws://192.168.1.10:31731');
  assert.strictEqual(saved.client.token, token);

  fs.writeFileSync(path.join(tempDir, 'rome.config.json'), JSON.stringify({
    brokerUrl: 'mqtts://broker.example.test:8883',
    client: {
      cmd: 'cmd.exe',
      args: [],
    },
    server: {
      args: [],
      workDir: '',
    },
  }, null, 2) + '\n', 'utf8');

  saveClientConnection({
    token,
    brokerUrl: 'mqtts://broker.example.test:8883',
  });

  saved = loadConfig();
  assert.strictEqual(saved.channelName, undefined);
  assert.strictEqual(saved.directUrl, undefined);

  fs.writeFileSync(path.join(tempDir, 'rome.config.json'), JSON.stringify({
    brokerUrl: 'mqtts://broker.example.test:8883',
    server: {
      publicDirectUrl: 'wss://rome.example.com/ws',
    },
  }, null, 2) + '\n', 'utf8');

  saved = ensureConfig();
  assert.strictEqual(saved.server.publicDirectUrl, 'wss://rome.example.com/ws');
  assert.strictEqual(saved.server.autoTunnel, true);

  saveClientConnection({
    token,
    brokerUrl: 'mqtts://broker.example.test:8883',
    channelName: 'server-prod',
    directUrl: 'wss://rome.example.com/ws',
  });

  saved = loadConfig();
  assert.strictEqual(saved.server.publicDirectUrl, 'wss://rome.example.com/ws');
  assert.strictEqual(saved.server.autoTunnel, true);

  saveClientConnection({
    token,
    brokerUrl: 'mqtts://broker.example.test:8883',
    channelName: 'server-prod',
    directUrl: undefined,
  });

  saved = loadConfig();
  assert.strictEqual(saved.directUrl, undefined);
  assert.strictEqual(saved.server.publicDirectUrl, 'wss://rome.example.com/ws');
  assert.strictEqual(saved.server.autoTunnel, true);

  saveClientToken(token, 'mqtts://broker.example.test:8883');
  saved = loadConfig();
  assert.strictEqual(saved.client.token, token);
  assert.strictEqual(saved.server.publicDirectUrl, 'wss://rome.example.com/ws');
  assert.strictEqual(saved.server.autoTunnel, true);
} finally {
  process.chdir(prevCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('PASS: config/topic derivation and client persistence test');
