// Runs the page hook outside the browser against the captions_v2 exchange of
// the first recorded session (CC clicked by hand), and checks that the hook
// asks for captions by itself after joining, sends the receipts Meet sent
// when the page does not, and stays quiet when the page does.
//   node tools/replay/captions-test.js recordings/20261110-234313
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const MeetDecode = require('../../extension/src/meet-decode.js');

const session = process.argv[2];
if (!session) throw new Error('usage: node captions-test.js recordings/<session>');
// The page gets Meet's file and then the hook, as the manifest loads them.
const hookSources = ['page-meet.js', 'page-hook.js'].map((name) => fs.readFileSync(path.join(__dirname, '../../extension/src', name), 'utf8'));

// ---- protobuf, enough to build and split frames ----------------------------
const int = (v) => { const out = []; while (v > 127) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); } out.push(v); return out; };
const num = (f, v) => [...int(f * 8), ...int(v)];
const len = (f, bytes) => [...int(f * 8 + 2), ...int(bytes.length), ...bytes];
const text = (s) => [...Buffer.from(s)];
const askFrame = (id, lang) => Buffer.from(len(1, len(2, [...num(1, id), ...len(2, len(1, [...len(2, text(lang)), ...len(3, text(lang))]))])));
const answerFrame = (id) => Buffer.from(len(1, len(2, [...num(1, id), ...len(3, [])])));

function fields(b) {
  const out = [];
  let p = 0;
  const varint = () => { let v = 0, mul = 1; for (;;) { const x = b[p++]; v += (x & 0x7f) * mul; if (!(x & 0x80)) return v; mul *= 128; } };
  while (p < b.length) {
    const tag = varint(), f = Math.floor(tag / 8), w = tag % 8;
    if (w === 0) out.push({ f, w, v: varint() });
    else if (w === 2) { const n = varint(); out.push({ f, w, v: b.subarray(p, p + n) }); p += n; }
    else throw new Error(`wire type ${w}`);
  }
  return out;
}
// The receipts in a frame the client sent, one hex string each.
const receipts = (frame) => fields(fields(frame).find((x) => x.f === 1).v).filter((x) => x.f === 1).map((x) => Buffer.from(x.v).toString('hex'));
const hasRequest = (frame) => fields(fields(frame).find((x) => x.f === 1).v).some((x) => x.f === 2);

