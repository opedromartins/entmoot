// The menu under the extension's toolbar button: one checkbox per setting in
// settings.js. A page reads the settings once, as it loads.
'use strict';

const boxes = [...document.querySelectorAll('input[data-key]')];

// An option of a platform that is off has nothing to act on.
function refresh() {
  for (const box of boxes) {
    const needs = box.dataset.needs;
    if (!needs) continue;
    const available = boxes.find((b) => b.dataset.key === needs).checked;
    box.disabled = !available;
    box.closest('label').classList.toggle('unavailable', !available);
  }
}

MtSettings.load().then((settings) => {
  for (const box of boxes) box.checked = !!settings[box.dataset.key];
  refresh();
});

for (const box of boxes) {
  box.addEventListener('change', () => {
    browser.storage.local.set({ [box.dataset.key]: box.checked });
    refresh();
    document.getElementById('reload').hidden = false;
  });
}
