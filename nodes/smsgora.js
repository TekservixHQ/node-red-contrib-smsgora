'use strict';

const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://tekservix.com/smsgora/api/v1';
const VERSION = require('../package.json').version;

// One call to the SMS Gora API. Resolves with the `data` part of the answer.
async function smsGoraRequest(config, method, path, body) {
  const apiKey = config.credentials && config.credentials.apiKey;
  if (!apiKey) throw new Error('SMS Gora: add your API key to the SMS Gora config node');
  const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const res = await fetch(base + path, {
    method,
    headers: Object.assign(
      { 'x-api-key': apiKey, Accept: 'application/json', 'User-Agent': 'node-red-contrib-smsgora/' + VERSION },
      body === undefined ? {} : { 'Content-Type': 'application/json' },
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch (e) {
    json = undefined;
  }
  if (!res.ok || (json && json.success === false)) {
    const err = new Error((json && typeof json.message === 'string' && json.message) || 'HTTP ' + res.status);
    err.status = res.status;
    err.errors = json && json.errors;
    err.body = json === undefined ? text : json;
    const retry = res.headers.get('retry-after');
    if (retry) err.retryAfter = Number(retry);
    throw err;
  }
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

function toList(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (value === undefined || value === null) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

// JSON as PHP's json_encode writes it by default: "/" as "\/" and non-ASCII as \uXXXX.
function phpJson(compact) {
  return compact
    .replace(/\//g, '\\/')
    .replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Check the X-SmsGora-Signature header (sha256=<hex HMAC-SHA256 of the raw body>). */
function verifyWebhook(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = function (RED) {
  function SmsGoraConfigNode(n) {
    RED.nodes.createNode(this, n);
    this.name = n.name;
    this.baseUrl = n.baseUrl || DEFAULT_BASE_URL;
  }
  RED.nodes.registerType('smsgora-config', SmsGoraConfigNode, {
    credentials: { apiKey: { type: 'password' } },
  });

  function fail(node, msg, done, err) {
    node.status({ fill: 'red', shape: 'dot', text: err.status ? 'HTTP ' + err.status : 'error' });
    msg.error = { message: err.message, status: err.status, errors: err.errors, retryAfter: err.retryAfter };
    done(err);
  }

  // Send an SMS. msg.to / msg.payload override the node settings.
  function SmsGoraSendNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.config = RED.nodes.getNode(n.config);
    node.to = n.to;
    node.message = n.message;
    node.deviceId = n.deviceId;
    node.simSlot = n.simSlot;

    node.on('input', async (msg, send, done) => {
      if (!node.config) return done(new Error('SMS Gora: choose an SMS Gora config node'));
      const recipients = toList(msg.to !== undefined ? msg.to : node.to);
      const text = msg.payload !== undefined && typeof msg.payload !== 'object' && String(msg.payload) !== ''
        ? String(msg.payload)
        : node.message;
      if (!recipients.length) return done(new Error('SMS Gora: no recipient (set "To" or msg.to)'));
      if (!text) return done(new Error('SMS Gora: no message (set "Message" or msg.payload)'));

      const body = { recipients, message: text };
      const simSlot = msg.simSlot !== undefined ? msg.simSlot : node.simSlot;
      if (simSlot !== undefined && simSlot !== '') body.sim_slot = Number(simSlot);
      if (msg.scheduleAt) body.schedule_at = new Date(msg.scheduleAt).toISOString();
      const deviceId = msg.deviceId !== undefined ? msg.deviceId : node.deviceId;
      const path = deviceId ? '/devices/' + encodeURIComponent(deviceId) + '/send-sms' : '/send-sms';

      node.status({ fill: 'blue', shape: 'dot', text: 'sending' });
      try {
        msg.payload = await smsGoraRequest(node.config, 'POST', path, body);
        node.status({ fill: 'green', shape: 'dot', text: 'sent to ' + recipients.length });
        send(msg);
        done();
      } catch (err) {
        fail(node, msg, done, err);
      }
    });
  }
  RED.nodes.registerType('smsgora-send', SmsGoraSendNode);

  // Call any SMS Gora endpoint: msg.method, msg.path, msg.payload (body).
  function SmsGoraApiNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.config = RED.nodes.getNode(n.config);
    node.method = n.method || 'GET';
    node.path = n.path || '/account';

    node.on('input', async (msg, send, done) => {
      if (!node.config) return done(new Error('SMS Gora: choose an SMS Gora config node'));
      const method = String(msg.method || node.method).toUpperCase();
      const path = msg.path || node.path;
      const body = method === 'GET' || method === 'DELETE' || typeof msg.payload !== 'object' ? undefined : msg.payload;
      node.status({ fill: 'blue', shape: 'dot', text: method + ' ' + path });
      try {
        msg.payload = await smsGoraRequest(node.config, method, path, body);
        node.status({});
        send(msg);
        done();
      } catch (err) {
        fail(node, msg, done, err);
      }
    });
  }
  RED.nodes.registerType('smsgora-api', SmsGoraApiNode);

  // Check an incoming webhook (from an http in node) and pass it on only if the signature matches.
  function SmsGoraWebhookNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.events = n.events || '';

    node.on('input', (msg, send, done) => {
      const secret = node.credentials && node.credentials.secret;
      const headers = (msg.req && msg.req.headers) || {};
      if (secret) {
        // Best: the exact bytes received (msg.req.rawBody, or a string/Buffer payload). When the
        // http in node already parsed the JSON, try the two common ways it may have been encoded.
        const signature = headers['x-smsgora-signature'];
        const candidates = [];
        if (msg.req && msg.req.rawBody) candidates.push(msg.req.rawBody);
        if (typeof msg.payload === 'string' || Buffer.isBuffer(msg.payload)) {
          candidates.push(msg.payload);
        } else if (msg.payload && typeof msg.payload === 'object') {
          const compact = JSON.stringify(msg.payload);
          candidates.push(compact, phpJson(compact));
        }
        if (!candidates.some((raw) => verifyWebhook(raw, signature, secret))) {
          node.status({ fill: 'red', shape: 'ring', text: 'bad signature' });
          msg.statusCode = 401;
          send([null, msg]);
          return done();
        }
      }
      let event = msg.payload;
      if (typeof event === 'string' || Buffer.isBuffer(event)) {
        try {
          event = JSON.parse(event.toString());
        } catch (e) {
          return done(new Error('SMS Gora: webhook body is not JSON'));
        }
      }
      const wanted = toList(node.events);
      if (wanted.length && !wanted.includes(event && event.event)) {
        msg.statusCode = 200;
        send([null, msg]);
        return done();
      }
      msg.payload = event;
      msg.topic = event && event.event;
      msg.statusCode = 200;
      node.status({ fill: 'green', shape: 'dot', text: msg.topic || 'event' });
      send([msg, null]);
      done();
    });
  }
  RED.nodes.registerType('smsgora-webhook', SmsGoraWebhookNode, {
    credentials: { secret: { type: 'password' } },
  });
};

module.exports.smsGoraRequest = smsGoraRequest;
module.exports.verifyWebhook = verifyWebhook;
