# node-red-contrib-smsgora

[![npm](https://img.shields.io/npm/v/node-red-contrib-smsgora.svg)](https://www.npmjs.com/package/node-red-contrib-smsgora)
[![tests](https://github.com/TekservixHQ/node-red-contrib-smsgora/actions/workflows/tests.yml/badge.svg)](https://github.com/TekservixHQ/node-red-contrib-smsgora/actions/workflows/tests.yml)

Node-RED nodes for [SMS Gora](https://tekservix.com/smsgora/), the SMS gateway that sends and receives texts through your own Android phones.

Send SMS from any flow (alerts from sensors, Home Assistant, PLCs, servers, forms) and react to incoming SMS and delivery reports. There's no sender ID registration and no per-message fee from us: your mobile operator bills the texts like any SMS.

## Install

In Node-RED: **Menu → Manage palette → Install**, search for `node-red-contrib-smsgora`.

Or from your Node-RED user directory (usually `~/.node-red`):

```bash
npm install node-red-contrib-smsgora
```

Needs Node-RED 3.0+ and Node.js 18+. No other dependencies.

## Setup

1. In the SMS Gora dashboard, link an Android phone (install the SMS Gora app and scan the QR code).
2. Create an API key under **SMS Gora → API keys** (it starts with `sgk_`).
3. Add any SMS Gora node to a flow, open it, and create an **SMS Gora** account (config node) with the key.

## Nodes

### sms gora send

Sends an SMS.

- `msg.payload`: the text (or set **Message** in the node)
- `msg.to`: one or more numbers in international format, comma separated or an array, up to 1,000 (or set **To**)
- optional `msg.deviceId`, `msg.simSlot` (0 = SIM 1, 1 = SIM 2), `msg.scheduleAt`

Output: `msg.payload = { message_ids: [...] }`.

### sms gora api

Calls any endpoint of the [SMS Gora API](https://tekservix.com/smsgora/docs/) and returns its `data`: for example `GET /messages/1873` (delivery status), `POST /messages/1873/cancel`, `GET /received-sms?limit=50`, `GET /devices`, `GET /account`. `msg.method`, `msg.path` and `msg.payload` (JSON body) override the node settings.

### sms gora webhook

Receives incoming SMS and sent, delivered or failed reports, and checks the `X-SmsGora-Signature` (HMAC-SHA256) so nobody else can trigger your flow.

```
[http in POST /smsgora] → [sms gora webhook] → your flow
                                  ↘ output 2 → [http response]
```

Add `https://<your-node-red>/smsgora` in **SMS Gora → Webhooks**, paste the secret into the node, and optionally filter events (`sms.received`, `sms.sent`, `sms.delivered`, `sms.failed`). `msg.topic` is the event name; `msg.payload.data.from` and `msg.payload.data.message` hold an incoming SMS.

Errors from the send and api nodes can be caught with a **catch** node: `msg.error` holds `status`, `message`, `errors` and `retryAfter`.

## Example

Import **Menu → Import → Examples → node-red-contrib-smsgora → send-sms**: an inject node that sends a test SMS, and a webhook flow that logs incoming SMS.

## More from Tekservix

- [WAservix WhatsApp API Gateway](https://tekservix.com/waservix/): WhatsApp from your own number, also for Node-RED (`node-red-contrib-waservix`)
- [AI Sales Agent](https://tekservix.com/ai-sales-agent): answers customers on WhatsApp and SMS using your website's content
- [Website to App](https://tekservix.com/mobile-apps): turn your website into Android and iOS apps
- SMS Gora libraries for 12 languages and n8n nodes: [github.com/TekservixHQ](https://github.com/TekservixHQ)

## License

MIT
