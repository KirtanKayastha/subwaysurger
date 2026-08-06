/**
 * Entry point.
 *
 * Verifies the runtime has what the game needs, then mounts the React UI.
 * Kept tiny on purpose: all real work lives in the engine and UI modules.
 */

import { mount } from './ui/App.js';

/** Render a readable failure instead of a blank screen. */
function fatal(message, detail = '') {
  const root = document.getElementById('ui-root');
  if (!root) return;
  root.innerHTML = '';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const card = document.createElement('div');
  card.className = 'panel overlay__card';

  const title = document.createElement('h2');
  title.textContent = 'CANNOT START';

  const body = document.createElement('p');
  body.style.color = 'var(--text-dim)';
  body.style.fontSize = '14px';
  body.textContent = message;

  card.append(title, body);

  if (detail) {
    const pre = document.createElement('p');
    pre.style.cssText = 'color:var(--text-faint);font-size:11px;margin-top:10px;font-family:var(--font-mono)';
    pre.textContent = detail;
    card.append(pre);
  }

  overlay.append(card);
  root.append(overlay);
}

function boot() {
  // React is vendored as a UMD global; if the script failed to load there is
  // nothing to render into.
  if (typeof React === 'undefined' || typeof ReactDOM === 'undefined') {
    fatal('React failed to load. Serve the folder over HTTP (python run.py) rather than opening the file directly.');
    return;
  }

  const canvas = document.getElementById('game');
  if (!canvas || !canvas.getContext || !canvas.getContext('2d')) {
    fatal('This browser does not support the 2D canvas API.');
    return;
  }

  try {
    mount();
  } catch (error) {
    console.error(error);
    fatal('The game failed to initialise.', String(error && error.message ? error.message : error));
  }
}

// Modules are deferred, so the DOM is already parsed by the time this runs -
// but guard anyway in case the script is ever moved into <head> without defer.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// Surface unexpected runtime errors rather than dying silently.
window.addEventListener('error', (event) => {
  console.error('[neonrush]', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[neonrush] unhandled promise rejection:', event.reason);
});
