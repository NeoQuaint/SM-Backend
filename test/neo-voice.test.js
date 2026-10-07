const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup() {
  const handlers = {}, calls = [];
  const router = { post: (route, ...fns) => { handlers[route] = fns.at(-1); }, get: (route, ...fns) => { handlers[route] = fns.at(-1); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/neo.js'), 'utf8'), {
    require: name => name === 'express' ? { Router: () => router } : name === 'openai' ? class {} : {},
    process: { env: { DEEPINFRA_API_KEY: 'test-only', KOKORO_VOICE_ID: 'af_heart' } },
    console: { log() {}, error() {} }, Buffer, setTimeout: () => 0,
    fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; },
    module: { exports: {} },
  });
  const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; }, set(headers) { this.headers = headers; return this; }, send(value) { this.body = value; return this; } });
  return { handlers, calls, response };
}
test('Neo uses Bella and keeps narration longer than the former 500-character limit', async () => {
  const { handlers, calls, response } = setup(); const res = response();
  const text = 'A complete explanation. '.repeat(30);
  await handlers['/speak']({ body: { text } }, res);
  assert.equal(res.code, 200); assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/af_bella'));
  assert.equal(calls[0].body.text, text);
  assert.equal(res.headers['Content-Type'], 'audio/mpeg');
});
test('invalid or oversized narration is rejected before calling the provider', async () => {
  for (const text of [null, {}, ' ', 'a'.repeat(1501)]) {
    const { handlers, calls, response } = setup(); const res = response();
    await handlers['/speak']({ body: { text } }, res);
    assert.equal(res.code, 400); assert.equal(calls.length, 0);
  }
});
