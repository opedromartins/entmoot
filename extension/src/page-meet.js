// What page-hook.js needs to know about Google Meet: the data channels that
// carry the roster and the captions, how to have captions without the CC
// button, and the request that brings who was already in the call. Loaded
// before page-hook.js, which calls this with what it offers.
window.__mtPlatform = (hook) => {
  'use strict';
  const { now, log, forwardRaw } = hook;

  // Channels whose every frame is forwarded.
  const KNOWN_CHANNELS = new Set(['collections', 'captions', 'captions_v2']);
  // Other channels: only the first frames, to learn what they carry; all of
  // them while the app's developer mode asks for the full dump (hook.dump()).
  const EXPLORE_LIMIT = 200;
  // Unless the user chose otherwise in the extension's menu (hook.captions()),
  // captions are had without the CC button in two ways. Meet only sends them
  // on a channel the client opens, so one of our own is opened, for when the
  // account allows it; and the server is asked for them on joining, as Meet
  // does when CC is clicked.

  const ownCaptions = new WeakSet(); // peer connections we already opened one on
  // The call's `collections` channels still open. Meet stays on the page
  // after the call, and says nothing: the channel closing is the end. A
  // connection made only to probe has one too, which closes while the
  // call's stays.
  const rosters = new Set();

  function received(ch, data, count) {
    if (KNOWN_CHANNELS.has(ch.label) || count <= EXPLORE_LIMIT || hook.dump()) forwardRaw(ch.label, ch.__mtId, 'in', data);
  }

  function channel(pc, ch) {
    const label = ch.label;
    if (label === 'captions_v2') capWatch(ch);
    if (label === 'collections') {
      rosters.add(ch);
      ch.addEventListener('close', () => {
        if (rosters.delete(ch) && rosters.size === 0) hook.left();
      });
      hook.joined();
      if (!ownCaptions.has(pc)) {
        ownCaptions.add(pc);
        setTimeout(() => {
          if (!hook.captions()) return;
          try {
            pc.createDataChannel('captions', { ordered: true, maxRetransmits: 10 });
            log('own-captions', { ok: true });
          } catch (e) {
            log('own-captions', { ok: false, error: String(e) });
          }
        }, 3000);
      }
    }
  }

  // What the page itself sends, to learn how Meet asks for captions.
  const OUT_LABELS = new Set(['media-session', 'captions', 'captions_v2']);
  const outCount = new Map();
  function sent(ch, data) {
    const all = hook.dump();
    if (all || OUT_LABELS.has(ch.label)) {
      const n = (outCount.get(ch.label) || 0) + 1;
      outCount.set(ch.label, n);
      if (all || n <= EXPLORE_LIMIT) forwardRaw(ch.label, ch.__mtId || 0, 'out', data);
    }
    const st = capStates.get(ch);
    if (st) capContent(data).then((content) => capPageSent(st, content)).catch(() => {});
  }

  // Meet's own microphone button. Finding no such button counts as not muted.
  const micMutedInUi = () => !!document.querySelector(
    '[data-is-muted="true"][aria-label*="micr" i], button[aria-label^="Ativar microfone" i], button[aria-label^="Ativar o microfone" i], button[aria-label^="Turn on microphone" i]');

  // ---- captions without the CC button --------------------------------------

  // Meet opens `captions_v2` on joining, but the server only sends captions
  // on it once the client asks, which Meet does when CC is clicked. Here the
  // same request goes out on Meet's own channel a few seconds after joining,
  // so captions arrive with CC off and nothing shows on screen. The frames,
  // as recorded (docs/spikes.md):
  //   frame:   { 1: content } or { 2: gzip(content) }
  //   content: { 1: repeated entry or receipt, 2: request or its answer, 6: time }
  //   request: { 1: id, 2: { 1: { 2: spoken language, 3: caption language } } }
  //   entry:   { 1: messageId, 2: version, N: payload }   (N is 3 for a caption)
  //   receipt: { 1: messageId, 2: version, N: 1 }
  // Meet answers every entry with a receipt. Whether it still does so for
  // captions it did not ask for is not known, so entries the page leaves
  // without a receipt get one from here.
  const CAP_ASK_DELAY_MS = 4000; // Meet asks by itself when it remembers CC as on; a connection made only to probe is closed by then
  const CAP_ANSWER_MS = 5000; // the server answers a request in well under a second
  const CAP_MAX_ASKS = 3;
  const CAP_RECEIPT_MS = 200; // Meet's own receipts leave within some 10 ms
  const capStates = new WeakMap(); // channel -> state
  let capAskId = 1000000; // far from Meet's own request ids, which count from 1

  // Meet's numbering of caption languages, for reading the one the user
  // last picked (as the Scribbl extension does; not confirmed in Firefox).
  const MEET_LANGUAGES = {
    1: 'en-US', 2: 'es-MX', 3: 'es-ES', 4: 'pt-BR', 5: 'fr-FR', 6: 'de-DE', 7: 'it-IT', 8: 'nl-NL', 9: 'ja-JP', 10: 'ru-RU',
    11: 'ko-KR', 17: 'pt-PT', 18: 'hi-IN', 19: 'en-IN', 20: 'en-GB', 21: 'en-CA', 22: 'en-AU', 23: 'nl-BE', 24: 'sv-SE', 25: 'nb-NO',
    34: 'cmn-Hans-CN', 35: 'cmn-Hant-TW', 36: 'yue-Hant-HK', 37: 'th-TH', 38: 'tr-TR', 39: 'pl-PL', 40: 'ro-RO', 41: 'id-ID', 42: 'vi-VN', 43: 'ms-MY',
    44: 'uk-UA', 47: 'ar-EG', 60: 'ar-AE', 73: 'fr-CA', 74: 'xh-ZA', 75: 'nso-ZA', 76: 'st-ZA', 77: 'ss-latn-ZA', 78: 've-ZA', 79: 'tn-latn-ZA',
    80: 'ts-ZA', 81: 'bg-BG', 82: 'km-KH', 83: 'rw-RW', 84: 'ar-x-GULF', 85: 'ar-x-LEVANT', 86: 'ar-x-MAGHREBI', 87: 'bn-BD', 88: 'gu-IN', 89: 'kn-IN',
    90: 'ml-IN', 91: 'mr-IN', 93: 'cs-CZ', 95: 'fi-FI', 96: 'lo-LA', 97: 'sw', 98: 'af-ZA', 99: 'am-ET', 100: 'az-AZ', 101: 'el-GR',
    102: 'en-PH', 103: 'eu-ES', 104: 'fa-IR', 105: 'iw-IL', 106: 'hu-HU', 107: 'hy-AM', 108: 'jv-ID', 109: 'mn-MN', 112: 'sk-SK', 113: 'sq-AL',
    114: 'ta-IN', 115: 'te-IN', 116: 'ur-PK', 117: 'uz-UZ', 118: 'zu-ZA', 119: 'et-EE', 120: 'fil-PH', 121: 'is-IS', 122: 'ka-GE', 123: 'su-ID',
    125: 'mk-MK', 126: 'my-MM', 127: 'ne-NP', 128: 'si-LK', 129: 'ca-ES', 130: 'gl-ES', 131: 'lt-LT', 132: 'lv-LV', 133: 'sl-SI', 134: 'sr-RS',
    191: 'kk-KZ',
  };

  // Protobuf without a schema; the background script has its own copy in
  // meet-decode.js, which cannot be loaded into the page.
  function pbVarint(b, p) {
    let v = 0, mul = 1;
    for (let i = 0; i < 10 && p < b.length; i++) {
      const byte = b[p++];
      v += (byte & 0x7f) * mul;
      if (!(byte & 0x80)) return [v, p];
      mul *= 128;
    }
    return null;
  }
  // -> [{ f: field, w: wire type, v: number | Uint8Array }] or null if not protobuf
  function pbWalk(b) {
    const out = [];
    let p = 0;
    while (p < b.length) {
      const tag = pbVarint(b, p);
      if (!tag) return null;
      p = tag[1];
      const f = Math.floor(tag[0] / 8), w = tag[0] % 8;
      if (f === 0) return null;
      if (w === 0) {
        const v = pbVarint(b, p);
        if (!v) return null;
        out.push({ f, w, v: v[0] });
        p = v[1];
      } else if (w === 2) {
        const n = pbVarint(b, p);
        if (!n || n[1] + n[0] > b.length) return null;
        out.push({ f, w, v: b.subarray(n[1], n[1] + n[0]) });
        p = n[1] + n[0];
      } else if (w === 1) p += 8;
      else if (w === 5) p += 4;
      else return null;
    }
    return out;
  }
  const pbGet = (fields, f, w) => {
    const x = fields && fields.find((x) => x.f === f && x.w === w);
    return x ? x.v : null;
  };
  const pbSub = (fields, f) => {
    const v = pbGet(fields, f, 2);
    return v ? pbWalk(v) : null;
  };
  function pbInt(v) {
    const out = [];
    while (v > 127) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
    out.push(v);
    return out;
  }
  const pbNum = (f, v) => [...pbInt(f * 8), ...pbInt(v)];
  const pbLen = (f, bytes) => [...pbInt(f * 8 + 2), ...pbInt(bytes.length), ...bytes];

  // -> the fields of a frame's content, or null
  async function capContent(data) {
    let bytes;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
    else return null;
    const top = pbWalk(bytes);
    const plain = pbGet(top, 1, 2);
    if (plain) return pbWalk(plain);
    const packed = pbGet(top, 2, 2);
    if (!packed) return null;
    const unpacked = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
    return pbWalk(new Uint8Array(await new Response(unpacked).arrayBuffer()));
  }

  // The language to ask captions in: the one picked in Meet's settings, else
  // the browser's first language that Meet transcribes.
  function capLanguage() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('rt_g3jartmcups')) continue;
        const stored = JSON.parse(localStorage.getItem(key));
        const code = stored && MEET_LANGUAGES[stored[2]];
        if (code) return [code, 'meet-settings'];
      }
    } catch (_) {}
    const known = Object.values(MEET_LANGUAGES);
    for (const tag of navigator.languages || []) {
      const code = known.includes(tag) ? tag : known.find((k) => k.split('-')[0] === tag.split('-')[0]);
      if (code) return [code, 'browser'];
    }
    return ['en-US', 'default'];
  }

  function capWatch(ch) {
    const st = {
      ch,
      lang: null, // the language Meet itself last asked for
      pageOn: false, // Meet asked for captions (CC is on)
      asked: false, asks: 0, askId: null, askTimer: null, gaveUp: false,
      owed: [], owedTimer: null, // entries waiting to see if the page answers them
      receipts: new Set(), // those the page did answer
      answering: false,
    };
    capStates.set(ch, st);
    const joined = () => capAskLater(st, CAP_ASK_DELAY_MS, 'joined');
    if (ch.readyState === 'open') joined();
    else ch.addEventListener('open', joined);
    ch.addEventListener('message', (ev) => {
      capContent(ev.data).then((content) => capReceived(st, content)).catch(() => {});
    });
  }

  function capAskLater(st, delay, why) {
    clearTimeout(st.askTimer);
    st.askTimer = setTimeout(() => capAsk(st, why), delay);
  }

  function capAsk(st, why) {
    if (!hook.captions() || st.ch.readyState !== 'open' || st.pageOn) return;
    if (st.asks >= CAP_MAX_ASKS) {
      if (!st.gaveUp) log('captions-ask', { gaveUp: true, asks: st.asks });
      st.gaveUp = true;
      return;
    }
    const [lang, from] = st.lang ? [st.lang, 'meet'] : capLanguage();
    const id = ++capAskId;
    const code = [...new TextEncoder().encode(lang)];
    const request = [...pbNum(1, id), ...pbLen(2, pbLen(1, [...pbLen(2, code), ...pbLen(3, code)]))];
    try {
      hook.channelSend(st.ch, new Uint8Array(pbLen(1, pbLen(2, request))));
    } catch (e) {
      return log('captions-ask', { error: String(e) });
    }
    st.asked = true;
    st.asks++;
    st.askId = id;
    log('captions-ask', { id, lang, from, why, attempt: st.asks });
    capAskLater(st, CAP_ANSWER_MS, 'unanswered');
  }

  function capReceived(st, content) {
    if (!content) return;
    const answer = pbSub(content, 2);
    if (answer && st.askId !== null && pbGet(answer, 1, 0) === st.askId) {
      clearTimeout(st.askTimer);
      log('captions-ask-answered', { id: st.askId, fields: answer.map((x) => x.f) });
      st.askId = null;
      st.asks = 0;
    }
    for (const x of content) {
      if (x.f !== 1 || x.w !== 2) continue;
      const entry = pbWalk(x.v);
      const payload = entry && entry.find((y) => y.w === 2 && y.f >= 3);
      const version = pbGet(entry, 2, 0);
      if (!payload || version === null) continue;
      const id = pbGet(entry, 1, 0);
      st.owed.push({
        key: `${id}/${version}/${payload.f}`,
        at: now(),
        receipt: [...(id === null ? [] : pbNum(1, id)), ...pbNum(2, version), ...pbNum(payload.f, 1)],
      });
    }
    if (st.owed.length && !st.owedTimer) st.owedTimer = setTimeout(() => capAnswer(st), CAP_RECEIPT_MS);
  }

  // Sends the receipts the page had its chance to send and did not.
  function capAnswer(st) {
    st.owedTimer = null;
    const ripe = now() - CAP_RECEIPT_MS + 20;
    const due = [], early = [];
    for (const o of st.owed) {
      if (o.at > ripe) early.push(o);
      else if (!st.receipts.delete(o.key)) due.push(o);
    }
    st.owed = early;
    if (early.length) st.owedTimer = setTimeout(() => capAnswer(st), CAP_RECEIPT_MS);
    if (st.receipts.size > 500) st.receipts.clear();
    // Captions Meet asked for by itself are Meet's to answer.
    if (!due.length || !st.asked || st.ch.readyState !== 'open') return;
    try {
      hook.channelSend(st.ch, new Uint8Array(pbLen(1, due.flatMap((o) => pbLen(1, o.receipt)))));
    } catch (_) {
      return;
    }
    if (!st.answering) {
      st.answering = true;
      log('captions-receipts', { by: 'hook' });
    }
  }

  // What Meet itself sends on the channel: receipts, and requests when CC is
  // clicked or the language changed.
  function capPageSent(st, content) {
    if (!content) return;
    for (const x of content) {
      if (x.f !== 1 || x.w !== 2) continue;
      const receipt = pbWalk(x.v);
      const mark = receipt && receipt.find((y) => y.w === 0 && y.f >= 3);
      if (mark) st.receipts.add(`${pbGet(receipt, 1, 0)}/${pbGet(receipt, 2, 0)}/${mark.f}`);
    }
    const request = pbSub(content, 2);
    if (!request) return;
    let lang = null;
    try {
      const code = pbGet(pbSub(pbSub(request, 2), 1), 2, 2);
      if (code) lang = new TextDecoder('utf-8', { fatal: true }).decode(code);
    } catch (_) {}
    if (lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) {
      st.lang = lang;
      st.pageOn = true;
      clearTimeout(st.askTimer);
      log('captions-page', { on: true, lang });
    } else if (st.asked) {
      // Any other request may be CC being turned off (never recorded), which
      // would stop the captions; asking again is harmless if it was not.
      st.pageOn = false;
      st.asks = 0;
      st.gaveUp = false;
      log('captions-page', { on: false });
      capAskLater(st, 1000, 'meet changed them');
    }
  }

  // ---- roster over HTTP ----------------------------------------------------

  // The data channel only tells of people who join or leave after us. Who was
  // already in the call comes in the answer to this request, made on joining.
  const ROSTER_RPC = 'SyncMeetingSpaceCollections';
  const rpcSeen = new Set();
  function http(method, url, answer) {
    url = String(url);
    const at = url.indexOf('/$rpc/');
    if (at < 0 && !url.includes(ROSTER_RPC)) return;
    const name = at < 0 ? ROSTER_RPC : url.slice(at + 6).split('?')[0];
    // Each request name once: tells where to look if the roster moves.
    if (!rpcSeen.has(name) && rpcSeen.size < 60) {
      rpcSeen.add(name);
      log('rpc', { name });
    }
    if (name.includes(ROSTER_RPC)) answer().then((data) => forwardRaw('rpc-collections', 0, 'in', data), () => {});
  }

  return {
    name: 'meet',
    code: () => location.pathname.split('/').filter(Boolean).pop() || '',
    received, channel, sent, http, micMutedInUi,
  };
};
