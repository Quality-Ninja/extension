(() => {
  if (globalThis.qaNinjaInspector) return;
  const X = globalThis.QaNinjaXPath;
  const documentId = crypto.randomUUID();
  let counter = 0, selected = null, original = null, history = [], picking = false;
  let query = '', matches = [], matchIndex = -1, highlightNode = null, overlay = null;
  const identifiers = new WeakMap(), nodes = new Map();
  let observer = null, repaintQueued = false;
  function send(event, data = {}) {
    chrome.runtime.sendMessage({ type: 'INSPECT_EVENT', event, documentId, url: location.href, ...data }).catch(() => {});
  }
  function id(node) {
    if (!identifiers.has(node) || !nodes.has(identifiers.get(node))) {
      const key = `${documentId}:${++counter}`;
      identifiers.set(node, key);
      nodes.set(key, new WeakRef(node));
    }
    return identifiers.get(node);
  }
  function resolve(key) {
    const node = nodes.get(key)?.deref();
    if (!node?.isConnected) throw new Error('This element is no longer available. Select an element again.');
    return node;
  }
  function visible(node) {
    const style = getComputedStyle(node);
    return !!node.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none';
  }
  const children = node => Array.from(node.children).filter(child => !child.matches('[data-qaninja-ui]'));
  function shortLabel(node) {
    const explicit = node.getAttribute('aria-label') || node.getAttribute('title');
    if (explicit) return explicit.slice(0, 70);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let label = '', count = 0, text;
    while (label.length < 70 && count++ < 100 && (text = walker.nextNode())) label += text.textContent.slice(0, 70 - label.length);
    return label.replace(/\s+/g, ' ').trim();
  }
  function summary(node) {
    const identity = node.id ? `#${node.id}` : node.getAttribute('data-testid') ? `[${node.getAttribute('data-testid')}]` : '';
    const label = shortLabel(node);
    return { id: id(node), tag: node.localName, identity: identity.slice(0, 80), label, children: children(node).length, hidden: !visible(node) };
  }
  function paint() {
    repaintQueued = false;
    if (!overlay) return;
    if (!highlightNode?.isConnected || !visible(highlightNode)) { overlay.hidden = true; overlay.style.display = 'none'; return; }
    const r = highlightNode.getBoundingClientRect();
    overlay.hidden = false; overlay.style.display = 'block';
    Object.assign(overlay.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }
  function repaint() {
    if (!repaintQueued) { repaintQueued = true; requestAnimationFrame(paint); }
  }
  function highlight(node) {
    highlightNode = node;
    if (!overlay && node) {
      overlay = document.createElement('div');
      overlay.dataset.qaninjaUi = 'highlight';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'all:initial;position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #f1c40f;background:rgba(241,196,15,.12);border-radius:2px;';
      document.documentElement.append(overlay);
    }
    paint();
  }
  function watch() {
    if (observer) return;
    observer = new MutationObserver(records => {
      if (records.every(r => r.target === overlay)) return;
      if (selected && !selected.isConnected) {
        selected = null; highlight(null);
        send('unavailable', { message: 'The selected element was removed. Select an element again.' });
      }
      repaint();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    window.addEventListener('scroll', repaint, true);
    window.addEventListener('resize', repaint);
  }
  function state(offset = 0) {
    if (!selected?.isConnected) throw new Error('Select an element to explore its hierarchy.');
    const ancestors = [];
    for (let p = selected.parentElement; p && ancestors.length < 3; p = p.parentElement) ancestors.unshift(summary(p));
    const list = children(selected);
    return { documentId, url: location.href, current: summary(selected), ancestors,
      children: list.slice(offset, offset + 50).map(summary), childTotal: list.length, childOffset: offset,
      xpath: X.generate(selected), fullPath: X.structural(selected), canBack: history.length > 0,
      canOriginal: !!original?.isConnected && original !== selected,
      query, matchCount: matches.length, matchIndex,
      matches: matches.slice(Math.floor(Math.max(matchIndex, 0) / 50) * 50, Math.floor(Math.max(matchIndex, 0) / 50) * 50 + 50)
        .map((node, index) => ({ ...summary(node), index: Math.floor(Math.max(matchIndex, 0) / 50) * 50 + index })) };
  }
  function choose(node, { reset = false, preserveQuery = false, back = false } = {}) {
    if (!X.supported(node)) throw new Error('Document XPath cannot traverse Shadow DOM. Select an element outside the shadow root.');
    X.generate(node);
    if (reset || !original) { original = node; history = []; }
    else if (!back && selected && selected !== node) { history.push(selected); if (history.length > 100) history.shift(); }
    selected = node;
    if (!preserveQuery) { query = ''; matches = []; matchIndex = -1; }
    watch(); highlight(node);
    return state();
  }
  function stopPicking() { picking = false; }
  function clear() {
    stopPicking(); selected = null; original = null; history = []; query = ''; matches = []; matchIndex = -1;
    highlightNode = null; overlay?.remove(); overlay = null;
    nodes.clear(); observer?.disconnect(); observer = null;
    window.removeEventListener('scroll', repaint, true); window.removeEventListener('resize', repaint);
  }
  function target(event) { return event.composedPath().find(node => node instanceof Element && !node.closest('[data-qaninja-ui]')); }
  function swallow(event) { event.preventDefault(); event.stopImmediatePropagation(); }
  const pointer = event => {
    if (!picking) return;
    const node = target(event);
    if (event.type === 'pointermove') { if (node) highlight(node); return; }
    swallow(event);
    if (event.type !== 'click' || !node) return;
    stopPicking();
    try { send('selected', { state: choose(node, { reset: true }) }); }
    catch (error) { highlight(null); send('error', { message: error.message }); }
  };
  for (const type of ['pointermove', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    window.addEventListener(type, pointer, true);
  }
  window.addEventListener('keydown', event => {
    if (!picking) return;
    if (event.key === 'Escape') { swallow(event); stopPicking(); highlight(selected); send('cancelled'); }
    else if (event.key === 'Enter' || event.key === ' ') swallow(event);
  }, true);
  window.addEventListener('pagehide', () => { clear(); send('navigated'); });
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type !== 'INSPECT') return;
    try {
      let data;
      if (msg.documentId && msg.documentId !== documentId) throw new Error('The document changed. Select an element again.');
      switch (msg.action) {
        case 'pick': picking = true; watch(); data = { picking: true }; break;
        case 'stop': stopPicking(); if (!msg.keepHighlight) highlight(null); data = {}; break;
        case 'clear': clear(); data = {}; break;
        case 'state': case 'children': data = state(msg.offset || 0); break;
        case 'select': data = choose(resolve(msg.nodeId)); break;
        case 'preview': highlight(msg.nodeId ? resolve(msg.nodeId) : selected); data = {}; break;
        case 'original': data = choose(original); break;
        case 'back': {
          const previous = history.pop();
          if (!previous?.isConnected) throw new Error('The previous element is no longer available.');
          data = choose(previous, { back: true }); break;
        }
        case 'test': {
          const result = X.evaluate(msg.expression);
          query = msg.expression; matches = result; matchIndex = result.length ? 0 : -1;
          if (result.length) data = choose(result[0], { preserveQuery: true });
          else { highlight(null); data = { query, matchCount: 0, matches: [], documentId, url: location.href }; }
          break;
        }
        case 'match': {
          if (!query) throw new Error('Test an XPath first.');
          const fresh = X.evaluate(query);
          if (fresh.length !== matches.length || fresh.some((node, i) => node !== matches[i])) {
            matches = []; matchIndex = -1; highlight(null);
            throw new Error('The matches changed. Test the XPath again.');
          }
          const next = msg.index;
          if (!Number.isInteger(next) || !matches[next]?.isConnected) throw new Error('That match is unavailable. Test the XPath again.');
          matchIndex = next; data = choose(matches[next], { preserveQuery: true }); break;
        }
        case 'validate': {
          if (!selected?.isConnected) throw new Error('The selected element is unavailable. Select it again.');
          const result = X.evaluate(msg.expression);
          if (!result.includes(selected)) throw new Error('The XPath no longer matches the selected element. Test it again.');
          data = { count: result.length }; break;
        }
        default: throw new Error('Unknown inspection action.');
      }
      respond({ ok: true, data });
    } catch (error) { respond({ ok: false, error: error.message }); }
  });
  globalThis.qaNinjaInspector = { isPicking: () => picking, clear };
})();
