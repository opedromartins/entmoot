// Runs the extension's page, content and background scripts outside the
// browser against a Teams session recorded by the spike (docs/spikes.md),
// and checks what reaches the app: the meeting, the roster with the user's
// own id, the captions as lines, the end of the call, and all of it again
// after the app restarts with the call under way. Also that a call which
// moves to another connection stays one meeting and keeps the microphone;
// that part is not from a recording.
//   node tools/replay/teams-test.js recordings/<session>
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const assert = require('assert');

const src = (name) => fs.readFileSync(path.join(__dirname, '../../extension/src', name), 'utf8');
const session = process.argv[2];
if (!session) throw new Error('usage: node teams-test.js recordings/<session>');

// ---- the recording ----------------------------------------------------------
const all = fs.readFileSync(path.join(session, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// A recording may hold what other tabs had queued; the call is in one.
const perTab = new Map();
for (const e of all) if (e.kind === 'raw' && e.label === 'main-channel') perTab.set(e.tab, (perTab.get(e.tab) || 0) + 1);
const tab = [...perTab].sort((a, b) => b[1] - a[1]).map(([id]) => id)[0];
assert(tab !== undefined, 'the session has no main-channel frames: not a Teams recording');
const recorded = all.filter((e) => e.tab === tab && e.kind === 'raw');
const bytes = (e) => Buffer.from(e.b64 || '', 'base64');
const personal = recorded.some((e) => e.label.includes('flightproxy.skype.com'));

// The spike wrote request names with their ids starred out; any address of
// the same shape does.
const service = personal ? 'https://api.flightproxy.skype.com/api/v2' : 'https://api.flightproxy.teams.microsoft.com/api/v2';
const side = personal ? 'cp' : 'ep';
function address(label) {
  const [, method, rest] = /^http:(\S+) \S+?\/api\/v2\/(.*)$/.exec(label) || [];
  if (!method) return null;
  return { method, url: `${service}/${rest.replace(/\*/g, () => 'x1')}?i=1`.replace(`/${side}/x1/`, `/${side}/conv.example/`) };
}

// ---- sockets, ports and the two extension scripts, as in extension-test.js --
const sockets = [];
class AppSocket {
  static OPEN = 1;
  constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
  send(data) { this.sent.push(data); }
  open() { this.readyState = 1; this.onopen(); }
  close() { this.readyState = 3; this.onclose(); }
  json() { return this.sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m)); }
}
const listeners = () => { const fns = []; return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.forEach((fn) => fn(...a)) }; };
const onConnect = listeners();
function connectPort() {
  const tabSide = { onMessage: listeners(), onDisconnect: listeners() };
  const bg = { name: 'mt', sender: { tab: { id: 7 } }, onMessage: listeners(), onDisconnect: listeners() };
  tabSide.postMessage = (m) => bg.onMessage.fire(structuredClone(m));
  bg.postMessage = (m) => tabSide.onMessage.fire(structuredClone(m));
  onConnect.fire(bg);
  return tabSide;
}
const background = vm.createContext({
  browser: { runtime: { onConnect, getManifest: () => ({ version: 'test' }) } },
  WebSocket: AppSocket, console: { log: () => {} }, btoa, atob, TextDecoder, Blob, Response, DecompressionStream, Uint8Array, DataView, BigInt,
  setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {},
});
for (const name of ['meet-decode.js', 'teams-decode.js', 'background.js']) vm.runInContext(src(name), background);

// ---- a Teams page ------------------------------------------------------------
class Target {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  fire(type, ev = {}) { for (const fn of this.listeners[type] || []) fn(ev); }
}
class RTCDataChannel extends Target {
  constructor(label) { super(); this.label = label; this.readyState = 'open'; }
  send() {}
}
class RTCPeerConnection extends Target {
  constructor() { super(); this.senders = []; this.connectionState = 'new'; this.signalingState = 'stable'; }
  createDataChannel(label) { return new RTCDataChannel(label); }
  addTrack(track) {
    const sender = { track, getStats: async () => new Map() };
    this.senders.push(sender);
    return sender;
  }
  addTransceiver() { return {}; }
  getSenders() { return this.connectionState === 'closed' ? [] : this.senders; }
  close() { this.connectionState = 'closed'; this.signalingState = 'closed'; }
}
class RTCRtpSender { replaceTrack() { return Promise.resolve(); } }
class PageSocket extends Target {
  constructor(url) { super(); this.url = url; }
  send() {}
}
function XMLHttpRequest() {}
XMLHttpRequest.prototype.open = function () {};
XMLHttpRequest.prototype.send = function () {};
const silent = { connect() {}, disconnect() {} };
class AudioContext extends Target {
  constructor() { super(); this.sampleRate = 48000; this.state = 'running'; this.currentTime = 0; this.destination = {}; this.audioWorklet = { addModule: () => Promise.reject(new Error('no worklets here')) }; }
  createMediaStreamSource() { return silent; }
  createScriptProcessor() { return { ...silent }; }
}

