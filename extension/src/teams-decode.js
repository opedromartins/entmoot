// Decoders for what page-teams.js forwards of Microsoft Teams: the roster
// and the captions, all JSON. Layouts were read off sessions
// recorded in Zen on 2026-11-13; see docs/spikes.md. Teams may change them
// without notice, so every decoder returns an empty list instead of throwing
// when something does not fit.
//
// A person is one participant however many devices they joined with: the
// `deviceId` of the events is the person's id, and each device adds a source.
'use strict';

const TeamsDecode = (() => {
  const utf8 = new TextDecoder();
  // `8:orgid:...`, `8:live:...`, `8:guest:...`. Ids starting `28:` are bots.
  const PERSON = /^8:/;

  // What is remembered between frames, per tab. The background script may be
  // restarted mid-call and lose it: the user's own id is then missing from
  // later mentions (content.js and the app remember it), and a caption line
  // being revised becomes two.
  const tabs = new Map(); // tab -> { own, lines: userId -> messageId }
  const state = (tab) => {
    if (!tabs.has(tab)) tabs.set(tab, { own: null, lines: new Map() });
    return tabs.get(tab);
  };

  // teams-self: { id, endpointId }, from the request the page joins with.
  function self(bytes, st) {
    try {
      const from = JSON.parse(utf8.decode(bytes));
      if (typeof from.id === 'string' && PERSON.test(from.id)) st.own = from.id;
    } catch (_) {}
    return [];
  }

  // teams-roster: { <person id>: { name, sources: [sourceId, ...] } }, as
  // page-teams.js cuts it out of the answer to the join request and of every
  // later change. A sourceId is the CSRC the voice from one of the person's
  // devices has in the mixed audio; someone still in the lobby has none.
  function roster(bytes, st) {
    const out = [];
    try {
      for (const [id, person] of Object.entries(JSON.parse(utf8.decode(bytes)))) {
        if (!PERSON.test(id) || !person || typeof person !== 'object') continue;
        if (typeof person.name === 'string' && person.name) {
          const ev = { kind: 'participant', deviceId: id, name: person.name };
          if (st.own === id) ev.self = true;
          out.push(ev);
        }
        for (const csrc of Array.isArray(person.sources) ? person.sources : []) {
          if (!Number.isInteger(csrc) || csrc <= 0) continue;
          // Muted is left unsaid: a muted voice is not in the mix anyway, and
          // a stale "muted" would throw away what the person said.
          out.push({ kind: 'source', deviceId: id, csrc, media: 'audio', muted: null });
        }
      }
    } catch (_) {}
    return out;
  }

  // teams-captions: a binary header, then
  //   { recognitionResults: [{ userId, id: "<session>/<n>", text, isFinal, spokenLanguage }] }
  // A line is revised by successive results, each with its own n, until one
  // is final. The line takes the number of its first result.
  function lineNumber(id) {
    const found = /^([0-9a-f]{8})[^/]*\/(\d+)$/i.exec(String(id));
    if (!found) return null;
    // The session keeps lines of two caption runs apart; both fit a double.
    return parseInt(found[1], 16) * 0x100000 + (Number(found[2]) % 0x100000);
  }

  function captions(bytes, st) {
    const out = [];
    try {
      const frame = utf8.decode(bytes);
      let content = null;
      // The header is a few bytes, and one of them may look like a brace.
      for (let at = frame.indexOf('{'); at >= 0 && at < 64 && !content; at = frame.indexOf('{', at + 1)) {
        try { content = JSON.parse(frame.slice(at)); } catch (_) {}
      }
      const results = content && content.recognitionResults;
      for (const r of Array.isArray(results) ? results : []) {
        if (!r || typeof r.userId !== 'string' || !PERSON.test(r.userId) || typeof r.text !== 'string') continue;
        const n = lineNumber(r.id);
        const line = st.lines.has(r.userId) ? st.lines.get(r.userId) : n;
        if (line === null) continue;
        if (r.isFinal) st.lines.delete(r.userId);
        else st.lines.set(r.userId, line);
        out.push({ kind: 'caption', deviceId: r.userId, messageId: line, version: n, text: r.text, lang: typeof r.spokenLanguage === 'string' ? r.spokenLanguage : null });
      }
    } catch (_) {}
    return out;
  }

  const byLabel = { 'teams-self': self, 'teams-roster': roster, 'teams-captions': captions };
  return {
    decode: (label, bytes, tab) => (byLabel[label] ? Promise.resolve(byLabel[label](bytes, state(tab))) : Promise.resolve([])),
    // A call that ended: its caption lines are over.
    ended: (tab) => { if (tabs.has(tab)) tabs.get(tab).lines.clear(); },
    forget: (tab) => { tabs.delete(tab); },
  };
})();

if (typeof module !== 'undefined') module.exports = TeamsDecode;
