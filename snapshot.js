/* The executor's eyes and hands inside a page, in every frame. The service worker asks for the page as an accessibility
   tree with stable element ids, finds recorded steps again, and prepares elements for trusted input. It acts only during
   a run the worker started; page text never leaves the extension except as part of that run. */
(() => {
  if (globalThis.qaNinjaSnapshot) return;
  const D = globalThis.QaNinjaDom, X = globalThis.QaNinjaXPath;
  const documentId = crypto.randomUUID();
  const ids = new WeakMap(), nodes = new Map();
  const nonces = new Map();
  let counter = 0, running = false, lastMutation = Date.now();
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'svg', 'path', 'br', 'wbr']);
  const TEXT_LIMIT = 30000;

  function localId(el) {
    let key = ids.get(el);
    if (!key || nodes.get(key)?.deref() !== el) {
      key = `e${++counter}`; ids.set(el, key); nodes.set(key, new WeakRef(el));
    }
    return key;
  }
  function element(key) {
    const el = nodes.get(key)?.deref();
    if (!el?.isConnected) throw Object.assign(new Error('stale'), { code: 'stale_ref' });
    return el;
  }
  const ours = el => !!el.closest?.('[data-qaninja-ui]');
  function childrenOf(el) {
    const kids = el.shadowRoot ? [...el.shadowRoot.children] : [];
    return kids.concat([...el.children]);
  }
  // One line per meaningful element; generic wrappers are flattened so the tree stays short.
  function render(root, { filter, depth = 15 }) {
    const lines = [];
    let size = 0, truncated = false;
    const emit = (indent, text) => {
      if (truncated) return;
      const line = '  '.repeat(indent) + '- ' + text;
      if (size + line.length > TEXT_LIMIT) { truncated = true; return; }
      lines.push(line); size += line.length + 1;
    };
    const walk = (el, indent, level) => {
      if (truncated || level > depth + 40 || SKIP.has(el.localName) || ours(el)) return;
      if (el.hidden || el.getAttribute('aria-hidden') === 'true' || el.inert) return;
      // A display:none subtree is gone; other invisible wrappers (display:contents, visibility) may hold visible children.
      if (getComputedStyle(el).display === 'none') return;
      const shown = D.visible(el);
      const kind = D.role(el);
      const label = kind || el.localName === 'iframe' ? D.name(el) : '';
      const wanted = filter === 'all' ? shown || el.localName === 'iframe' : filter === 'interactive' ? shown && D.interactive(el) && D.inViewport(el) : shown && D.inViewport(el);
      let listed = false;
      if (kind && wanted && (D.interactive(el) || label || ['heading', 'img', 'iframe', 'dialog', 'alert', 'status', 'table', 'list', 'navigation', 'main', 'form', 'region'].includes(kind))) {
        const parts = [kind];
        if (label) parts.push(JSON.stringify(label));
        parts.push(`[[${localId(el)}]]`);
        const extra = D.states(el);
        if (extra.length) parts.push(...extra.map(state => `[${state}]`));
        const current = D.value(el);
        if (current) parts.push(`value=${current === '<redacted>' ? current : JSON.stringify(current)}`);
        if (kind === 'link' && el.getAttribute('href')) { try { parts.push(`url=${new URL(el.getAttribute('href'), location.href).pathname}`); } catch {} }
        emit(indent, parts.join(' '));
        listed = true;
      }
      if (filter !== 'interactive' && !listed && wanted && !kind) {
        const own = [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ');
        const text = D.clean(own);
        if (text.length > 1) emit(indent, `text: ${JSON.stringify(D.short(text, 160))}`);
      }
      if (['input', 'select', 'textarea', 'option', 'img'].includes(el.localName)) return;
      if (listed && ['button', 'link', 'option', 'tab', 'menuitem', 'checkbox', 'radio', 'switch'].includes(kind)) return;
      for (const child of childrenOf(el)) walk(child, listed ? indent + 1 : indent, level + 1);
    };
    walk(root, 0, 0);
    if (truncated) lines.push(`- (page truncated at ${TEXT_LIMIT} characters; use read_page with a ref or find to narrow it)`);
    return lines.join('\n');
  }
  function readPage({ filter = null, depth = 15, local = null }) {
    const root = local ? element(local) : document.body || document.documentElement;
    const text = render(root, { filter, depth: Math.max(1, Math.min(depth || 15, 40)) });
    return { text: text || '(no visible elements)', url: location.href, title: document.title };
  }
  function tokens(text) { return D.clean(text).toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1); }
  function find({ query }) {
    const wanted = tokens(query);
    const scored = [];
    for (const el of document.querySelectorAll('*')) {
      if (ours(el) || SKIP.has(el.localName) || !D.visible(el)) continue;
      const kind = D.role(el);
      if (!kind) continue;
      const haystack = [kind, D.name(el), el.getAttribute('placeholder'), el.id, D.testId(el), el.getAttribute('name'), el.localName].join(' ');
      const words = new Set(tokens(haystack));
      const score = wanted.reduce((sum, word) => sum + (words.has(word) ? 3 : [...words].some(item => item.includes(word)) ? 1 : 0), 0)
        + (D.interactive(el) ? 1 : 0) + (D.inViewport(el) ? 1 : 0);
      if (score > 1) scored.push({ el, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const lines = scored.slice(0, 20).map(({ el }) => {
      const label = D.name(el);
      return `${D.role(el)}${label ? ' ' + JSON.stringify(label) : ''} [[${localId(el)}]]${D.states(el).map(state => ` [${state}]`).join('')}`;
    });
    return { text: lines.join('\n') || `No elements match "${query}".` };
  }
  function pageText() {
    const main = document.querySelector('main, [role="main"], article') || document.body;
    const text = (main?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return { text: text.length > 20000 ? text.slice(0, 20000) + '\n(…truncated)' : text || '(no visible text)' };
  }
  function deepHit(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }
  function describe(el) {
    if (!el) return 'nothing';
    const label = D.name(el);
    return `${D.role(el) || el.localName}${label ? ` "${label}"` : ''}`;
  }
  // Scroll an element into view and say where to click it, or what covers it.
  function prepare({ local, hit = true }) {
    const el = element(local);
    if (!D.visible(el)) throw Object.assign(new Error('not visible'), { code: 'not_visible' });
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + Math.min(rect.width / 2, Math.max(rect.width - 1, 0))), y = Math.round(rect.top + Math.min(rect.height / 2, Math.max(rect.height - 1, 0)));
    if (hit) {
      const top = deepHit(x, y);
      const ok = top && (top === el || el.contains(top) || top.contains(el) && D.interactive(top) === false || (top.localName === 'label' && top.control === el));
      if (!ok && top) return { obscured: true, by: describe(top), x, y, rect: [rect.left, rect.top, rect.width, rect.height] };
    }
    return { obscured: false, x, y, rect: [rect.left, rect.top, rect.width, rect.height], sensitive: D.sensitive(el),
      tag: el.localName, type: el.type || '', editable: el.isContentEditable || ['input', 'textarea'].includes(el.localName) };
  }
  function focusInfo() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return { tag: el?.localName || '', sensitive: !!el && D.sensitive(el), editable: !!el && (el.isContentEditable || ['input', 'textarea'].includes(el.localName)) };
  }
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true, composed: true })); }
  // Sets a form field the way the page's own handlers expect: native setter, then input and change events.
  function setValue({ local, value }) {
    const el = element(local);
    if (D.sensitive(el)) throw Object.assign(new Error('sensitive'), { code: 'sensitive_field' });
    if (el.localName === 'select') {
      const wanted = D.clean(String(value)).toLowerCase();
      const option = [...el.options].find(item => D.clean(item.value).toLowerCase() === wanted || D.clean(item.text).toLowerCase() === wanted);
      if (!option) throw Object.assign(new Error(`No option "${value}". Options: ${[...el.options].slice(0, 20).map(item => item.text.trim()).join(', ')}`), { code: 'no_option' });
      el.value = option.value; fire(el, 'input'); fire(el, 'change');
      return { text: `Selected "${option.text.trim()}".` };
    }
    if (el.localName === 'input' && ['checkbox', 'radio'].includes(el.type)) {
      const want = value === true || value === 'true' || value === 1 || value === 'on';
      if (el.checked !== want) el.click();
      return { text: `${want ? 'Checked' : 'Unchecked'} ${describe(el)}.` };
    }
    if (el.isContentEditable) { el.focus(); el.textContent = String(value); fire(el, 'input'); return { text: 'Set text.' }; }
    if (!['input', 'textarea'].includes(el.localName)) throw Object.assign(new Error('not a form field'), { code: 'not_editable' });
    const setter = Object.getOwnPropertyDescriptor(el.localName === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value').set;
    el.focus(); setter.call(el, String(value)); fire(el, 'input'); fire(el, 'change');
    return { text: `Set ${describe(el)}.` };
  }
  function checked({ local }) {
    const el = element(local);
    return { checked: el.localName === 'input' ? !!el.checked : el.getAttribute('aria-checked') === 'true' };
  }
  // Replay: try locators from the most to the least specific; the first that finds exactly one visible element wins.
  function unique(list) { const shown = [...new Set(list)].filter(el => el && !ours(el) && D.visible(el)); return shown; }
  function evaluate(expression) { try { return X.evaluate(expression); } catch { return []; } }
  function byBundle(bundle, label) {
    const strategies = [];
    if (bundle?.xpath) strategies.push(['xpath', () => evaluate(bundle.xpath)]);
    if (bundle?.testid) strategies.push(['testid', () => [...document.querySelectorAll('[data-testid],[data-test],[data-qa],[data-cy]')].filter(el => D.testId(el) === bundle.testid)]);
    if (bundle?.role && bundle?.name) strategies.push(['role_name', () => [...document.querySelectorAll('*')].filter(el => D.role(el) === bundle.role && D.matchesName(el, bundle.name))]);
    const attributes = bundle?.attributes || {};
    for (const key of ['id', 'name', 'placeholder', 'aria-label']) {
      if (attributes[key]) strategies.push([`attribute_${key}`, () => [...document.querySelectorAll(`[${key}]`)].filter(el => el.getAttribute(key) === attributes[key] && (!bundle.tag || el.localName === bundle.tag))]);
    }
    if (attributes.href && bundle?.tag === 'a') strategies.push(['href', () => [...document.querySelectorAll('a[href]')].filter(el => { try { return new URL(el.getAttribute('href'), location.href).pathname === attributes.href; } catch { return false; } })]);
    const text = bundle?.text || label;
    if (text) strategies.push(['text', () => [...document.querySelectorAll(bundle?.tag || 'a,button,input,select,textarea,label,summary,[role],li,option,span,div')]
      .filter(el => D.clean(el.innerText || el.value || '').toLowerCase() === D.clean(text).toLowerCase() || D.matchesName(el, text))]);
    if (bundle?.full_xpath) strategies.push(['full_xpath', () => evaluate(bundle.full_xpath).filter(el => !bundle.role || D.role(el) === bundle.role)]);
    return strategies;
  }
  function locate({ step }) {
    const strategies = [];
    if (step.override) strategies.push(...byBundle(step.override, step.label).map(([kind, run]) => ['override_' + kind, run]));
    if (step.xpath) strategies.push(['xpath', () => evaluate(step.xpath)]);
    strategies.push(...byBundle(step.locators || null, step.label).filter(([kind]) => kind !== 'xpath' || !step.xpath));
    let ambiguous = 0;
    for (const [kind, run] of strategies) {
      let found;
      try { found = unique(run()); } catch { continue; }
      // Text and role matches prefer the innermost match, so a label's wrapper doesn't count twice.
      if (found.length > 1 && ['text', 'role_name'].includes(kind)) found = found.filter(el => !found.some(other => other !== el && el.contains(other)));
      if (found.length === 1) return { status: 'found', local: localId(found[0]), strategy: kind, label: D.name(found[0]) };
      if (found.length > 1) ambiguous = Math.max(ambiguous, found.length);
    }
    return ambiguous ? { status: 'ambiguous', count: ambiguous } : { status: 'not_found' };
  }
  function check({ assertion }) {
    const want = D.clean(assertion.value).toLowerCase();
    if (assertion.type === 'text_visible') return { ok: D.clean(document.body?.innerText || '').toLowerCase().includes(want) };
    if (assertion.type === 'title_contains') return { ok: D.clean(document.title).toLowerCase().includes(want) };
    if (assertion.type === 'url_contains') return { ok: location.href.toLowerCase().includes(want) };
    return { ok: false };
  }
  const observer = new MutationObserver(() => { lastMutation = Date.now(); });
  function quiet({ ms = 300 }) { return { quietFor: Date.now() - lastMutation, ready: document.readyState, quiet: Date.now() - lastMutation >= ms }; }
  // Frame handshake: a child frame announces a nonce to its parent, which finds the iframe element it came from.
  window.addEventListener('message', event => {
    const nonce = event.data?.__qaninja_frame;
    if (typeof nonce !== 'string' || !nonce.startsWith('qn-')) return;
    const frame = [...document.querySelectorAll('iframe,frame')].find(item => item.contentWindow === event.source);
    if (frame) nonces.set(nonce, new WeakRef(frame));
  });
  function frameRect({ nonce }) {
    const frame = nonces.get(nonce)?.deref();
    if (!frame?.isConnected) return { found: false };
    const rect = frame.getBoundingClientRect(), style = getComputedStyle(frame);
    return { found: true, local: localId(frame), x: rect.left + frame.clientLeft + parseFloat(style.paddingLeft || 0),
      y: rect.top + frame.clientTop + parseFloat(style.paddingTop || 0), visible: D.visible(frame) };
  }
  const handlers = {
    read_page: readPage, find, text: pageText, prepare, focus: focusInfo, set_value: setValue, checked, locate, check, quiet,
    frame_rect: frameRect,
    frame_hello: ({ nonce }) => { if (window.parent !== window) window.parent.postMessage({ __qaninja_frame: nonce }, '*'); return { url: location.href }; },
    scroll_to: ({ local }) => { element(local).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return { text: 'Scrolled into view.' }; },
    bundle: ({ local }) => D.bundle(element(local)),
    // A field that received a secret stays blurred, for the page's viewers and for screenshots alike.
    mark_secret: ({ local }) => { const el = element(local); el.setAttribute('data-qaninja-secret', ''); el.style.setProperty('filter', 'blur(6px)', 'important'); return {}; },
    run_state: ({ on }) => { running = !!on; if (running) observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); else observer.disconnect(); return { running }; },
    info: () => ({ url: location.href, title: document.title, documentId, running }),
  };
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type !== 'QN_EXEC' || sender.id !== chrome.runtime.id) return;
    try {
      if (msg.documentId && msg.documentId !== documentId) throw Object.assign(new Error('stale'), { code: 'stale_ref' });
      const handler = handlers[msg.op];
      if (!handler) throw new Error('Unknown operation.');
      respond({ ok: true, data: { ...handler(msg), documentId } });
    } catch (error) { respond({ ok: false, error: error.message, code: error.code || 'failed' }); }
  });
  globalThis.qaNinjaSnapshot = { isRunning: () => running };
})();