const answers = new Map(); // url -> the recorded response
const posted = [];
const page = new Target();
let onPageMessage = () => {};
const pageContext = vm.createContext({
  RTCPeerConnection, RTCDataChannel, RTCRtpSender, XMLHttpRequest, WebSocket: PageSocket, AudioContext,
  atob, Response, DecompressionStream,
  MediaStream: class {}, MediaStreamTrack: class {}, KeyboardEvent: class {},
  ArrayBuffer, Uint8Array, Int16Array, Blob, TextEncoder, TextDecoder, URL, Promise, JSON,
  performance, setTimeout, clearTimeout,
  location: { origin: 'https://teams.example', hostname: 'teams.microsoft.com', pathname: '/v2/', search: '?meetingjoin=true', hash: '#/meet/2530155108990000?p=abc&anon=true' },
  document: { title: 'Ingresso na reunião | Reunião com Ana Teste | Microsoft Teams', querySelector: () => null, body: { dispatchEvent: () => {} } },
  navigator: { userAgent: 'test' },
  fetch: (url) => Promise.resolve({ headers: { get: () => 'application/json' }, clone: () => ({ arrayBuffer: async () => Uint8Array.from(answers.get(url) || []).buffer }) }),
});
Object.assign(pageContext, {
  window: pageContext,
  top: pageContext,
  addEventListener: (type, fn) => page.addEventListener(type, fn),
  // Straight to content.js, as the browser does between the two worlds.
  postMessage: (m) => { posted.push(m); onPageMessage({ source: contentWindow, data: m }); },
});
// What content.js tells the hook goes the other way.
const told = [];
const contentWindow = { addEventListener: (_, fn) => { onPageMessage = fn; }, postMessage: (m) => { told.push(m); page.fire('message', { source: vm.runInContext('window', pageContext), data: m }); } };
const contentBrowser = {
  runtime: { connect: connectPort, getURL: (file) => `moz-extension://test/${file}` },
  storage: { local: { get: async (defaults) => ({ ...defaults }) } },
};
const contentContext = vm.createContext({ window: contentWindow, browser: contentBrowser, Map, location: { origin: 'https://teams.example', hostname: 'teams.microsoft.com' } });
for (const name of ['settings.js', 'content.js']) vm.runInContext(src(name), contentContext);
for (const name of ['page-teams.js', 'page-hook.js']) vm.runInContext(src(name), pageContext);

const settle = () => new Promise((r) => setTimeout(r, 80));
const of = (events, kind) => events.filter((e) => e.kind === kind);

