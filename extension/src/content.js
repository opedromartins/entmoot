// Relays messages from page-hook.js (page world) to the background script and
// remembers the state of the call. The app may start (or restart) with the
// call already under way, and Meet sends the roster only once, so the app is
// told again on request. This script lives as long as the page; the
// background script does not. Also where the user's choices in the
// extension's menu take effect: nothing leaves a page whose platform is off.
(() => {
  'use strict';

  const platform = location.hostname === 'meet.google.com' ? 'meet' : 'teams';
  let on = null; // not known until the storage answers
  let captions = false;
  let held = []; // what the hook said meanwhile
  let hookListening = false, toldHook = false;

  let port = null;
  let meeting = null;
  const participants = new Map(); // deviceId -> event
  const sources = new Map(); // csrc -> event

  function fromBackground(m) {
    if (!m) return;
    if (m.kind === 'resync') {
      if (meeting) send(meeting);
      for (const p of participants.values()) send(p);
      for (const s of sources.values()) send(s);
    } else if (m.kind === 'dev') {
      // The app wants every frame, not only the first ones of each channel.
      try { window.postMessage({ __mtExt: 1, dev: m.full === true }, location.origin); } catch (_) {}
    } else if (m.kind === 'decoded') {
      // What the background script read in the frames this tab relayed.
      for (const ev of m.events) {
        if (ev.kind === 'participant') {
          // Only some mentions of the user's own device say that it is theirs.
          const known = participants.get(ev.deviceId);
          participants.set(ev.deviceId, known && known.self ? { ...ev, self: true } : ev);
        }
        else if (ev.kind === 'source') sources.set(ev.csrc, ev);
        else if (ev.kind === 'source_removed') sources.delete(ev.csrc);
      }
    }
  }

  const connect = () => {
    port = browser.runtime.connect({ name: 'mt' });
    port.onDisconnect.addListener(() => { port = null; });
    port.onMessage.addListener(fromBackground);
  };

  const send = (m) => {
    try {
      if (!port) connect();
      port.postMessage(m);
    } catch (_) {
      port = null;
    }
  };

  // The hook cannot read the settings nor ask where the extension's files
  // are; told once, when both are known and it is known to be listening.
  function tellHook() {
    if (on === null || !hookListening || toldHook) return;
    toldHook = true;
    try { window.postMessage({ __mtExt: 1, worklet: browser.runtime.getURL('src/tap-worklet.js'), on, captions }, location.origin); } catch (_) {}
  }

  function relay(m) {
    if (m.kind === 'meeting') {
      // A plain copy: the original belongs to the page.
      meeting = { kind: 'meeting', t: m.t, platform: m.platform, code: m.code, title: m.title };
    } else if (m.kind === 'meeting_end') {
      meeting = null;
      participants.clear();
      sources.clear();
    }
    send(m);
  }

  MtSettings.load().then((settings) => {
    on = settings[platform] !== false;
    captions = on && settings[`${platform}Captions`] === true;
    tellHook();
    const waiting = held;
    held = [];
    if (on) for (const m of waiting) relay(m);
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__mt !== 1) return;
    hookListening = true;
    tellHook();
    if (on === null) held.push(e.data);
    else if (on) relay(e.data);
  });
})();
