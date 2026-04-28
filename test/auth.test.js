const assert = require('assert');
const { signPayload, verifyPayload } = require('../dist/auth.js');
const { sealDirectFrame, openDirectFrame } = require('../dist/direct-common.js');

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

const directRaw = sealDirectFrame(token, 'stdout', 'secret-output');
assert.ok(!directRaw.includes('secret-output'));

const directFrame = openDirectFrame(token, directRaw);
assert.deepStrictEqual(directFrame, {
  type: 'stdout',
  payload: 'secret-output',
});

console.log('PASS: auth and direct sealing test');
