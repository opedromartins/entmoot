// Runs the extension's content and background scripts outside the browser,
// against the data-channel frames of a recorded session, and checks what
// reaches the app: the roster while connected, and again after the app
// restarts with the call under way.
//   node tools/replay/extension-test.js recordings/<session>
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = (name) => fs.readFileSync(path.join(__dirname, '../../extension/src', name), 'utf8');
const session = process.argv[2];
if (!session) throw new Error('usage: node extension-test.js recordings/<session>');

// ---- a socket the test can open, close and read ----------------------------
const sockets = [];
class FakeSocket {
  static OPEN = 1;
  constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
  send(data) { this.sent.push(data); }
  open() { this.readyState = 1; this.onopen(); }
  close() { this.readyState = 3; this.onclose(); }
  json() { return this.sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m)); }
}

// ---- a runtime port between the two scripts --------------------------------
const listeners = () => { const fns = []; return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.forEach((fn) => fn(...a)) }; };
const onConnect = listeners();
function connectPort(id) {
  const tab = { onMessage: listeners(), onDisconnect: listeners() };
  const bg = { name: 'mt', sender: { tab: { id } }, onMessage: listeners(), onDisconnect: listeners() };
  const clone = (m) => structuredClone(m);
  tab.postMessage = (m) => bg.onMessage.fire(clone(m));
  bg.postMessage = (m) => tab.onMessage.fire(clone(m));
  tab.close = () => bg.onDisconnect.fire(bg);
  onConnect.fire(bg);
  return tab;
}

// The retry delay does not matter here: reconnect at once.
const timers = { setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {} };
const background = vm.createContext({
  browser: { runtime: { onConnect, getManifest: () => ({ version: 'test' }) } },
  WebSocket: FakeSocket, console, btoa, atob,TextDecoder, Blob, Response, DecompressionStream, Uint8Array, DataView, BigInt, ...timers,
});
vm.runInContext(src('meet-decode.js'), background);
vm.runInContext(src('teams-decode.js'), background);
vm.runInContext(src('background.js'), background);

// A page with content.js in it, the extension's settings as given, and what
// the hook would be told.
let tabs = 7;
function makeTab(settings) {
  const id = tabs++;
  let onPageMessage, port;
  const told = [];
  const page = { addEventListener: (_, fn) => { onPageMessage = fn; }, postMessage: (m) => told.push(m) };
  const browser = {
    runtime: { connect: () => (port = connectPort(id)), getURL: (file) => `moz-extension://test/${file}` },
    storage: { local: { get: async (defaults) => ({ ...defaults, ...settings }) } },
  };
  const content = vm.createContext({ window: page, browser, Map, location: { hostname: 'meet.google.com', origin: 'https://meet.google.com' } });
  vm.runInContext(src('settings.js'), content);
  vm.runInContext(src('content.js'), content);
  return { told, fromPage: (m) => onPageMessage({ source: page, data: { __mt: 1, ...m } }), close: () => port.close() };
}
const { told, fromPage, close } = makeTab({});

const settle = () => new Promise((r) => setTimeout(r, 50));
const roster = (events) => ({
  names: new Set(events.filter((e) => e.kind === 'participant').map((e) => e.deviceId)),
  sources: new Set(events.filter((e) => e.kind === 'source' && e.media === 'audio').map((e) => e.csrc)),
  meeting: events.filter((e) => e.kind === 'meeting').pop(),
});

