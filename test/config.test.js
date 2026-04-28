const assert = require('assert');
const crypto = require('crypto');

function topicKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
}

const token = '0123456789abcdef0123456789abcdef';
const key = topicKey(token);

assert.strictEqual(key.length, 24);
assert.ok(/^[0-9a-f]+$/.test(key));
assert.notStrictEqual(topicKey(token), topicKey(token + 'x'));

console.log('PASS: config/topic derivation test');
