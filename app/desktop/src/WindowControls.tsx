import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Minimize, maximize and close, drawn by the app: the window has no title bar
 * from Windows. They sit over the top right corner of every screen. The glyphs
 * are the ones Windows itself uses, from its icon font.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let win;
    try {
      win = getCurrentWindow();
    } catch {
      return; // Opened in a browser, without Tauri.
    }
    const read = () => win.isMaximized().then(setMaximized, () => {});
    read();
    const unlisten = win.onResized(read);
    return () => void unlisten.then((stop) => stop());
  }, []);

  const act = (action: 'minimize' | 'toggleMaximize' | 'close') => () => {
    try {
      void getCurrentWindow()[action]().catch(() => {});
    } catch {
      // Not in Tauri.
    }
  };

  return (
    <div className="window-controls">
      <button type="button" tabIndex={-1} aria-label="Minimizar" title="Minimizar" onClick={act('minimize')}>
        {''}
      </button>
      <button type="button" tabIndex={-1} aria-label={maximized ? 'Restaurar' : 'Maximizar'} title={maximized ? 'Restaurar' : 'Maximizar'} onClick={act('toggleMaximize')}>
        {maximized ? '' : ''}
      </button>
      <button type="button" tabIndex={-1} className="is-close" aria-label="Fechar" title="Fechar" onClick={act('close')}>
        {''}
      </button>
    </div>
  );
}
