// What page-hook.js needs to know about Microsoft Teams on the web, as
// recorded in docs/spikes.md: one remote audio track with everyone mixed,
// the roster over HTTP and a WebSocket, captions on a data channel. Loaded
// before page-hook.js, which calls this with what it offers. Nothing here
// sends anything to Teams or reads a request's headers.
window.__mtPlatform = (hook) => {
  'use strict';
  const { now, log, forwardRaw } = hook;

  // When the user chose so in the extension's menu, the page's own captions
  // button is clicked this long after joining, if nobody in the meeting has
  // captions on. The captions panel then shows on screen.
  const CAPTIONS_AFTER_MS = 10000;
  const CAPTIONS_TRIES = 2;
  // The tab's title is the meeting's only some seconds after joining.
  const TITLE_AFTER_MS = 6000;
  // Teams gives no audio level per source. A source is only listed while
  // its voice is in the mix, so being listed counts as this much.
  const PRESENT = 0.5;

  const utf8 = new TextDecoder();
  const text = (data) => {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return utf8.decode(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return utf8.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return null;
  };
  const parsed = (data) => {
    const s = text(data);
    if (s !== null) return JSON.parse(s);
    return data && typeof data === 'object' && !(data instanceof Blob) ? data : null; // an XHR that asked for JSON
  };

  // ---- the meeting ---------------------------------------------------------

  let code = '', subject = '', tabTitle = '';
  // The remote audio of the call going on. More than one for a moment: being
  // let in from the lobby moves the call to another connection, whose track
  // arrives before the lobby's ends.
  const callTracks = new Set();
  let captionsSeen = false, captionsOnAtJoin = false;
  let timers = [];

  // The meeting's number is in the address only while the page loads.
  const numberIn = (s) => { const found = /\/meet\/(\d+)/.exec(s || ''); return found ? found[1] : ''; };
  try { code = numberIn(decodeURIComponent(location.hash + location.search)); } catch (_) {}

  // "Reunião com Ana | Microsoft Teams", with other parts in front at times.
  function titleInTab() {
    const parts = String(document.title).split(' | ').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2 || !/Teams$/.test(parts[parts.length - 1])) return '';
    return parts[parts.length - 2];
  }

  function remoteAudio(track) {
    // Not every track that ends says so.
    for (const known of callTracks) if (known.readyState !== 'live') callTracks.delete(known);
    const underWay = callTracks.size > 0;
    callTracks.add(track);
    // The page stays open after the call, so the call's end has to be told.
    track.addEventListener('ended', () => {
      if (!callTracks.delete(track) || callTracks.size > 0) return;
      timers.forEach(clearTimeout);
      timers = [];
      code = '';
      subject = '';
      tabTitle = '';
      captionsOnAtJoin = false;
      hook.left();
    });
    if (underWay) return;
    captionsSeen = false;
    tabTitle = '';
    hook.joined();
    // Read once: later the user may be elsewhere in Teams with the call on.
    timers.push(setTimeout(() => {
      tabTitle = titleInTab();
      hook.postMeeting();
    }, TITLE_AFTER_MS));
    // Off unless chosen: two of the three buttons it clicks were never seen in a recording.
    if (window === window.top) timers.push(setTimeout(() => { if (hook.captions()) turnOnCaptions(1); }, CAPTIONS_AFTER_MS));
  }

  // ---- roster --------------------------------------------------------------

  // Joining is a POST to the call service, to `.../epconv` and then to
  // `.../conv/<id>` (`cpconv` and `cp/` for personal accounts). The request
  // names the user's own device; the answer has everyone in the call. Only
  // what the app needs of either goes on.
  const CALL_SERVICE = /^https:\/\/[a-z0-9.-]*flightproxy\.[a-z0-9.-]+\/api\/v2\/(?:(?:ep|cp)conv|(?:ep|cp)\/[^/]+\/conv\/[^/?]+)(?:\?|$)/i;
  const joins = (method, url) => method === 'POST' && CALL_SERVICE.test(String(url));

  function http(method, url, answer, sent) {
    if (!joins(method, url)) return;
    if (sent) {
      sent.then((data) => {
        const from = parsed(data).participants.from;
        if (typeof from.id === 'string' && typeof from.endpointId === 'string') forwardRaw('teams-self', 0, 'in', JSON.stringify({ id: from.id, endpointId: from.endpointId }));
      }).catch(() => {});
    }
    answer().then((data) => {
      const body = parsed(data);
      if (!body || typeof body !== 'object') return;
      if (typeof body.subject === 'string' && body.subject.trim()) subject = body.subject.trim();
      const number = numberIn(body.meetingDetails && body.meetingDetails.joinUrl);
      if (number) code = number;
      const people = body.roster && body.roster.participants;
      if (people && typeof people === 'object') {
        captionsOnAtJoin = Object.values(people).some(captioning);
        forwardRoster(people);
      }
      hook.postMeeting();
    }).catch(() => {});
  }

  // A person in the roster comes with much the app has no use for, links
  // that act on the call among it. What goes on is the name and, for each
  // device, the audio source:
  //   { <person id>: { name, sources: [sourceId, ...] } }
  function forwardRoster(people) {
    const out = {};
    for (const [id, person] of Object.entries(people)) {
      if (!person || typeof person !== 'object') continue;
      const name = person.details && person.details.displayName;
      const sources = [];
      for (const endpoint of Object.values(person.endpoints || {})) {
        const streams = endpoint && endpoint.call && endpoint.call.mediaStreams;
        for (const s of Array.isArray(streams) ? streams : []) if (s && s.type === 'audio' && Number.isInteger(s.sourceId)) sources.push(s.sourceId);
      }
      out[id] = { name: typeof name === 'string' ? name : null, sources };
    }
    forwardRaw('teams-roster', 0, 'in', JSON.stringify(out));
  }

  // The transcription bot, when captions are on for someone.
  function captioning(person) {
    try {
      return Object.values(person.endpoints || {}).some((e) => e.endpointMetadata.processingModes.closedCaptions.state === 'Active');
    } catch (_) {
      return false;
    }
  }

  // Who joins, leaves or changes afterwards comes over the page's WebSocket
  // to the trouter service, as frames `3:::{json}` that mimic an HTTP request
  // whose body is the roster's change: JSON, or JSON gzipped and written in
  // base64, with `participants` as in the answer above.
  const NativeSocket = window.WebSocket;
  if (NativeSocket) {
    const Socket = function (...args) {
      const ws = new NativeSocket(...args);
      try {
        if (/trouter/i.test(String(args[0]))) ws.addEventListener('message', (ev) => { try { fromTrouter(ev.data); } catch (_) {} });
      } catch (_) {}
      return ws;
    };
    Socket.prototype = NativeSocket.prototype;
    Object.setPrototypeOf(Socket, NativeSocket);
    window.WebSocket = Socket;
  }

  function fromTrouter(data) {
    if (typeof data !== 'string' || !data.startsWith('3:::') || !data.includes('rosterUpdate')) return;
    const request = JSON.parse(data.slice(4));
    if (!/\/rosterUpdate\/?$/.test(String(request.url).split('?')[0])) return;
    const body = request.body;
    if (typeof body !== 'string' || !body) return;
    // One at a time: unpacking is asynchronous and the changes have an order.
    updates = updates.then(async () => {
      let json = body;
      if (!body.trimStart().startsWith('{')) {
        const packed = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
        json = await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      }
      const people = JSON.parse(json).participants;
      if (people && typeof people === 'object') forwardRoster(people);
    }).catch(() => {});
  }
  let updates = Promise.resolve();

  // ---- captions ------------------------------------------------------------

  // `main-channel` carries, among heartbeats and bandwidth estimates, the
  // captions: a short binary header and then JSON with `recognitionResults`.
  function received(ch, data) {
    if (ch.label !== 'main-channel') return;
    const look = (bytes) => {
      if (!utf8.decode(bytes).includes('"recognitionResults"')) return;
      captionsSeen = true;
      forwardRaw('teams-captions', ch.__mtId, 'in', bytes);
    };
    if (data instanceof ArrayBuffer) look(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) look(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else if (data instanceof Blob) data.arrayBuffer().then((ab) => look(new Uint8Array(ab)), () => {});
  }

  // Captions reach everyone in the meeting once anyone turns them on, which
  // makes Teams bring a transcription bot in. Doing that from here would mean
  // inviting the bot with the user's own credentials, so the page is left to
  // do it: this clicks More > Language and speech > Show live captions. Only
  // the last of the three buttons was seen in a recording; the other two are
  // the ones other extensions use, and the log tells if they are not there.
  const MORE = '#callingButtons-showMoreBtn';
  const LANGUAGE = '#LanguageSpeechMenuControl-id';
  const CAPTIONS = '#closed-captions-button';
  const PANEL = '[data-tid="closed-caption-renderer-wrapper"]';
  const MENU_MS = 600;

  function turnOnCaptions(attempt) {
    if (callTracks.size === 0) return;
    const on = captionsSeen || captionsOnAtJoin || !!document.querySelector(PANEL);
    if (on) return log('captions-ui', { attempt, already: true });
    const later = (fn) => timers.push(setTimeout(() => { try { fn(); } catch (e) { log('captions-ui', { attempt, error: String(e) }); } }, MENU_MS));
    const again = () => {
      if (attempt < CAPTIONS_TRIES) timers.push(setTimeout(() => turnOnCaptions(attempt + 1), CAPTIONS_AFTER_MS));
    };
    const finish = () => {
      const button = document.querySelector(CAPTIONS);
      if (!button) {
        log('captions-ui', { attempt, step: 'captions', found: false });
        close();
        return again();
      }
      const was = button.getAttribute('aria-checked');
      if (was === 'true') close();
      else button.click();
      log('captions-ui', { attempt, step: 'captions', found: true, was });
    };
    // Leaves no menu open behind.
    const close = () => {
      try {
        const button = document.querySelector(MORE);
        if (button && button.getAttribute('aria-expanded') === 'true') button.click();
        else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      } catch (_) {}
    };

    const more = document.querySelector(MORE);
    if (!more) {
      log('captions-ui', { attempt, step: 'more', found: false });
      return again();
    }
    more.click();
    later(() => {
      if (document.querySelector(CAPTIONS)) return finish();
      const language = document.querySelector(LANGUAGE);
      if (!language) {
        log('captions-ui', { attempt, step: 'language', found: false });
        close();
        return again();
      }
      language.click();
      later(finish);
    });
  }

  return {
    name: 'teams',
    code: () => code,
    title: () => subject || tabTitle,
    level: (source) => (source.audioLevel === undefined || source.audioLevel === null ? PRESENT : source.audioLevel),
    micMutedInUi: () => !!document.querySelector('#microphone-button[data-state="mic-off"]'),
    wantsRequest: joins,
    received, http, remoteAudio,
  };
};
