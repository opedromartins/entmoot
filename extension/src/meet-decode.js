// Decoders for Google Meet's data-channel frames (protobuf, no schema).
// Layouts were read off live frames recorded in Zen on 2026-11-10; see
// docs/spikes.md. Meet changes these without notice, so every decoder returns
// an empty list instead of throwing when a frame does not fit.
'use strict';

const MeetDecode = (() => {
  const DEVICE = /^spaces\/[^/]+\/devices\/[^/]+$/;
  const utf8 = new TextDecoder('utf-8', { fatal: true });

  function varint(b, p) {
    let v = 0, mul = 1;
    for (let i = 0; i < 10; i++) {
      if (p >= b.length) return null;
      const byte = b[p++];
      v += (byte & 0x7f) * mul; // not bit ops: ids exceed 32 bits
      if (!(byte & 0x80)) return [v, p];
      mul *= 128;
    }
    return null;
  }

  // -> [{ f: field, w: wire type, v: number | Uint8Array }] or null if not protobuf
  function walk(b) {
    const out = [];
    let p = 0;
    while (p < b.length) {
      const tag = varint(b, p);
      if (!tag) return null;
      p = tag[1];
      const f = Math.floor(tag[0] / 8), w = tag[0] % 8;
      if (f === 0) return null;
      if (w === 0) {
        const v = varint(b, p);
        if (!v) return null;
        out.push({ f, w, v: v[0] });
        p = v[1];
      } else if (w === 2) {
        const n = varint(b, p);
        if (!n || n[1] + n[0] > b.length) return null;
        out.push({ f, w, v: b.subarray(n[1], n[1] + n[0]) });
        p = n[1] + n[0];
      } else if (w === 1) p += 8;
      else if (w === 5) p += 4;
      else return null;
    }
    return out;
  }

  const msg = (fields) => ({
    num: (n) => { const x = fields.find((x) => x.f === n && x.w === 0); return x ? x.v : null; },
    str: (n) => {
      const x = fields.find((x) => x.f === n && x.w === 2);
      if (!x) return null;
      try { return utf8.decode(x.v); } catch (_) { return null; }
    },
    sub: (n) => { const x = fields.find((x) => x.f === n && x.w === 2); return x ? walk(x.v) : null; },
    all: (n) => fields.filter((x) => x.f === n && x.w === 2).map((x) => walk(x.v)).filter(Boolean),
  });

  async function gunzip(bytes) {
    if (bytes.length < 3 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) return bytes;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Roster and media sources. Entries sit at varying depths (a join is one
  // device, the first frame is everyone), so the tree is searched for them:
  //   participant: { 1: deviceId, 2: display name, 3: avatar url }
  //   source:      { 2: 1 audio | 2 video, 6: deviceId, 8: { 1: csrc }, 10: { 1: muted } }
  // The device this browser joined with comes, in the roster fetched over
  // HTTP, with tokens nobody else's has (7 and 22, the same text). So does
  // what that device presents, which is a device of its own that names its
  // owner in 21 and is not the person.
  const own = (fields) => {
    const has = (n) => fields.some((x) => x.f === n && x.w === 2 && x.v.length > 0);
    return has(7) && has(22) && !has(21);
  };

  function scan(fields, depth, out) {
    const m = msg(fields);
    const f1 = m.str(1), f6 = m.str(6);
    if (f1 && DEVICE.test(f1)) {
      const name = m.str(2);
      if (name) {
        const ev = { kind: 'participant', deviceId: f1, name, avatar: m.str(3) };
        if (own(fields)) ev.self = true;
        out.push(ev);
      }
      return;
    }
    if (f6 && DEVICE.test(f6)) {
      const id = m.sub(8), mute = m.sub(10);
      const csrc = id && msg(id).num(1);
      if (csrc != null) {
        const type = m.num(2);
        out.push({
          kind: 'source', deviceId: f6, csrc,
          media: type === 1 ? 'audio' : type === 2 ? 'video' : String(type),
          muted: mute ? msg(mute).num(1) === 1 : null,
        });
        return;
      }
    }
    if (depth >= 8) return;
    for (const x of fields) {
      if (x.w !== 2 || x.v.length < 2) continue;
      const inner = walk(x.v);
      if (inner) scan(inner, depth + 1, out);
    }
  }

  async function collections(bytes) {
    const out = [];
    try {
      const top = walk(await gunzip(bytes));
      if (!top) return out;
      scan(top, 0, out);
      // Removed sources: 1 > 2 > 3 > repeated 3: { 3: "csrc", 4: type }
      const a = msg(top).sub(1), b = a && msg(a).sub(2), c = b && msg(b).sub(3);
      for (const gone of c ? msg(c).all(3) : []) {
        const csrc = Number(msg(gone).str(3));
        if (Number.isFinite(csrc) && csrc > 0) out.push({ kind: 'source_removed', csrc });
      }
    } catch (_) {}
    return out;
  }

  // The roster Meet fetches over HTTP when joining (SyncMeetingSpaceCollections):
  // the names of everyone already in the call, which the data channel never
  // repeats. A gRPC-web body: optionally base64 text, then frames of
  // `flags:u8 | length:u32 BE | message`, the message optionally gzipped and
  // holding the same participant entries as the channel.
  const BASE64 = /^[A-Za-z0-9+/_=\s-]+$/;

  function fromBase64Text(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    if (!BASE64.test(text)) return bytes;
    // Each frame may be encoded on its own, so padding can sit mid-text.
    const parts = [];
    for (const chunk of text.replace(/\s/g, '').match(/[^=]+={0,2}/g) || []) {
      const bin = atob(chunk.replace(/-/g, '+').replace(/_/g, '/'));
      parts.push(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  // -> the messages of a gRPC-web body, or the body itself if it is not framed
  function grpcMessages(b) {
    const out = [];
    let p = 0;
    while (p + 5 <= b.length) {
      const len = ((b[p + 1] << 24) | (b[p + 2] << 16) | (b[p + 3] << 8) | b[p + 4]) >>> 0;
      if (b[p] & 0x7e || p + 5 + len > b.length) return [b];
      if (!(b[p] & 0x80)) out.push(b.subarray(p + 5, p + 5 + len)); // 0x80 marks trailers
      p += 5 + len;
    }
    return p === b.length && out.length ? out : [b];
  }

  async function rpcCollections(bytes) {
    const out = [];
    try {
      for (const message of grpcMessages(fromBase64Text(bytes))) {
        const top = walk(await gunzip(message));
        if (top) scan(top, 0, out);
      }
    } catch (_) {}
    return out;
  }

  // captions_v2: { 1: content }, or { 2: gzip(content) } once a line gets long.
  // content > repeated 1: { 1: messageId, 2: version, 3: { 3: text, 4: lang, 6: deviceId } }
  // A line is revised in place: same deviceId + messageId, growing version.
  async function captionsV2(bytes) {
    const out = [];
    try {
      const top = walk(await gunzip(bytes));
      if (!top) return out;
      const packed = top.find((x) => x.f === 2 && x.w === 2);
      const root = msg(top).sub(1) || (packed ? walk(await gunzip(packed.v)) : null);
      for (const line of root ? msg(root).all(1) : []) {
        const m = msg(line), body = m.sub(3);
        if (!body) continue;
        const b = msg(body), deviceId = b.str(6), text = b.str(3);
        if (!deviceId || !DEVICE.test(deviceId) || text == null) continue;
        out.push({ kind: 'caption', deviceId, messageId: m.num(1), version: m.num(2), text, lang: b.str(4) });
      }
    } catch (_) {}
    return out;
  }

  // Legacy "captions" channel: 1: { 1: deviceId, 2: messageId, 3: version, 6: text }
  async function captionsV1(bytes) {
    try {
      const top = walk(await gunzip(bytes));
      const line = top && msg(top).sub(1);
      if (!line) return [];
      const m = msg(line), deviceId = m.str(1), text = m.str(6);
      if (!deviceId || text == null) return [];
      return [{ kind: 'caption', deviceId, messageId: m.num(2), version: m.num(3), text, lang: null }];
    } catch (_) {
      return [];
    }
  }

  const byLabel = { collections, 'rpc-collections': rpcCollections, captions_v2: captionsV2, captions: captionsV1 };
  return { decode: (label, bytes) => (byLabel[label] ? byLabel[label](bytes) : Promise.resolve([])) };
})();

if (typeof module !== 'undefined') module.exports = MeetDecode;
