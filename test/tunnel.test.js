const assert = require('assert');
const {
  extractQuickTunnelUrl,
  getCloudflaredDownloadSpec,
  toPublicWebSocketUrl,
} = require('../dist/tunnel.js');

assert.strictEqual(
  toPublicWebSocketUrl('https://demo.trycloudflare.com'),
  'wss://demo.trycloudflare.com',
);
assert.strictEqual(
  toPublicWebSocketUrl('http://127.0.0.1:31731'),
  'ws://127.0.0.1:31731',
);
assert.strictEqual(
  toPublicWebSocketUrl('wss://rome.example.com/ws'),
  'wss://rome.example.com/ws',
);

assert.strictEqual(
  extractQuickTunnelUrl('Your quick Tunnel has been created! Visit it at https://demo.trycloudflare.com'),
  'https://demo.trycloudflare.com',
);
assert.strictEqual(extractQuickTunnelUrl('no tunnel here'), undefined);

assert.deepStrictEqual(
  getCloudflaredDownloadSpec('win32', 'x64'),
  {
    fileName: 'cloudflared.exe',
    url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  },
);
assert.deepStrictEqual(
  getCloudflaredDownloadSpec('linux', 'arm64'),
  {
    fileName: 'cloudflared',
    url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
  },
);
assert.deepStrictEqual(
  getCloudflaredDownloadSpec('darwin', 'arm64'),
  {
    fileName: 'cloudflared',
    url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
    archiveType: 'tgz',
  },
);

let unsupported = false;
try {
  getCloudflaredDownloadSpec('freebsd', 'x64');
} catch {
  unsupported = true;
}
assert.ok(unsupported, 'unsupported platform should throw');

console.log('PASS: tunnel helper test');
