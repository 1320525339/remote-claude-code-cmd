const assert = require('assert');
const { signPayload, verifyPayload } = require('../dist/auth.js');

const token = '0123456789abcdef0123456789abcdef';
const body = { hello: 'world' };

const sealed = signPayload(token, body);
const raw = Buffer.from(JSON.stringify(sealed), 'utf8');

assert.deepStrictEqual(verifyPayload(token, raw), body);
assert.ok(!JSON.stringify(sealed).includes('world'));

const tampered = {
  ...sealed,
  data: sealed.data.slice(0, -2) + 'aa',
};

let threw = false;
try {
  verifyPayload(token, Buffer.from(JSON.stringify(tampered), 'utf8'));
} catch {
  threw = true;
}
assert.ok(threw, 'tampered payload should fail');

console.log('PASS: auth sealing test');