// ---- a page with a clock the test moves -------------------------------------
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// `captions` is the user's choice in the extension's menu, as content.js tells it.
function makePage(captions = true) {
  const clock = { t: 0, timers: new Map(), next: 1 };
  const logs = [];
  const told = []; // kinds of everything else the hook says
  const heard = []; // the hook's listeners for what content.js says
  class Target {
    constructor() { this.listeners = {}; }
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
    fire(type, ev = {}) { for (const fn of this.listeners[type] || []) fn(ev); }
  }
  class RTCDataChannel extends Target {
    constructor(label) { super(); this.label = label; this.readyState = 'connecting'; this.sent = []; }
    send(data) { this.sent.push({ bytes: Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data), byPage: !!this.pageSending }); }
  }
  class RTCPeerConnection extends Target {
    createDataChannel(label) { return new RTCDataChannel(label); }
    addTrack() {}
    addTransceiver() {}
    getSenders() { return []; }
  }
  class RTCRtpSender { replaceTrack() { return Promise.resolve(); } }
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};

  const page = vm.createContext({
    RTCPeerConnection, RTCDataChannel, RTCRtpSender, XMLHttpRequest, MediaStreamTrack: class {},
    // The same constructors as the test's, so `instanceof` holds across the two.
    ArrayBuffer, Uint8Array, Int16Array, Blob, Response, DecompressionStream, TextEncoder, TextDecoder,
    performance: { timeOrigin: 0, now: () => clock.t },
    setTimeout: (fn, ms) => { const id = clock.next++; clock.timers.set(id, { at: clock.t + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { clock.timers.delete(id); },
    location: { origin: 'https://meet.google.com', pathname: '/abc-defg-hij' },
    document: { title: 'Meet', querySelector: () => null },
    navigator: { languages: ['pt-BR', 'en-US'], userAgent: 'test' },
    localStorage: { length: 0, key: () => null, getItem: () => null },
    addEventListener: (type, fn) => { if (type === 'message') heard.push(fn); },
    postMessage: (m) => { if (m.kind === 'log') logs.push({ event: m.event, ...m.data }); else told.push(m.kind); },
  });
  page.window = page;
  for (const source of hookSources) vm.runInContext(source, page);
  // From inside, the page's window is not the object it was made from.
  for (const fn of heard) fn({ source: vm.runInContext('window', page), data: { __mtExt: 1, on: true, captions } });

  // Lets the hook's asynchronous frame parsing (it may gunzip) finish.
  const settle = () => pause(15);
  async function advance(ms) {
    const end = clock.t + ms;
    for (;;) {
      await settle();
      let first = null;
      for (const [id, timer] of clock.timers) if (timer.at <= end && (!first || timer.at < first.timer.at)) first = { id, timer };
      if (!first) break;
      clock.timers.delete(first.id);
      clock.t = first.timer.at;
      first.timer.fn();
    }
    clock.t = end;
  }

  // Joining, as Meet does it: the channel is made by the page and opens.
  const pc = new page.RTCPeerConnection();
  const ch = pc.createDataChannel('captions_v2');
  const roster = new RTCDataChannel('collections');
  pc.fire('datachannel', { channel: roster });
  ch.readyState = 'open';
  ch.fire('open');

  return {
    logs, advance, settle, told,
    // A connection made only to probe, with a roster channel of its own.
    probe: () => { const other = new RTCDataChannel('collections'); new page.RTCPeerConnection().fire('datachannel', { channel: other }); return other; },
    hangUp: () => roster.fire('close'),
    fromServer: (bytes) => ch.fire('message', { data: Uint8Array.from(bytes).buffer }),
    fromPage: (bytes) => { ch.pageSending = true; try { ch.send(Uint8Array.from(bytes).buffer); } finally { ch.pageSending = false; } },
    byHook: () => ch.sent.filter((s) => !s.byPage).map((s) => s.bytes),
    asks: () => logs.filter((l) => l.event === 'captions-ask' && l.id),
  };
}

(async () => {
  const frames = fs.readFileSync(path.join(session, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'raw' && e.label === 'captions_v2')
    .map((e) => ({ dir: e.dir, chan: e.chan, bytes: Buffer.from(e.b64, 'base64') }));
  const chan = frames.find((f) => f.dir === 'in').chan; // the connection that carried the call
  const exchange = frames.filter((f) => f.chan === chan);
  const clicked = exchange.findIndex((f) => f.dir === 'out' && f.bytes.includes('pt-BR'));
  assert(clicked > 0, 'the session has no request for captions (CC was never clicked)');
  assert.deepEqual(exchange[clicked].bytes, askFrame(2, 'pt-BR'), 'the request Meet sent is not the one this test builds');
  const joining = exchange.slice(0, clicked);
  // After the click: the answer to Meet's request, then entries and receipts.
  const after = exchange.slice(clicked + 1);
  assert(after[0].dir === 'in' && hasRequest(after[0].bytes), 'no answer to the request in the session');
  const rest = after.slice(1);
  const meetReceipts = rest.filter((f) => f.dir === 'out').flatMap((f) => receipts(f.bytes));

  const join = async (page) => {
    for (const f of joining) {
      if (f.dir === 'in') page.fromServer(f.bytes); else page.fromPage(f.bytes);
      await page.settle();
    }
  };

  // 1. CC is never clicked and the page leaves the captions unanswered.
  {
    const page = makePage();
    await join(page);
    await page.advance(3900);
    assert.equal(page.byHook().length, 0, 'asked before giving Meet the time to ask');
    await page.advance(200);
    const [ask] = page.asks();
    assert(ask && page.asks().length === 1, 'no request for captions after joining');
    assert.equal(ask.lang, 'pt-BR');
    assert.deepEqual(page.byHook(), [askFrame(ask.id, 'pt-BR')], 'the request is not the one Meet sends');
    page.fromServer(answerFrame(ask.id));
    for (const f of rest) {
      if (f.dir !== 'in') continue;
      page.fromServer(f.bytes);
      await page.advance(250);
    }
    await page.advance(6000);
    assert(page.logs.some((l) => l.event === 'captions-ask-answered'), 'the answer was not recognised');
    assert.equal(page.asks().length, 1, 'asked again although answered');
    assert.deepEqual(page.byHook().slice(1).flatMap(receipts), meetReceipts, 'receipts differ from the ones Meet sent');
  }

  // 2. The page answers everything itself, and CC is clicked later on.
  {
    const page = makePage();
    await join(page);
    await page.advance(4100);
    const [ask] = page.asks();
    page.fromServer(answerFrame(ask.id));
    for (const f of exchange.slice(clicked)) {
      if (f.dir === 'in') page.fromServer(f.bytes); else page.fromPage(f.bytes);
      await page.advance(f.dir === 'in' ? 0 : 250);
    }
    await page.advance(6000);
    assert.equal(page.byHook().length, 1, 'sent receipts or requests on top of the page\'s own');
    assert(page.logs.some((l) => l.event === 'captions-page' && l.on && l.lang === 'pt-BR'), 'did not notice CC being clicked');

    // Then some other request, as turning CC off would be: ask again.
    page.fromPage(Buffer.from(len(1, len(2, [...num(1, 3), ...len(2, [])]))));
    await page.advance(1100);
    assert.equal(page.asks().length, 2, 'did not ask again after Meet changed the captions');
    assert.equal(page.asks()[1].from, 'meet', 'did not reuse the language Meet asked for');
  }

  // 3. Meet remembers CC as on and asks first: nothing to do.
  {
    const page = makePage();
    await join(page);
    await page.advance(1000);
    page.fromPage(askFrame(2, 'pt-BR'));
    await page.advance(20000);
    assert.equal(page.byHook().length, 0, 'asked although Meet already had');
  }

  // 4. The server never answers: a few tries, then silence.
  {
    const page = makePage();
    await join(page);
    await page.advance(60000);
    assert.equal(page.asks().length, 3);
    assert(page.logs.some((l) => l.event === 'captions-ask' && l.gaveUp), 'never gave up');
  }

  // 5. Captions turned off in the extension's menu: nothing is asked, and
  // what the page asks for by itself is still left to it.
  {
    const page = makePage(false);
    await join(page);
    await page.advance(60000);
    assert.equal(page.byHook().length, 0, 'asked for captions although told not to');
    for (const f of exchange.slice(clicked)) {
      if (f.dir === 'in') page.fromServer(f.bytes); else page.fromPage(f.bytes);
      await page.advance(f.dir === 'in' ? 0 : 250);
    }
    await page.advance(6000);
    assert.equal(page.byHook().length, 0, 'sent something on the channel although told not to');
  }

  // 6. Hanging up leaves the page open: the roster channel closing is the
  // end of the call. That of a connection made only to probe is not.
  {
    const page = makePage();
    const ends = () => page.told.filter((kind) => kind === 'meeting_end').length;
    page.probe().fire('close');
    await page.settle();
    assert.equal(ends(), 0, 'a probing connection closing was taken for the end of the call');
    page.hangUp();
    await page.settle();
    assert.equal(ends(), 1, 'the end of the call was not told');
    assert.equal(page.told.lastIndexOf('meeting') < page.told.lastIndexOf('meeting_end'), true);
    page.probe();
    await page.settle();
    assert.equal(page.told.pop(), 'meeting', 'joining again was not told');
  }

  // The decoder reads every caption the session holds, gzipped frames included.
  let decoded = 0;
  for (const f of exchange) if (f.dir === 'in') decoded += (await MeetDecode.decode('captions_v2', new Uint8Array(f.bytes))).length;
  const captions = meetReceipts.filter((hex) => fields(Buffer.from(hex, 'hex')).some((x) => x.f === 3)).length;
  assert.equal(decoded, captions, 'captions lost by the decoder');

  console.log(`ok: asks for captions after joining, in the request Meet sends; ${meetReceipts.length} receipts equal to Meet's when the page sends none, none when it does; ${decoded} captions decoded`);
})().catch((e) => { console.error(e); process.exit(1); });