(async () => {
  const app = () => sockets[sockets.length - 1];
  await settle(); // content.js reads the settings before it relays anything
  assert.deepEqual(told.map((m) => [m.on, m.captions]), [[true, false]], 'the hook was not told the default settings');
  assert(app(), 'the hook said nothing: the background script never connected');
  app().open();

  // What the page asked the call service, in the order it did.
  const requests = new Map(); // name -> { method, url, sent, answer }
  for (const e of recorded.filter((e) => e.label.startsWith('http:') && e.label.includes('flightproxy'))) {
    const where = address(e.label);
    if (!where) continue;
    const r = requests.get(e.label) || { ...where, sent: null, answer: null };
    if (e.dir === 'out' && !r.sent) r.sent = bytes(e);
    if (e.dir === 'in' && !r.answer) r.answer = bytes(e);
    requests.set(e.label, r);
  }
  const joinNames = [...requests.keys()].filter((name) => /^http:POST \S+(\/(ep|cp)conv|\/conv\/\*)$/.test(name));
  assert(joinNames.length > 0, 'the session has no join request');
  for (const r of requests.values()) {
    answers.set(r.url, r.answer || Buffer.alloc(0));
    await pageContext.fetch(r.url, { method: r.method, body: r.sent ? r.sent.toString() : undefined });
  }
  await settle();

  // The call connects: the channel, the socket and the one remote track.
  const pc = new pageContext.RTCPeerConnection();
  const channel = pc.createDataChannel('main-channel');
  const trouter = new pageContext.WebSocket('wss://go.trouter.teams.microsoft.com/v4/c?tc=1');
  const audio = (id) => Object.assign(new Target(), { kind: 'audio', id, readyState: 'live' });
  const micStreams = (events) => of(events, 'stream').filter((e) => e.source === 'mic').map((e) => e.trackId);
  pc.addTrack(audio('m1'));
  const track = audio('t1');
  pc.fire('track', { track, receiver: { getContributingSources: () => [], getSynchronizationSources: () => [] }, transceiver: { mid: '0' } });
  await settle();

  const live = recorded.filter((e) => e.dir === 'in' && (e.label === 'main-channel' || e.label.startsWith('ws:')));
  for (const e of live) {
    if (e.label === 'main-channel') channel.fire('message', { data: Uint8Array.from(bytes(e)).buffer });
    else trouter.fire('message', { data: bytes(e).toString() });
  }
  await settle();
  await settle();
  const got = app().json();

  // ---- only what the app needs left the page --------------------------------
  const labels = new Set(posted.filter((m) => m.kind === 'raw').map((m) => m.label));
  for (const label of labels) assert(/^teams-(self|roster|captions)$/.test(label), `forwarded something else: ${label}`);
  const everything = JSON.stringify(got.map((e) => (e.b64 ? { ...e, b64: Buffer.from(e.b64, 'base64').toString('latin1') } : e)));
  for (const secret of ['Authorization', 'initiatorSkypeToken', 'callLinks', '"links"']) assert(!everything.includes(secret), `"${secret}" reached the app`);

  // ---- the meeting ------------------------------------------------------------
  const meeting = of(got, 'meeting').pop();
  assert(meeting && meeting.platform === 'teams', 'no Teams meeting announced');
  // The number in the join answer's link, when it has one, else the address's.
  const linked = joinNames.map((name) => {
    try { return /\/meet\/(\d+)/.exec(JSON.parse(requests.get(name).answer.toString()).meetingDetails.joinUrl)[1]; } catch (_) { return null; }
  }).find(Boolean);
  assert.equal(meeting.code, linked || '2530155108990000', 'the meeting has the wrong number');
  assert.equal(of(got, 'meeting')[0].title, '', 'a title was sent before the tab had the meeting\'s');

  // ---- the roster, against the recording read independently --------------------
  const expected = { names: new Set(), sources: new Map() };
  const read = (participants) => {
    for (const [id, p] of Object.entries(participants || {})) {
      if (!id.startsWith('8:')) continue;
      if (p.details && p.details.displayName) expected.names.add(id);
      for (const endpoint of Object.values(p.endpoints || {})) {
        for (const s of (endpoint.call && endpoint.call.mediaStreams) || []) if (s.type === 'audio') expected.sources.set(s.sourceId, id);
      }
    }
  };
  for (const name of joinNames) {
    try { read((JSON.parse(requests.get(name).answer.toString()).roster || {}).participants); } catch (_) {}
  }
  for (const e of live.filter((e) => e.label.startsWith('ws:'))) {
    const frame = bytes(e).toString();
    if (!frame.startsWith('3:::') || !frame.includes('rosterUpdate/')) continue;
    const body = JSON.parse(frame.slice(4)).body;
    read(JSON.parse(body.startsWith('{') ? body : zlib.gunzipSync(Buffer.from(body, 'base64')).toString()).participants);
  }
  assert(expected.names.size > 0 && expected.sources.size > 0, 'the session has no roster');
  const names = new Set(of(got, 'participant').map((e) => e.deviceId));
  assert.deepEqual([...names].sort(), [...expected.names].sort(), 'participants differ from the roster');
  const sources = new Map(of(got, 'source').map((e) => [e.csrc, e.deviceId]));
  assert.deepEqual([...sources].sort(), [...expected.sources].sort(), 'audio sources differ from the roster');
  assert(of(got, 'source').every((e) => e.media === 'audio' && e.muted === null));
  assert(![...names].some((id) => id.startsWith('28:')), 'a bot passed for a participant');

  // ---- the user's own id --------------------------------------------------------
  const own = new Set(of(got, 'participant').filter((e) => e.self).map((e) => e.deviceId));
  const joinRequest = joinNames.map((name) => requests.get(name).sent).find(Boolean);
  if (joinRequest) {
    assert.deepEqual([...own], [JSON.parse(joinRequest.toString()).participants.from.id], 'the user\'s own id not told apart');
  } else {
    console.log('note: the session has no request bodies (first spike round); the own id was not checked');
  }

  // ---- captions -------------------------------------------------------------------
  const results = [];
  for (const e of live.filter((e) => e.label === 'main-channel')) {
    const frame = bytes(e).toString();
    const at = frame.indexOf('{"version"');
    if (at < 0) continue;
    for (const r of JSON.parse(frame.slice(at)).recognitionResults || []) results.push(r);
  }
  const captions = of(got, 'caption');
  assert.equal(captions.length, results.length, 'captions lost or made up');
  if (results.length) {
    assert(captions.every((c, i) => c.deviceId === results[i].userId && c.text === results[i].text), 'captions changed on the way');
    const lines = new Set(captions.map((c) => `${c.deviceId}/${c.messageId}`));
    const finals = results.filter((r) => r.isFinal).length;
    // Each line ends with a final result; a speaker may have one still open.
    const speakers = new Set(results.map((r) => r.userId)).size;
    assert(lines.size >= finals && lines.size <= finals + speakers, `${lines.size} lines for ${finals} final results`);
    assert(captions.every((c) => names.has(c.deviceId)), 'a caption from someone not in the roster');
  }

  // ---- the app restarts with the call under way -------------------------------------
  const first = app();
  first.close();
  channel.fire('message', { data: new Uint8Array([1, 2, 3]).buffer });
  pageContext.postMessage({ __mt: 1, kind: 'log', t: 1, event: 'tick' });
  await settle();
  assert.notEqual(app(), first, 'no reconnection was attempted');
  app().open();
  await settle();
  const again = app().json();
  assert.deepEqual([...new Set(of(again, 'participant').map((e) => e.deviceId))].sort(), [...names].sort(), 'participants not resent');
  assert.deepEqual([...new Set(of(again, 'participant').filter((e) => e.self).map((e) => e.deviceId))], [...own], 'own id not resent as such');
  assert(of(again, 'meeting').length === 1, 'meeting not resent');

  // ---- let in from the lobby: the call moves to another connection --------------------
  assert.deepEqual(micStreams(got), ['m1'], 'the microphone was not captured');
  const pc2 = new pageContext.RTCPeerConnection();
  pc2.addTrack(audio('m2'));
  const track2 = audio('t2');
  pc2.fire('track', { track: track2, receiver: { getContributingSources: () => [], getSynchronizationSources: () => [] }, transceiver: { mid: '1' } });
  pc.close();
  track.readyState = 'ended';
  track.fire('ended');
  await settle();
  assert.equal(of(app().json(), 'meeting_end').length, 0, 'the call was taken to have ended when it moved to another connection');
  assert.deepEqual(micStreams(app().json()), ['m2'], 'the microphone stayed on the connection that closed');

  // ---- the call ends, the page stays --------------------------------------------------
  track2.readyState = 'ended';
  track2.fire('ended');
  await settle();
  assert.equal(of(app().json(), 'meeting_end').length, 1, 'the end of the call was not told');
  app().close();
  pageContext.postMessage({ __mt: 1, kind: 'log', t: 2, event: 'tick' });
  await settle();
  app().open();
  await settle();
  assert.equal(of(app().json(), 'participant').length, 0, 'the roster of a call that ended was resent');

  console.log(`ok: ${personal ? 'personal' : 'work'} account; ${names.size} participants, ${sources.size} audio sources, own id ${own.size ? 'found' : 'not checked'}; ${captions.length} caption results in ${new Set(captions.map((c) => `${c.deviceId}/${c.messageId}`)).size} lines; told again after the app restarts; the call's end told`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
