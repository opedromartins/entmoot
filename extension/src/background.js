// Holds the WebSocket to the local app and forwards what the tabs capture.
// Audio goes as binary frames; everything else as JSON text frames.
'use strict';

const URLS = ['ws://127.0.0.1:17865', 'ws://localhost:17865'];
const TOKEN = 'dev'; // spike only; pairing comes with the real app
const MAX_QUEUE = 2000; // JSON messages kept while the app is unreachable

let ws = null;
let devFull = false; // the app asks for every frame the pages see (developer mode)
let attempt = 0;
let retryTimer = null;
const queue = [];
const ports = new Set();
const live = new Set(); // tabs with a call going on

function connect() {
  if (ws || retryTimer) return;
  const url = URLS[attempt % URLS.length];
  const sock = new WebSocket(url);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    attempt = 0;
    console.log('[mt] connected', url);
    sock.send(JSON.stringify({ kind: 'hello', token: TOKEN, version: browser.runtime.getManifest().version }));
    for (const m of queue.splice(0)) sock.send(m);
    // The app starts every connection knowing nothing about the call; the
    // tabs tell it again who is there and what the meeting is.
    for (const port of ports) {
      try { port.postMessage({ kind: 'resync' }); } catch (_) {}
    }
  };
  // The app only ever says one thing: whether it wants everything (dev).
  sock.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let m;
    try { m = JSON.parse(e.data); } catch (_) { return; }
    if (!m || m.kind !== 'dev') return;
    devFull = m.full === true;
    for (const port of ports) {
      try { port.postMessage({ kind: 'dev', full: devFull }); } catch (_) {}
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return; // hung up on purpose
    ws = null;
    devFull = false; // the next connection says it again
    attempt++;
    if (ports.size > 0) retryTimer = setTimeout(() => { retryTimer = null; connect(); }, Math.min(5000, 500 * attempt));
  };
  sock.onerror = () => {};
}

// No meeting page is left. To the app the connection is a page being open,
// and this script may stay awake long after the last one closed.
function hangUp() {
  clearTimeout(retryTimer);
  retryTimer = null;
  const sock = ws;
  ws = null;
  devFull = false;
  if (sock) sock.close();
  queue.length = 0; // of calls that are over
}

function base64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// stream:u8 | seq:u32 LE | t_ms:u64 LE | PCM s16le 16 kHz mono
function audioFrame(m) {
  const pcm = new Uint8Array(m.pcm);
  const out = new Uint8Array(13 + pcm.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, m.stream);
  dv.setUint32(1, m.seq, true);
  dv.setBigUint64(5, BigInt(Math.round(m.t)), true);
  out.set(pcm, 13);
  return out.buffer;
}

// Frames are decoded one at a time so their events keep the order they
// arrived in (decoding is asynchronous: frames may be gzipped).
let decoding = Promise.resolve();

function forward(m, port, tabId) {
  const open = ws && ws.readyState === WebSocket.OPEN;
  if (m.kind === 'audio') {
    if (open) ws.send(audioFrame(m)); // audio is dropped while disconnected
    return;
  }
  if (m.kind === 'meeting') live.add(tabId);
  if (m.kind === 'meeting_end') {
    TeamsDecode.ended(tabId);
    // Every page says this on its way out, in a call or not, and the app
    // closes the meeting on it: another tab's call may be the one going on.
    if (!live.delete(tabId)) return;
  }
  const { __mt, bytes, ...rest } = m;
  if (bytes) rest.b64 = base64(bytes);
  rest.tab = tabId;
  sendJson(rest);
  if (m.kind === 'raw' && m.dir === 'in' && bytes) {
    const teams = m.label.startsWith('teams-');
    decoding = decoding
      .then(() => (teams ? TeamsDecode.decode(m.label, new Uint8Array(bytes), tabId) : MeetDecode.decode(m.label, new Uint8Array(bytes))))
      .then((events) => {
        if (!events.length) return;
        const stamped = events.map((ev) => ({ ...ev, t: m.t }));
        for (const ev of stamped) sendJson({ ...ev, tab: tabId });
        // The tab keeps the roster: it outlives this script and the app.
        try { port.postMessage({ kind: 'decoded', events: stamped }); } catch (_) {}
      })
      .catch((e) => sendJson({ kind: 'log', t: m.t, event: 'decode-error', data: { label: m.label, error: String(e) }, tab: tabId }));
  }
}

function sendJson(obj) {
  const text = JSON.stringify(obj);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(text);
  else if (queue.length < MAX_QUEUE) queue.push(text);
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mt') return;
  ports.add(port);
  connect();
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : -1;
  port.onMessage.addListener((m) => forward(m, port, tabId));
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    TeamsDecode.forget(tabId);
    // A tab that closes seldom gets to say that its call ended. Told behind
    // what is still being decoded, which belongs to that call.
    decoding = decoding.then(() => {
      if (live.delete(tabId)) sendJson({ kind: 'meeting_end', t: Date.now(), tab: tabId });
      if (ports.size === 0) hangUp();
    });
  });
  // A tab that connects with the socket already open (this script was
  // restarted, say) has nobody else to ask it for its state.
  if (ws && ws.readyState === WebSocket.OPEN) {
    port.postMessage({ kind: 'resync' });
    if (devFull) port.postMessage({ kind: 'dev', full: true });
  }
});
