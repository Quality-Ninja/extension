// Chrome DevTools Protocol through chrome.debugger: one debuggee per run tab, with trusted mouse and keyboard input.
// An attached debugger keeps the service worker alive (Chrome 118+), so a run survives the panel closing.
const debuggees = new Map();

chrome.debugger.onEvent.addListener((source, method, params) => {
  const debuggee = debuggees.get(source.tabId);
  if (debuggee) for (const listener of debuggee.listeners) { try { listener(method, params || {}, source.sessionId); } catch {} }
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const debuggee = debuggees.get(source.tabId);
  if (!debuggee) return;
  debuggees.delete(source.tabId);
  debuggee.attached = false;
  for (const listener of debuggee.detachListeners) { try { listener(reason); } catch {} }
});

export class Debuggee {
  constructor(tabId) {
    this.tabId = tabId; this.attached = false;
    this.listeners = new Set(); this.detachListeners = new Set();
  }
  async attach() {
    await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    this.attached = true;
    debuggees.set(this.tabId, this);
  }
  send(method, params = {}, sessionId, timeout = 15000) {
    const target = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
    let timer;
    return Promise.race([
      chrome.debugger.sendCommand(target, method, params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${method} timed out.`), { code: 'timeout' })), timeout); }),
    ]).finally(() => clearTimeout(timer));
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onDetach(listener) { this.detachListeners.add(listener); }
  async detach() {
    if (!this.attached) return;
    debuggees.delete(this.tabId);
    this.attached = false;
    await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }
}

const MODIFIERS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8 };
const KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27], backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32, ' '],
  arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40], arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39], up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40],
  left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39], home: ['Home', 'Home', 36], end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34], insert: ['Insert', 'Insert', 45],
};
for (let n = 1; n <= 12; n++) KEYS[`f${n}`] = [`F${n}`, `F${n}`, 111 + n];
// Editing shortcuts run as browser commands, so "ctrl+a" selects all on every platform.
const COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

function keyDefinition(name) {
  const lower = name.toLowerCase();
  if (KEYS[lower]) { const [key, code, keyCode, text] = KEYS[lower]; return { key, code, keyCode, text }; }
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const letter = /[a-z]/i.test(name), digit = /\d/.test(name);
    return { key: name, code: letter ? `Key${upper}` : digit ? `Digit${name}` : '', keyCode: letter || digit ? upper.charCodeAt(0) : 0, text: name };
  }
  throw Object.assign(new Error(`Unknown key "${name}".`), { code: 'bad_key' });
}

// "Enter", "ctrl+a", "shift+Tab" or a space-separated sequence of those.
export function parseKeys(spec) {
  return String(spec).trim().split(/\s+/).filter(Boolean).map(chord => {
    const parts = chord.split('+').filter(Boolean);
    const main = parts.pop() || '+';
    let modifiers = 0;
    for (const part of parts) {
      const bit = MODIFIERS[part.toLowerCase()];
      if (!bit) throw Object.assign(new Error(`Unknown modifier "${part}".`), { code: 'bad_key' });
      modifiers |= bit;
    }
    return { ...keyDefinition(main), modifiers };
  });
}

export async function pressKey(debuggee, key) {
  const { key: name, code, keyCode, modifiers } = key;
  const command = modifiers & (2 | 4) && COMMANDS[name.toLowerCase()];
  const text = modifiers & (1 | 2 | 4) ? undefined : key.text;
  const base = { key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await debuggee.send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text && { text, unmodifiedText: text }),
    ...(command && { commands: [command] }) });
  await debuggee.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

export async function mouse(debuggee, type, x, y, extra = {}) {
  await debuggee.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });
}

export async function click(debuggee, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  await mouse(debuggee, 'mouseMoved', x, y, { modifiers });
  for (let count = 1; count <= clickCount; count++) {
    await mouse(debuggee, 'mousePressed', x, y, { button, clickCount: count, modifiers, buttons: button === 'right' ? 2 : 1 });
    await mouse(debuggee, 'mouseReleased', x, y, { button, clickCount: count, modifiers });
  }
}

export function modifierBits(text) {
  if (!text) return 0;
  return String(text).split('+').reduce((bits, part) => bits | (MODIFIERS[part.trim().toLowerCase()] || 0), 0);
}
