// Runs in the page's own world at document_start, before the page's scripts
// and right after the file of the platform the page belongs to (page-meet.js
// or page-teams.js). Wraps WebRTC so it can observe the call: remote audio,
// the outgoing mic and who is speaking. What only one platform has, such as
// where its roster and captions come from, is in that platform's file.
// Everything goes out through window.postMessage; content.js relays it.
(() => {
  'use strict';
  if (window.__mtHook) return;
  window.__mtHook = true;
  const makePlatform = window.__mtPlatform;
  try { delete window.__mtPlatform; } catch (_) {}
  if (typeof makePlatform !== 'function') return;

  const OUT_RATE = 16000;
  const FRAME_SAMPLES = 1600; // 100 ms
  const SPEAKER_POLL_MS = 90;
  const MAX_RAW_BYTES = 256 * 1024;

  // What the user chose in the extension's menu, as content.js tells it some
  // milliseconds after the page starts loading. Until then nothing is turned
  // on in the page, and nothing said here gets past content.js.
  let off = false; // the platform is not to be transcribed
  let captionsWanted = false;
  // The app's developer mode asks for every frame of every channel, instead
  // of the first ones. Told by content.js when the app says so, and again if
  // that changes.
  let dumpAll = false;

  const now = () => performance.timeOrigin + performance.now();
  const post = (msg, transfer) => {
    if (off) return;
    try {
      window.postMessage({ __mt: 1, ...msg }, location.origin, transfer || []);
    } catch (_) {}
  };
  const log = (event, data) => post({ kind: 'log', t: now(), event, data });

  // A frame the background script will decode, or keep for diagnosis.
  function forwardRaw(label, chan, dir, data) {
    const send = (ab) => {
      if (ab.byteLength > MAX_RAW_BYTES) return log('raw-too-big', { label, bytes: ab.byteLength });
      post({ kind: 'raw', t: now(), label, chan, dir, bytes: ab }, [ab]);
    };
    if (typeof data === 'string') send(new TextEncoder().encode(data).buffer);
    else if (data instanceof ArrayBuffer) send(data.slice(0));
    else if (ArrayBuffer.isView(data)) send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    else if (data instanceof Blob) data.arrayBuffer().then(send, () => {});
  }

  // What the platform's file may use from here. The functions it names are
  // defined further down; none is called before this file has run.
  const platform = makePlatform({
    now, post, log, forwardRaw,
    joined: () => joined(),
    left: () => left(),
    postMeeting: () => postMeeting(),
    // Whether to turn captions on without the user doing it. Asked when the
    // time comes, not on loading: the answer arrives later.
    captions: () => captionsWanted,
    // Whether to forward every frame, not only the ones the platform knows to use.
    dump: () => dumpAll,
    // The browser's own send, not the wrapped one.
    channelSend: (ch, data) => send.call(ch, data),
  });

  // ---- audio ---------------------------------------------------------------

  // Downsamples to 16 kHz mono s16 and cuts 100 ms frames. emit also gets the
  // index, in the input block, of the sample that completed the frame. Also
  // used, as source text, inside the AudioWorklet, so it must not reference
  // anything outside. tap-worklet.js has a copy.
  function makeFramer(inRate, outRate, frameSamples, emit) {
    const step = inRate / outRate;
    let pos = 0, acc = 0, n = 0;
    let buf = new Int16Array(frameSamples), i = 0, seq = 0;
    return (input) => {
      for (let k = 0; k < input.length; k++) {
        acc += input[k]; n++; pos += 1;
        if (pos >= step) {
          pos -= step;
          const v = Math.max(-1, Math.min(1, acc / n));
          acc = 0; n = 0;
          buf[i++] = v * 32767;
          if (i === frameSamples) {
            emit(buf.buffer, seq++, k);
            buf = new Int16Array(frameSamples); i = 0;
          }
        }
      }
    };
  }

  const WORKLET_SRC = `
    ${makeFramer.toString()}
    class MtTap extends AudioWorkletProcessor {
      constructor() {
        super();
        this.feed = makeFramer(sampleRate, ${OUT_RATE}, ${FRAME_SAMPLES},
          (buf, seq, k) => this.port.postMessage({ buf, seq, end: currentTime + (k + 1) / sampleRate }, [buf]));
      }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) this.feed(ch);
        return true;
      }
    }
    registerProcessor('mt-tap', MtTap);
  `;

  // What content.js says: where the extension's own copy of the worklet is,
  // and the user's choices.
  let extensionWorklet = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__mtExt !== 1) return;
    // Each message says only part of this.
    if (typeof e.data.dev === 'boolean') dumpAll = e.data.dev;
    if (typeof e.data.worklet === 'string') extensionWorklet = e.data.worklet;
    if ('captions' in e.data) captionsWanted = e.data.captions === true;
    if (e.data.on === false) {
      off = true;
      for (const c of [...captures.values()]) c.stop();
    }
  });

  let ctx = null;
  let workletReady = null; // Promise<boolean>
  const captures = new Map(); // streamId -> { stop, receiver }
  let nextRemoteStream = 1; // 0 is the microphone

  function ensureCtx() {
    if (ctx) return ctx;
    ctx = new AudioContext();
    log('audio-ctx', { rate: ctx.sampleRate, state: ctx.state });
    const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
    for (const ev of ['click', 'keydown', 'pointerdown']) window.addEventListener(ev, resume, true);
    ctx.addEventListener('statechange', () => log('audio-ctx-state', { state: ctx.state }));
    workletReady = (async () => {
      const load = async (url, via) => {
        try {
          await ctx.audioWorklet.addModule(url);
          log('worklet', { ok: true, via });
          return true;
        } catch (e) {
          log('worklet', { ok: false, via, error: String(e) });
          return false;
        }
      };
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      let ok = await load(url, 'blob');
      URL.revokeObjectURL(url);
      // Teams refuses a worklet made from a blob and takes the extension's file.
      if (!ok && extensionWorklet) ok = await load(extensionWorklet, 'extension');
      return ok;
    })();
    return ctx;
  }

  // Wall-clock time (epoch ms) of audio-clock zero. Re-anchored only on a real
  // jump, so the main thread's coarse view of currentTime adds no jitter.
  let epochOffset = null;
  function ctxEpoch() {
    const o = now() - ctx.currentTime * 1000;
    if (epochOffset === null || Math.abs(o - epochOffset) > 250) epochOffset = o;
    return epochOffset;
  }

  async function capture(streamId, track, receiver, meta) {
    if (off) return;
    const ac = ensureCtx();
    const prev = captures.get(streamId);
    if (prev) prev.stop();

    // A remote track only produces samples while someone is audible on it, so
    // frames are stamped from the audio clock, not counted from the start.
    const emit = (buf, seq, endCtxTime) => {
      const t = ctxEpoch() + endCtxTime * 1000 - (FRAME_SAMPLES / OUT_RATE) * 1000;
      if (streamId === 0) holdMicFrame({ seq, t, pcm: buf });
      else post({ kind: 'audio', stream: streamId, seq, t, pcm: buf }, [buf]);
      pollSpeakers();
    };

    const src = ac.createMediaStreamSource(new MediaStream([track]));
    let node, mode;
    if (await workletReady) {
      node = new AudioWorkletNode(ac, 'mt-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (e) => emit(e.data.buf, e.data.seq, e.data.end);
      src.connect(node);
      node.connect(ac.destination); // output stays silent; keeps the node being pulled
      mode = 'worklet';
    } else {
      node = ac.createScriptProcessor(4096, 1, 1);
      let blockStart = 0;
      const feed = makeFramer(ac.sampleRate, OUT_RATE, FRAME_SAMPLES,
        (buf, seq, k) => emit(buf, seq, blockStart + (k + 1) / ac.sampleRate));
      node.onaudioprocess = (e) => {
        blockStart = ac.currentTime;
        feed(e.inputBuffer.getChannelData(0));
      };
      src.connect(node);
      node.connect(ac.destination); // a ScriptProcessor only runs when connected
      mode = 'script-processor';
    }
    const stop = () => {
      try { src.disconnect(); node.disconnect(); } catch (_) {}
      if (node.port) node.port.onmessage = null; else node.onaudioprocess = null;
      if (captures.get(streamId)?.stop === stop) captures.delete(streamId);
    };
    captures.set(streamId, { stop, receiver, track });
    track.addEventListener('ended', () => { log('track-ended', { stream: streamId }); stop(); });
    track.addEventListener('mute', () => log('track-mute', { stream: streamId }));
    track.addEventListener('unmute', () => log('track-unmute', { stream: streamId }));
    post({ kind: 'stream', t: now(), stream: streamId, mode, ...meta });
  }

  // ---- microphone ----------------------------------------------------------

  // The microphone is captured from the track the call sends. A track from
  // getUserMedia is not the same thing: it can stay live while the call is
  // muted, and then everything said on mute would be transcribed.
  let micSender = null;
  const peers = []; // every RTCPeerConnection the page made
  const senderPeer = new WeakMap(); // sender -> the connection it was seen on

  const closed = (pc) => pc.connectionState === 'closed' || pc.signalingState === 'closed';
  // Whether the sender's connection is over. Its track may well stay live:
  // Teams moves the call to another connection and keeps the microphone.
  function gone(sender) {
    const pc = senderPeer.get(sender);
    if (!pc) return false;
    try { return closed(pc) || !pc.getSenders().includes(sender); } catch (_) { return false; }
  }

  function micTrack(sender, track) {
    if (!track || track.kind !== 'audio') {
      if (sender !== micSender) return;
      const c = captures.get(0);
      if (c) c.stop();
      return log('mic', { track: null });
    }
    const current = micSender && micSender.track;
    // A second audio sender is something else, such as a shared tab's sound.
    if (micSender && micSender !== sender && current && current.readyState === 'live' && !gone(micSender)) return;
    if (micSender === sender && captures.get(0)?.track === track) return;
    if (micSender !== sender) micStats = null; // another sender counts from zero
    micSender = sender;
    capture(0, track, null, { source: 'mic', trackId: track.id });
  }

  // Whether the microphone is muted is read off what actually leaves the
  // machine, so it does not matter how the page mutes: a muted call sends
  // nothing, or encoded silence, which is a few bytes per packet where a
  // voice is dozens. Microphone frames wait here until the sender's
  // statistics cover their time, and go out as silence (not as a gap: the
  // app closes the open utterance on silence) unless the call was sending.
  const MIC_STATS_MS = 200;
  const MIC_PAD_MS = 300; // a voice keeps the frames this close to it
  const MIC_AUDIBLE_BYTES = 30; // average packet payload that means sound
  const MIC_FRAME_MS = (FRAME_SAMPLES / OUT_RATE) * 1000;
  let micQueue = [];
  let micVerdicts = []; // { from, to, audible }
  let micStats = null; // previous sample: { t, bytes, packets }
  let micPolling = false, micPolledAt = 0, micStatsFailures = 0;
  let micAudible = null, micReportedAt = 0;

  function holdMicFrame(frame) {
    micQueue.push(frame);
    pollMicStats();
  }

  function pollMicStats() {
    const t = now();
    if (micPolling || !micSender || t - micPolledAt < MIC_STATS_MS) return;
    micPolling = true;
    micPolledAt = t;
    micSender.getStats().then((report) => {
      let bytes = 0, packets = 0, found = false;
      report.forEach((s) => {
        if (s.type !== 'outbound-rtp' || (s.kind || s.mediaType) !== 'audio') return;
        found = true;
        bytes += s.bytesSent || 0;
        packets += s.packetsSent || 0;
      });
      if (!found) throw new Error('no outbound-rtp audio');
      const at = now();
      if (micStats && packets >= micStats.packets) {
        const sent = packets - micStats.packets;
        const size = sent > 0 ? (bytes - micStats.bytes) / sent : 0;
        const audible = size >= MIC_AUDIBLE_BYTES;
        micVerdicts.push({ from: micStats.t, to: at, audible });
        if (audible !== micAudible || at - micReportedAt > 10000) {
          micAudible = audible;
          micReportedAt = at;
          const track = micSender.track;
          log('mic-sending', { audible, packets: sent, bytesPerPacket: Math.round(size), enabled: track && track.enabled, mutedInUi: micMutedInUi() });
        }
      }
      micStats = { t: at, bytes, packets };
      micStatsFailures = 0;
    }).catch((e) => {
      if (++micStatsFailures === 5) log('mic-stats-failed', { error: String(e) });
    }).then(() => {
      micPolling = false;
      flushMic();
    });
  }

  function flushMic() {
    // With no statistics there is no telling: the audio goes through.
    const blind = micStatsFailures >= 5;
    const known = micVerdicts.length ? micVerdicts[micVerdicts.length - 1].to : 0;
    while (micQueue.length) {
      const f = micQueue[0], end = f.t + MIC_FRAME_MS;
      if (!blind && end + MIC_PAD_MS > known) break;
      micQueue.shift();
      const sending = blind || micVerdicts.some((v) => v.audible && v.to > f.t - MIC_PAD_MS && v.from < end + MIC_PAD_MS);
      if (!sending || micMutedInUi()) new Int16Array(f.pcm).fill(0);
      post({ kind: 'audio', stream: 0, seq: f.seq, t: f.t, pcm: f.pcm }, [f.pcm]);
    }
    if (micVerdicts.length > 100) micVerdicts = micVerdicts.slice(-50);
    if (micQueue.length > 300) micQueue = micQueue.slice(-100); // statistics stalled
  }

  // For a microphone attached in a way the hooks below do not see, and for
  // the one of a connection that took the place of the microphone's.
  function findMic() {
    if (captures.has(0) && !(micSender && gone(micSender))) return;
    for (const pc of peers) {
      if (closed(pc)) continue;
      for (const sender of pc.getSenders()) {
        if (sender.track && sender.track.kind === 'audio' && sender.track.readyState === 'live') {
          senderPeer.set(sender, pc);
          return micTrack(sender, sender.track);
        }
      }
    }
  }

  // Second opinion on mute, from the page's own microphone button. A
  // platform that cannot tell counts as not muted.
  let mutedCheckedAt = 0, mutedInUi = false;
  function micMutedInUi() {
    const t = now();
    if (t - mutedCheckedAt > 300) {
      mutedCheckedAt = t;
      try {
        mutedInUi = !!(platform.micMutedInUi && platform.micMutedInUi());
      } catch (_) {
        mutedInUi = false;
      }
    }
    return mutedInUi;
  }

  // ---- meeting -------------------------------------------------------------

  // What the meeting is called is often known only some time after joining,
  // so it is told again whenever it changes.
  let inCall = false, sentMeeting = null;
  function postMeeting() {
    if (!inCall) return;
    const code = String(platform.code() || '');
    const title = String(platform.title ? platform.title() : document.title);
    if (`${code}\n${title}` === sentMeeting) return;
    sentMeeting = `${code}\n${title}`;
    post({ kind: 'meeting', t: now(), platform: platform.name, code, title });
  }

  function joined() {
    inCall = true;
    sentMeeting = null;
    postMeeting();
  }

  // For a page that stays open after the call.
  function left() {
    if (!inCall) return;
    inCall = false;
    post({ kind: 'meeting_end', t: now() });
    // The next call counts its streams from the start, once this one's are gone.
    setTimeout(() => {
      if (!inCall && ![...captures.keys()].some((stream) => stream !== 0)) nextRemoteStream = 1;
    }, 1000);
  }

  // ---- who is speaking -----------------------------------------------------

  // Driven by audio frames, not a timer: timers are throttled in hidden tabs.
  let lastPoll = 0, lastSlowPoll = 0;
  function pollSpeakers() {
    const t = now();
    if (t - lastPoll < SPEAKER_POLL_MS) return;
    lastPoll = t;
    if (t - lastSlowPoll > 2000) {
      lastSlowPoll = t;
      try { postMeeting(); findMic(); } catch (_) {}
    }
    const level = platform.level || ((s) => s.audioLevel);
    const streams = [];
    for (const [stream, c] of captures) {
      if (!c.receiver) continue;
      const pick = (list) => list.map((s) => ({ id: s.source, level: level(s), ts: s.timestamp }));
      try {
        streams.push({
          stream,
          csrc: pick(c.receiver.getContributingSources()),
          ssrc: pick(c.receiver.getSynchronizationSources()),
        });
      } catch (_) {}
    }
    if (streams.length) post({ kind: 'speakers', t, streams });
  }

  // ---- data channels -------------------------------------------------------

  const tapped = new WeakSet();
  let chanSeq = 0;

  function tap(pc, ch, via) {
    if (!ch || tapped.has(ch)) return;
    tapped.add(ch);
    const id = ++chanSeq;
    const label = ch.label;
    ch.__mtId = id;
    log('channel', { id, label, via, state: ch.readyState });
    let count = 0;
    ch.addEventListener('message', (ev) => {
      count++;
      try { if (platform.received) platform.received(ch, ev.data, count); } catch (_) {}
    });
    ch.addEventListener('open', () => log('channel-open', { id, label }));
    ch.addEventListener('close', () => log('channel-close', { id, label, frames: count }));
    try { if (platform.channel) platform.channel(pc, ch); } catch (_) {}
  }

  // ---- requests ------------------------------------------------------------

  // Some of what the call is comes over HTTP. The platform says which
  // requests it wants: `answer` gives the response body when called, and
  // `sent` is the request's own body, kept only if the platform asked for it.
  const nativeFetch = window.fetch;
  if (platform.http && typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const target = args[0];
      let url = '', method = 'GET', sent = null;
      try {
        url = typeof target === 'string' ? target : (target && target.url) || target;
        method = String((args[1] && args[1].method) || (target && target.method) || 'GET').toUpperCase();
        // A Request's body can only be copied before it is sent.
        if (platform.wantsRequest && platform.wantsRequest(method, url)) {
          const given = args[1] && args[1].body;
          sent = given != null ? Promise.resolve(given) : typeof Request !== 'undefined' && target instanceof Request ? target.clone().arrayBuffer() : null;
        }
      } catch (_) {}
      const p = nativeFetch.apply(this, args);
      try {
        // An answer that never ends is not one to wait for.
        const whole = (response) => (/event-stream/i.test(response.headers.get('content-type') || '') ? Promise.reject(new Error('stream')) : response.clone().arrayBuffer());
        platform.http(method, url, () => p.then(whole), sent);
      } catch (_) {}
      return p;
    };
  }
  if (platform.http) {
    const xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        const verb = String(method).toUpperCase();
        const answer = () => new Promise((resolve, reject) => {
          this.addEventListener('load', () => {
            try { resolve(this.responseType === '' || this.responseType === 'text' ? this.responseText : this.response); } catch (e) { reject(e); }
          });
          this.addEventListener('error', reject);
        });
        if (platform.wantsRequest && platform.wantsRequest(verb, url)) {
          // The body only comes with send; the platform is told then.
          this.__mtRequest = (data) => platform.http(verb, url, answer, data == null ? null : Promise.resolve(data));
        } else {
          platform.http(verb, url, answer, null);
        }
      } catch (_) {}
      return xhrOpen.call(this, method, url, ...rest);
    };
    if (platform.wantsRequest) {
      const xhrSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (data) {
        try {
          const told = this.__mtRequest;
          if (told) {
            this.__mtRequest = null;
            told(data);
          }
        } catch (_) {}
        return xhrSend.apply(this, arguments);
      };
    }
  }

  // ---- WebRTC hooks --------------------------------------------------------

  const Native = window.RTCPeerConnection;
  if (!Native) return log('no-rtc', {});

  let pcSeq = 0;
  function instrument(pc) {
    const id = ++pcSeq;
    peers.push(pc);
    log('pc', { id });
    pc.addEventListener('connectionstatechange', () => log('pc-state', { id, state: pc.connectionState }));
    pc.addEventListener('datachannel', (e) => tap(pc, e.channel, 'remote'));
    pc.addEventListener('track', (e) => {
      const meta = { pc: id, media: e.track.kind, mid: e.transceiver && e.transceiver.mid, trackId: e.track.id };
      log('track', meta);
      if (e.track.kind !== 'audio') return;
      capture(nextRemoteStream++, e.track, e.receiver, { source: 'remote', ...meta });
      try { if (platform.remoteAudio) platform.remoteAudio(e.track); } catch (_) {}
    });
  }

  function Wrapped(...args) {
    const pc = new Native(...args);
    try { instrument(pc); } catch (e) { log('instrument-error', { error: String(e) }); }
    return pc;
  }
  Wrapped.prototype = Native.prototype;
  Object.setPrototypeOf(Wrapped, Native);
  window.RTCPeerConnection = Wrapped;

  const createDataChannel = Native.prototype.createDataChannel;
  Native.prototype.createDataChannel = function (...args) {
    const ch = createDataChannel.apply(this, args);
    try { tap(this, ch, 'local'); } catch (_) {}
    return ch;
  };

  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    try { if (platform.sent) platform.sent(this, data); } catch (_) {}
    return send.apply(this, arguments);
  };

  // Every way the page can hand the call an outgoing audio track.
  const addTrack = Native.prototype.addTrack;
  Native.prototype.addTrack = function (track, ...rest) {
    const sender = addTrack.call(this, track, ...rest);
    try {
      senderPeer.set(sender, this);
      micTrack(sender, track);
    } catch (_) {}
    return sender;
  };
  const addTransceiver = Native.prototype.addTransceiver;
  Native.prototype.addTransceiver = function (what, ...rest) {
    const transceiver = addTransceiver.call(this, what, ...rest);
    try {
      senderPeer.set(transceiver.sender, this);
      if (what instanceof MediaStreamTrack) micTrack(transceiver.sender, what);
    } catch (_) {}
    return transceiver;
  };
  const replaceTrack = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function (track) {
    const p = replaceTrack.call(this, track);
    p.then(() => {
      try { if (track ? track.kind === 'audio' : this === micSender) micTrack(this, track); } catch (_) {}
    }, () => {});
    return p;
  };

  // Closing fires no event, and the microphone may have been on this one.
  const close = Native.prototype.close;
  Native.prototype.close = function () {
    const result = close.apply(this, arguments);
    try { findMic(); } catch (_) {}
    return result;
  };

  window.addEventListener('pagehide', () => post({ kind: 'meeting_end', t: now() }));
  log('hooked', { ua: navigator.userAgent, platform: platform.name });
})();