(async () => {
  const frames = fs.readFileSync(path.join(session, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'raw' && e.dir === 'in' && e.label === 'collections');
  assert(frames.length > 0, 'the session has no collections frames');

  fromPage({ kind: 'meeting', t: 1, platform: 'meet', code: 'abc-defg-hij', title: 'Meet: Teste' });
  await settle(); // the settings are read before anything is relayed
  assert.deepEqual(told.map((m) => [m.on, m.captions]), [[true, true]], 'the hook was not told the default settings');
  const first = sockets[0];
  first.open();
  for (const f of frames) fromPage({ kind: 'raw', t: f.t, label: f.label, chan: f.chan, dir: 'in', bytes: Uint8Array.from(Buffer.from(f.b64, 'base64')).buffer });
  await settle();
  const live = roster(first.json());
  assert(live.names.size > 0 && live.sources.size > 0, 'no roster decoded while connected');
  assert.equal(first.json()[0].kind, 'hello');

  // Who was already in the call arrives over HTTP, not on the channel. No
  // real answer was ever recorded, so this one is built by hand: a gRPC-web
  // body in base64 with one participant entry three levels down.
  const field = (n, bytes) => Buffer.concat([Buffer.from(n < 16 ? [(n << 3) | 2] : [((n << 3) & 0x7f) | 0x82, n >> 4]), Buffer.from([bytes.length]), bytes]);
  const device = 'spaces/abc/devices/900';
  const entry = Buffer.concat([field(1, Buffer.from(device)), field(2, Buffer.from('Zélia Teste'))]);
  const message = field(2, field(1, field(2, entry)));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  const trailers = Buffer.concat([Buffer.from([0x80, 0, 0, 0, 2]), Buffer.from('ok')]);
  for (const body of [Buffer.concat([header, message, trailers]), Buffer.from(Buffer.concat([header, message]).toString('base64') + trailers.toString('base64')), message]) {
    const before = first.json().length;
    fromPage({ kind: 'raw', t: 5, label: 'rpc-collections', chan: 0, dir: 'in', bytes: Uint8Array.from(body).buffer });
    await settle();
    const named = first.json().slice(before).filter((e) => e.kind === 'participant');
    assert.deepEqual(named.map((e) => [e.deviceId, e.name]), [[device, 'Zélia Teste']], 'roster fetched over HTTP not decoded');
  }
  live.names.add(device);

  // The user's own device carries tokens the others do not; what it presents
  // carries them too, but names its owner. Only some mentions have them.
  const own = 'spaces/abc/devices/901', shown = 'spaces/abc/devices/902';
  const token = Buffer.from('eM-ta2wwgnlD');
  const person = (id, ...more) => Buffer.concat([field(1, Buffer.from(id)), field(2, Buffer.from('Caio Lima')), ...more]);
  const mentions = [person(own, field(7, token), field(22, token)), person(shown, field(7, token), field(21, Buffer.from(own)), field(22, token)), person(own)];
  const before = first.json().length;
  for (const entry of mentions) fromPage({ kind: 'raw', t: 6, label: 'rpc-collections', chan: 0, dir: 'in', bytes: Uint8Array.from(field(2, entry)).buffer });
  await settle();
  const mine = (events) => events.filter((e) => e.kind === 'participant' && e.self).map((e) => e.deviceId);
  assert.deepEqual(mine(first.json().slice(before)), [own], 'the user\'s own device not told apart');
  live.names.add(own).add(shown);

  // The app goes away and comes back: a new socket, which must learn it all again.
  first.close();
  fromPage({ kind: 'log', t: 2, event: 'tick' }); // anything, with the app unreachable
  await settle();
  const second = sockets[sockets.length - 1];
  assert.notEqual(second, first, 'no reconnection was attempted');
  second.open();
  await settle();
  const again = roster(second.json());
  assert.deepEqual([...again.names].sort(), [...live.names].sort(), 'participants not resent');
  // The recording has an own device too.
  assert(mine(second.json()).includes(own), 'the user\'s own device forgotten');
  assert.deepEqual(mine(second.json()).sort(), [...new Set(mine(first.json()))].sort(), 'own devices not resent as such');
  // Sources still in the call when the app went away (people leave).
  const present = new Set();
  for (const e of first.json()) {
    if (e.kind === 'source' && e.media === 'audio') present.add(e.csrc);
    else if (e.kind === 'source_removed') present.delete(e.csrc);
  }
  assert.deepEqual([...again.sources].sort(), [...present].sort(), 'sources not resent');
  assert.equal(again.meeting && again.meeting.title, 'Meet: Teste', 'meeting not resent');

  // Meet turned off in the extension's menu: the tab says nothing, and the
  // hook is told to stand down.
  const connections = sockets.length, sent = second.sent.length;
  const quiet = makeTab({ meet: false });
  quiet.fromPage({ kind: 'meeting', t: 9, platform: 'meet', code: 'xyz', title: 'Meet: Outra' });
  await settle();
  quiet.fromPage({ kind: 'log', t: 10, event: 'tick' });
  await settle();
  assert.deepEqual(quiet.told.map((m) => [m.on, m.captions]), [[false, false]], 'the hook was not told the platform is off');
  assert(sockets.length === connections && second.sent.length === sent, 'a tab of a platform turned off reached the app');
  // Captions alone turned off.
  const noCaptions = makeTab({ meetCaptions: false });
  noCaptions.fromPage({ kind: 'log', t: 11, event: 'tick' });
  await settle();
  assert.deepEqual(noCaptions.told.map((m) => [m.on, m.captions]), [[true, false]], 'the hook was not told to leave captions alone');

  // The tab closes mid-call without a word: the app is told the call ended,
  // once. Another page is still open, so the socket stays.
  noCaptions.fromPage({ kind: 'meeting_end', t: 12 }); // a page not in a call, on its way out
  await settle();
  const ends = (sock) => sock.json().filter((e) => e.kind === 'meeting_end').length;
  assert.equal(ends(second), 0, 'a tab not in a call ended the meeting');
  close();
  await settle();
  assert.equal(ends(second), 1, 'the end of the call was not told when its tab closed');
  assert.equal(second.readyState, 1, 'the socket was closed with a meeting page still open');
  noCaptions.close();
  await settle();
  assert.equal(ends(second), 1, 'a tab not in a call ended the meeting as it closed');
  assert.equal(second.readyState, 3, 'the socket stayed open with no meeting page left');
  // The next call, in a new tab, starts on a connection of its own.
  const next = makeTab({});
  next.fromPage({ kind: 'meeting', t: 13, platform: 'meet', code: 'nop-qrst-uvw', title: 'Meet: Seguinte' });
  await settle();
  const third = sockets[sockets.length - 1];
  assert.notEqual(third, second, 'no connection for the next call');
  third.open();
  await settle();
  assert.deepEqual([...new Set(third.json().map((e) => e.code || e.kind))], ['hello', 'nop-qrst-uvw'], 'the next call did not start clean');

  console.log(`ok: ${live.names.size} participants and ${live.sources.size} audio sources decoded; after the app restarts it is told again of ${again.names.size} participants and the ${again.sources.size} sources still present`);
})().catch((e) => { console.error(e); process.exit(1); });
