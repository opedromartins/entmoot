// What the user chooses in the extension's menu (popup.html), kept in
// browser.storage.local. Loaded by the menu and, before content.js, by the
// meeting's page.
'use strict';

const MtSettings = {
  DEFAULTS: {
    meet: true, // transcribe meetings on Google Meet
    meetCaptions: true, // ask Meet for captions on joining; nothing shows on screen
    teams: true, // transcribe meetings on Microsoft Teams
    teamsCaptions: false, // click Teams' captions button on joining; never checked live
  },
  // Storage that fails is no reason to stop transcribing.
  load() {
    return browser.storage.local.get(this.DEFAULTS).catch(() => ({ ...this.DEFAULTS }));
  },
};
