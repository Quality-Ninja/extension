// The run window: one tab driven through CDP, with the page view and element actions done by snapshot.js in each frame.
// Top-level navigation is limited to the run's allowed origins at the network layer; popups are closed; dialogs are
// answered; file choosers stop the run. Element references (ref_N) stay stable until the page navigates.
import { Debuggee, click, modifierBits, mouse, parseKeys, pressKey } from './cdp.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originOf = url => { try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.origin.toLowerCase() : null; } catch { return null; } };
const fail = (code, message) => Object.assign(new Error(message), { code });
const REF = /^ref_\d{1,6}$/;
const BUFFER = 300;

export class RunPage {
  constructor({ tabId, windowId, allowedOrigins, onEvent, redact }) {
    Object.assign(this, { tabId, windowId, onEvent, redact: redact || (text => text) });
    this.allowed = new Set(allowedOrigins.map(origin => origin.toLowerCase()));
    this.debuggee = new Debuggee(tabId);
    this.refs = new Map(); this.reverse = new Map(); this.nextRef = 1;
    this.console = []; this.network = new Map(); this.inflight = new Map(); this.lastNetwork = 0;
    this.mainFrameId = null; this.detached = null; this.blockedReason = null;
  }

  static async open({ startUrl, viewport, allowedOrigins, onEvent, redact, onDetach }) {
    const width = Math.max(800, Math.min(viewport?.width || 1280, 1920)), height = Math.max(600, Math.min(viewport?.height || 800, 1200));
    const window = await chrome.windows.create({ url: 'about:blank', focused: true, type: 'normal', width: width + 16, height: height + 90 });
    const tab = window.tabs[0];
    const page = new RunPage({ tabId: tab.id, windowId: window.id, allowedOrigins, onEvent, redact });
    page.debuggee.onDetach(reason => { page.detached = reason; onDetach?.(reason); });
    await page.attach();
    await page.goto(startUrl);
    return page;
  }

  send(method, params, sessionId, timeout) {
    if (this.detached) return Promise.reject(fail('detached', 'The test window was closed or debugging was cancelled.'));
    return this.debuggee.send(method, params, sessionId, timeout);
  }

