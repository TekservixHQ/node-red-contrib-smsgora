const assert = require('assert');
const crypto = require('crypto');
const helper = require('node-red-node-test-helper');
const smsgora = require('../nodes/smsgora.js');

helper.init(require.resolve('node-red'));

describe('smsgora nodes', function () {
  let calls;
  const realFetch = global.fetch;

  beforeEach(function (done) {
    calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      if (url.includes('/fail')) {
        return new Response('{"success":false,"message":"Too many requests"}', {
          status: 429,
          headers: { 'retry-after': '12' },
        });
      }
      return new Response('{"success":true,"data":{"message_ids":[1873]}}', { status: 200 });
    };
    helper.startServer(done);
  });

  afterEach(function (done) {
    global.fetch = realFetch;
    helper.unload().then(() => helper.stopServer(done));
  });

  const flow = (extra) => [
    { id: 'cfg', type: 'smsgora-config', baseUrl: 'https://example.test/api/' },
    Object.assign({ id: 'n1', type: 'smsgora-send', config: 'cfg', wires: [['out']] }, extra),
    { id: 'out', type: 'helper' },
  ];

  it('sends an SMS from msg.to and msg.payload', function (done) {
    helper.load(smsgora, flow({}), { cfg: { apiKey: 'sgk_test' } }, function () {
      helper.getNode('out').on('input', (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { message_ids: [1873] });
          assert.strictEqual(calls[0].url, 'https://example.test/api/send-sms');
          assert.strictEqual(calls[0].init.headers['x-api-key'], 'sgk_test');
          assert.deepStrictEqual(calls[0].body, { recipients: ['+1555', '+1666'], message: 'Hi' });
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode('n1').receive({ payload: 'Hi', to: '+1555, +1666' });
    });
  });

  it('uses node settings, phone and SIM', function (done) {
    const f = flow({ to: '+1777', message: 'Default', deviceId: '42', simSlot: '1' });
    helper.load(smsgora, f, { cfg: { apiKey: 'k' } }, function () {
      helper.getNode('out').on('input', () => {
        try {
          assert.strictEqual(calls[0].url, 'https://example.test/api/devices/42/send-sms');
          assert.deepStrictEqual(calls[0].body, { recipients: ['+1777'], message: 'Default', sim_slot: 1 });
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode('n1').receive({ payload: '' });
    });
  });

  it('api node calls any path', function (done) {
    const f = [
      { id: 'cfg', type: 'smsgora-config', baseUrl: 'https://example.test/api' },
      { id: 'a1', type: 'smsgora-api', config: 'cfg', method: 'POST', path: '/messages/7/cancel', wires: [['out']] },
      { id: 'out', type: 'helper' },
    ];
    helper.load(smsgora, f, { cfg: { apiKey: 'k' } }, function () {
      helper.getNode('out').on('input', () => {
        try {
          assert.strictEqual(calls[0].url, 'https://example.test/api/messages/7/cancel');
          assert.strictEqual(calls[0].init.method, 'POST');
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode('a1').receive({});
    });
  });

  it('request helper turns API errors into exceptions', async function () {
    await assert.rejects(
      smsgora.smsGoraRequest({ baseUrl: 'https://example.test/fail', credentials: { apiKey: 'k' } }, 'GET', '/account'),
      (err) => err.status === 429 && err.message === 'Too many requests' && err.retryAfter === 12,
    );
  });

  it('webhook node checks the signature', function (done) {
    const raw = '{"event":"sms.received","data":{"from":"+15551234567","message":"Hi"}}';
    const sig = 'sha256=' + crypto.createHmac('sha256', 'whsec_test').update(raw).digest('hex');
    const f = [
      { id: 'w1', type: 'smsgora-webhook', events: 'sms.received', wires: [['ok'], ['rej']] },
      { id: 'ok', type: 'helper' },
      { id: 'rej', type: 'helper' },
    ];
    helper.load(smsgora, f, { w1: { secret: 'whsec_test' } }, function () {
      let rejected = false;
      helper.getNode('rej').on('input', (msg) => {
        rejected = msg.statusCode === 401;
      });
      helper.getNode('ok').on('input', (msg) => {
        try {
          assert.ok(rejected, 'bad signature should be rejected first');
          assert.strictEqual(msg.topic, 'sms.received');
          assert.strictEqual(msg.payload.data.from, '+15551234567');
          done();
        } catch (e) {
          done(e);
        }
      });
      const w = helper.getNode('w1');
      w.receive({ payload: raw, req: { headers: { 'x-smsgora-signature': 'sha256=bad' } } });
      w.receive({ payload: raw, req: { headers: { 'x-smsgora-signature': sig } } });
    });
  });

  it('webhook node accepts an already-parsed body signed PHP-style', function (done) {
    const event = { event: 'sms.received', data: { from: '+1555', message: 'Café https://x.co/a' } };
    const php = JSON.stringify(event).replace(/\//g, '\\/').replace(/é/g, '\\u00e9');
    const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(php).digest('hex');
    const f = [
      { id: 'w1', type: 'smsgora-webhook', events: '', wires: [['ok'], ['rej']] },
      { id: 'ok', type: 'helper' },
      { id: 'rej', type: 'helper' },
    ];
    helper.load(smsgora, f, { w1: { secret: 's3cret' } }, function () {
      helper.getNode('rej').on('input', () => done(new Error('should not be rejected')));
      helper.getNode('ok').on('input', (msg) => {
        try {
          assert.strictEqual(msg.payload.data.message, 'Café https://x.co/a');
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode('w1').receive({ payload: event, req: { headers: { 'x-smsgora-signature': sig } } });
    });
  });

  it('verifyWebhook matches the reference vector', function () {
    const raw = '{"event":"sms.received","data":{"from":"+15551234567"}}';
    const sig = 'sha256=e125c07dfbecb498e8979383d7b9f0815efb128755409794b486d4bbb7199583';
    assert.ok(smsgora.verifyWebhook(raw, sig, 'whsec_test'));
    assert.ok(!smsgora.verifyWebhook(raw, 'sha256=00', 'whsec_test'));
  });
});