  async attach() {
    await this.debuggee.attach();
    this.debuggee.on((method, params, sessionId) => this.handle(method, params, sessionId).catch(() => {}));
    await this.send('Page.enable');
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true });
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable', { maxPostDataSize: 0 });
    // Screenshot pixels equal CSS pixels, so the agent's coordinates and ours agree.
    await this.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 1, mobile: false });
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    const { frameTree } = await this.send('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
  }

  record(entry) {
    this.console.push(entry);
    if (this.console.length > BUFFER) this.console.shift();
  }

  async handle(method, params, sessionId) {
    switch (method) {
      case 'Fetch.requestPaused': {
        const top = !params.frameId || params.frameId === this.mainFrameId;
        if (top && params.resourceType === 'Document' && !this.allowed.has(originOf(params.request.url))) {
          await this.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
          this.onEvent({ kind: 'navigation', level: 'warning', message: `Blocked a navigation to ${originOf(params.request.url) || 'a non-web address'}: not an allowed origin.` });
          return;
        }
        await this.send('Fetch.continueRequest', { requestId: params.requestId });
        return;
      }
      case 'Page.frameNavigated':
        if (!params.frame.parentId) { this.refs.clear(); this.reverse.clear(); this.nextRef = 1; }
        return;
      case 'Page.javascriptDialogOpening': {
        const accept = params.type !== 'prompt';
        this.onEvent({ kind: 'dialog', level: 'info', message: `${params.type} dialog ${accept ? 'accepted' : 'dismissed'}: ${this.redact(String(params.message || '').slice(0, 300))}` });
        await this.send('Page.handleJavaScriptDialog', { accept });
        return;
      }
      case 'Page.fileChooserOpened':
        this.blockedReason = 'file_upload_required';
        this.onEvent({ kind: 'system', level: 'warning', message: 'The page asked for a file upload, which test runs cannot do yet.' });
        return;
      case 'Target.attachedToTarget':
        if (params.targetInfo?.type === 'iframe') {
          await this.send('Runtime.enable', {}, params.sessionId).catch(() => {});
          await this.send('Network.enable', { maxPostDataSize: 0 }, params.sessionId).catch(() => {});
        }
        return;
      case 'Runtime.consoleAPICalled': {
        const level = params.type === 'error' || params.type === 'assert' ? 'error' : params.type === 'warning' ? 'warning' : 'info';
        const text = this.redact((params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 1000));
        this.record({ level, text, at: Date.now() });
        if (level !== 'info') this.onEvent({ kind: 'console', level, message: text });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails || {};
        const text = this.redact((details.exception?.description || details.text || 'Uncaught exception').split('\n')[0].slice(0, 1000));
        this.record({ level: 'error', text, at: Date.now() });
        this.onEvent({ kind: 'exception', level: 'error', message: text, data: { url: details.url || '', line: details.lineNumber } });
        return;
      }
      case 'Log.entryAdded': {
        const entry = params.entry || {};
        if (entry.level === 'error' || entry.level === 'warning') {
          const text = this.redact(String(entry.text || '').slice(0, 1000));
          this.record({ level: entry.level, text, at: Date.now() });
          if (entry.source !== 'network') this.onEvent({ kind: 'console', level: entry.level, message: text });
        }
        return;
      }
      case 'Network.requestWillBeSent': {
        const key = (sessionId || '') + params.requestId;
        if (['Document', 'XHR', 'Fetch', 'Script', 'Stylesheet'].includes(params.type)) this.inflight.set(key, Date.now());
        this.lastNetwork = Date.now();
        this.network.set(key, { method: params.request.method, url: this.redact(params.request.url.slice(0, 500)), type: params.type || 'Other', start: Date.now() });
        if (this.network.size > BUFFER) this.network.delete(this.network.keys().next().value);
        return;
      }
      case 'Network.responseReceived': {
        const item = this.network.get((sessionId || '') + params.requestId);
        if (item) { item.status = params.response.status; item.mime = params.response.mimeType; }
        if (params.response.status >= 400 && ['Document', 'XHR', 'Fetch'].includes(params.type)) {
          this.onEvent({ kind: 'network', level: 'error', message: `${item?.method || 'GET'} ${this.redact(params.response.url.slice(0, 300))} returned ${params.response.status}`, data: { status: params.response.status, type: params.type } });
        }
        return;
      }
      case 'Network.loadingFinished': case 'Network.loadingFailed': {
        const key = (sessionId || '') + params.requestId;
        this.inflight.delete(key); this.lastNetwork = Date.now();
        const item = this.network.get(key);
        if (item) item.ms = Date.now() - item.start;
        if (method === 'Network.loadingFailed' && !params.canceled && item && ['Document', 'XHR', 'Fetch'].includes(item.type) && params.blockedReason !== 'inspector') {
          if (item) item.error = params.errorText;
          this.onEvent({ kind: 'network', level: 'error', message: `${item.method} ${item.url.slice(0, 300)} failed: ${params.errorText}` });
        }
        return;
      }
      default:
    }
  }

  allowedUrl(url) { return this.allowed.has(originOf(url)); }

  async goto(url) {
    if (!this.allowedUrl(url)) throw fail('navigation_blocked', `${url} is not on an allowed origin.`);
    const result = await this.send('Page.navigate', { url }, undefined, 30000);
    if (result.errorText) throw fail('navigation_failed', `The page did not load: ${result.errorText}.`);
    await this.settle(15000);
  }

  async history(direction) {
    if (direction === 'reload') { await this.send('Page.reload'); await this.settle(15000); return; }
    const { currentIndex, entries } = await this.send('Page.getNavigationHistory');
    const entry = entries[currentIndex + (direction === 'back' ? -1 : 1)];
    if (!entry) throw fail('no_history', `There is no page to go ${direction} to.`);
    await this.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    await this.settle(15000);
  }

  // Quiet network (ignoring long-lived requests) and a quiet DOM, or the timeout.
  async settle(timeout = 5000) {
    const end = Date.now() + timeout;
    await sleep(60);
    while (Date.now() < end) {
      const now = Date.now();
      const busy = [...this.inflight.values()].filter(started => now - started < 10000).length;
      const dom = await this.exec(0, 'quiet', { ms: 300 }, 1500).catch(() => ({ quiet: true, ready: 'complete' }));
      if (!busy && now - this.lastNetwork > 300 && dom.quiet && dom.ready !== 'loading') return true;
      await sleep(150);
    }
    return false;
  }

  async info() {
    const tab = await chrome.tabs.get(this.tabId).catch(() => null);
    return { url: tab?.url || '', title: tab?.title || '' };
  }

  async browserState() {
    const { url, title } = await this.info();
    return { tabs: [{ tab_id: 'tab-1', title: this.redact(title), url: this.redact(url), active: true }] };
  }

  async screenshot(clip) {
    const params = { format: 'jpeg', quality: 70, optimizeForSpeed: true, ...(clip && { clip }) };
    const { data } = await this.send('Page.captureScreenshot', params, undefined, 10000);
    return Uint8Array.from(atob(data), char => char.charCodeAt(0));
  }

  async frames() {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: this.tabId }).catch(() => []);
    return (frames || []).filter(frame => !frame.errorOccurred && /^(https?:|about:blank)/.test(frame.url)).slice(0, 12);
  }

  async exec(frameId, op, payload = {}, timeout = 8000) {
    let timer;
    const response = await Promise.race([
      chrome.tabs.sendMessage(this.tabId, { type: 'QN_EXEC', op, ...payload }, { frameId }).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); }),
    ]).finally(() => clearTimeout(timer));
    if (!response) throw fail('no_frame', 'The page is not ready yet.');
    if (!response.ok) throw fail(response.code || 'failed', response.error);
    return response.data;
  }

  globalRef(frameId, documentId, local) {
    const key = `${frameId}|${documentId}|${local}`;
    let ref = this.reverse.get(key);
    if (!ref) { ref = `ref_${this.nextRef++}`; this.reverse.set(key, ref); this.refs.set(ref, { frameId, documentId, local }); }
    return ref;
  }

  localize(text, frameId, documentId) {
    return text.replace(/\[\[(e\d+)\]\]/g, (_, local) => `[${this.globalRef(frameId, documentId, local)}]`);
  }

  resolve(ref) {
    if (!REF.test(String(ref))) throw fail('bad_ref', `${ref} is not an element reference.`);
    const found = this.refs.get(ref);
    if (!found) throw fail('stale_ref', `${ref} is stale or not on the current page. Re-read the page to get fresh references.`);
    return found;
  }

  async handshake(frameId, parentFrameId) {
    const nonce = 'qn-' + crypto.randomUUID();
    await this.exec(frameId, 'frame_hello', { nonce }, 2000);
    for (let attempt = 0; attempt < 6; attempt++) {
      const rect = await this.exec(parentFrameId, 'frame_rect', { nonce }, 2000).catch(() => ({ found: false }));
      if (rect.found) return rect;
      await sleep(40);
    }
    return { found: false };
  }

  // Where a child frame's viewport sits in the top viewport; with scroll, each iframe is scrolled into view first.
  async frameOffset(frameId, { scroll = false } = {}) {
    if (!frameId) return { x: 0, y: 0 };
    const frames = await this.frames();
    const byId = new Map(frames.map(frame => [frame.frameId, frame]));
    const chain = [];
    for (let current = byId.get(frameId); current && current.frameId !== 0; current = byId.get(current.parentFrameId)) chain.unshift(current);
    let x = 0, y = 0;
    for (const frame of chain) {
      let rect = await this.handshake(frame.frameId, frame.parentFrameId);
      if (!rect.found) throw fail('frame_unreachable', 'That element is inside a frame QA Ninja cannot reach.');
      if (scroll) {
        await this.exec(frame.parentFrameId, 'scroll_to', { local: rect.local }).catch(() => {});
        rect = await this.handshake(frame.frameId, frame.parentFrameId);
      }
      x += rect.x; y += rect.y;
    }
    return { x, y };
  }

  async viewport() {
    const metrics = await this.send('Page.getLayoutMetrics');
    const view = metrics.cssVisualViewport || metrics.layoutViewport || {};
    return { width: view.clientWidth || 1280, height: view.clientHeight || 800 };
  }

  async readPage({ filter = null, depth = 15, ref = null } = {}) {
    if (ref) {
      const target = this.resolve(ref);
      const data = await this.exec(target.frameId, 'read_page', { filter, depth, local: target.local, documentId: target.documentId });
      return this.redact(this.localize(data.text, target.frameId, data.documentId));
    }
    const frames = await this.frames();
    const main = await this.exec(0, 'read_page', { filter, depth });
    let text = this.localize(main.text, 0, main.documentId);
    for (const frame of frames.filter(item => item.frameId !== 0)) {
      try {
        const data = await this.exec(frame.frameId, 'read_page', { filter, depth }, 4000);
        if (!data.text || data.text.startsWith('(no visible')) continue;
        const inner = this.localize(data.text, frame.frameId, data.documentId);
        const rect = await this.handshake(frame.frameId, frame.parentFrameId);
        const parentDoc = rect.found ? (await this.exec(frame.parentFrameId, 'info').catch(() => ({}))).documentId : null;
        const anchor = rect.found && parentDoc ? `[${this.globalRef(frame.parentFrameId, parentDoc, rect.local)}]` : null;
        const lines = text.split('\n');
        const at = anchor ? lines.findIndex(line => line.includes(anchor)) : -1;
        if (at >= 0) {
          const indent = lines[at].match(/^\s*/)[0] + '  ';
          lines.splice(at + 1, 0, ...inner.split('\n').map(line => indent + line));
          text = lines.join('\n');
        } else {
          text += `\n- frame ${JSON.stringify(new URL(frame.url).host)}:\n` + inner.split('\n').map(line => '  ' + line).join('\n');
        }
      } catch {}
    }
    return this.redact(text);
  }

  async find(query) {
    const frames = await this.frames();
    const lines = [];
    for (const frame of frames) {
      try {
        const data = await this.exec(frame.frameId, 'find', { query }, 4000);
        if (!data.text.startsWith('No elements')) lines.push(...this.localize(data.text, frame.frameId, data.documentId).split('\n'));
      } catch {}
    }
    return this.redact(lines.slice(0, 20).join('\n') || `No elements match "${query}".`);
  }

  async pageText() { return this.redact((await this.exec(0, 'text')).text); }

  // A point to act on in top-viewport pixels; refs are scrolled into view and checked for overlays first.
  async pointAt(target, { allowSensitive = true } = {}) {
    if (target?.type === 'coordinate') return { x: target.x, y: target.y, info: {} };
    const found = this.resolve(target?.ref);
    const prepare = () => this.exec(found.frameId, 'prepare', { local: found.local, documentId: found.documentId });
    // Scrolling the element into view moves its frames too, so frame offsets are measured afterwards.
    let info = await prepare();
    let offset = await this.frameOffset(found.frameId);
    if (found.frameId) {
      const view = await this.viewport();
      const x = info.x + offset.x, y = info.y + offset.y;
      if (x < 0 || y < 0 || x > view.width || y > view.height) {
        offset = await this.frameOffset(found.frameId, { scroll: true });
        info = await prepare();
        offset = await this.frameOffset(found.frameId);
      }
    }
    if (info.obscured) throw fail('obscured', `${target.ref} is covered by ${info.by}. Close or scroll past it first.`);
    if (!allowSensitive && info.sensitive) throw fail('sensitive_field', `${target.ref} is a password or other secret field. Use type_secret.`);
    return { x: Math.round(info.x + offset.x), y: Math.round(info.y + offset.y), info, found };
  }

  async click(target, { button = 'left', clickCount = 1, modifiers = '' } = {}) {
    const point = await this.pointAt(target);
    await click(this.debuggee, point.x, point.y, { button, clickCount, modifiers: modifierBits(modifiers) });
    await this.settle();
    return point;
  }

  async hover(target) {
    const point = await this.pointAt(target);
    await mouse(this.debuggee, 'mouseMoved', point.x, point.y);
    await sleep(150);
  }

  async drag(from, to) {
    await mouse(this.debuggee, 'mouseMoved', from.x, from.y);
    await mouse(this.debuggee, 'mousePressed', from.x, from.y, { button: 'left', clickCount: 1, buttons: 1 });
    for (let step = 1; step <= 8; step++) {
      await mouse(this.debuggee, 'mouseMoved', from.x + (to.x - from.x) * step / 8, from.y + (to.y - from.y) * step / 8, { button: 'left', buttons: 1 });
    }
    await mouse(this.debuggee, 'mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 });
    await this.settle();
  }

  async pointer(type, target) {
    const kind = { left_mouse_down: 'mousePressed', left_mouse_up: 'mouseReleased', mouse_move: 'mouseMoved' }[type];
    await mouse(this.debuggee, kind, target.x, target.y, kind === 'mouseMoved' ? {} : { button: 'left', clickCount: 1, buttons: 1 });
  }

  async scroll(target, direction, amount = 3) {
    const delta = Math.max(1, Math.min(amount || 3, 10)) * 120;
    const [deltaX, deltaY] = { up: [0, -delta], down: [0, delta], left: [-delta, 0], right: [delta, 0] }[direction];
    await mouse(this.debuggee, 'mouseWheel', target.x, target.y, { deltaX, deltaY });
    await sleep(250);
  }

  async scrollTo(ref) {
    const found = this.resolve(ref);
    await this.frameOffset(found.frameId, { scroll: true });
    await this.exec(found.frameId, 'scroll_to', { local: found.local, documentId: found.documentId });
  }

  async focusedSensitive() {
    for (const frame of await this.frames()) {
      const info = await this.exec(frame.frameId, 'focus', {}, 2000).catch(() => null);
      if (info?.sensitive) return true;
    }
    return false;
  }

  async type(text) {
    if (await this.focusedSensitive()) throw fail('sensitive_field', 'The focused field takes a secret. Use type_secret.');
    await this.send('Input.insertText', { text });
    await this.settle(3000);
  }

  async key(spec, repeat = 1) {
    const keys = parseKeys(spec);
    for (let n = 0; n < Math.max(1, Math.min(repeat || 1, 100)); n++) for (const key of keys) await pressKey(this.debuggee, key);
    await this.settle(3000);
  }

  async clearFocused() {
    await pressKey(this.debuggee, { ...parseKeys('ctrl+a')[0] });
    await pressKey(this.debuggee, parseKeys('Backspace')[0]);
  }

  // Replay and form_input set values like a person: focus, select what's there, type.
  async fill(ref, value, { secret = false } = {}) {
    const point = await this.pointAt({ type: 'ref', ref }, { allowSensitive: secret });
    if (!point.info.editable) throw fail('not_editable', `${ref} is not a text field.`);
    await click(this.debuggee, point.x, point.y);
    await this.clearFocused();
    await this.send('Input.insertText', { text: String(value) });
    if (secret) await this.exec(point.found.frameId, 'mark_secret', { local: point.found.local, documentId: point.found.documentId }).catch(() => {});
    await this.settle(3000);
  }

  async formInput(ref, value) {
    const found = this.resolve(ref);
    const info = await this.exec(found.frameId, 'prepare', { local: found.local, documentId: found.documentId, hit: false });
    if (info.sensitive) throw fail('sensitive_field', `${ref} is a password or other secret field. Use type_secret.`);
    if (info.editable && !['checkbox', 'radio'].includes(info.type) && typeof value !== 'boolean') { await this.fill(ref, value); return `Set ${ref}.`; }
    const result = await this.exec(found.frameId, 'set_value', { local: found.local, documentId: found.documentId, value });
    await this.settle(3000);
    return result.text;
  }

  async checked(ref) {
    const found = this.resolve(ref);
    return (await this.exec(found.frameId, 'checked', { local: found.local, documentId: found.documentId })).checked;
  }

  async bundle(ref) {
    const found = this.resolve(ref);
    return this.exec(found.frameId, 'bundle', { local: found.local, documentId: found.documentId });
  }

  // Finds a recorded step: its own frame first (matched by URL), then the top page, then any frame.
  async locate(step) {
    const frames = await this.frames();
    const path = url => { try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return ''; } };
    const ordered = [];
    if (step.frame_url) ordered.push(...frames.filter(frame => frame.frameId !== 0 && path(frame.url) === path(step.frame_url)));
    ordered.push(...frames.filter(frame => frame.frameId === 0), ...frames.filter(frame => !ordered.includes(frame) && frame.frameId !== 0));
    let best = { status: 'not_found' };
    for (const frame of ordered) {
      const result = await this.exec(frame.frameId, 'locate', { step }, 5000).catch(() => null);
      if (result?.status === 'found') return { ...result, ref: this.globalRef(frame.frameId, result.documentId, result.local), frameId: frame.frameId };
      if (result?.status === 'ambiguous') best = result;
    }
    return best;
  }

  async check(assertion) {
    if (assertion.type === 'url_contains') return (await this.info()).url.toLowerCase().includes(String(assertion.value).toLowerCase());
    if (assertion.type === 'title_contains') return (await this.info()).title.toLowerCase().includes(String(assertion.value).toLowerCase());
    for (const frame of await this.frames()) {
      if ((await this.exec(frame.frameId, 'check', { assertion }, 3000).catch(() => ({ ok: false }))).ok) return true;
    }
    return false;
  }

  consoleText() {
    const lines = this.console.slice(-60).map(entry => `[${entry.level}] ${entry.text}`);
    return lines.join('\n') || '(no console messages)';
  }

  networkText() {
    const lines = [...this.network.values()].slice(-60).map(item =>
      `${item.method} ${item.status ?? (item.error ? 'failed' : 'pending')} ${item.url} (${item.type.toLowerCase()}${item.ms != null ? `, ${item.ms} ms` : ''})${item.error ? ' ' + item.error : ''}`);
    return lines.join('\n') || '(no network requests)';
  }

  async running(on) {
    for (const frame of await this.frames()) await this.exec(frame.frameId, 'run_state', { on }, 2000).catch(() => {});
  }

  async close({ closeWindow = false } = {}) {
    await this.running(false).catch(() => {});
    await this.debuggee.detach();
    if (closeWindow) await chrome.windows.remove(this.windowId).catch(() => {});
  }
}
