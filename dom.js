/* Shared by recording, replay and the agent's page view: roles, accessible names, sensitive fields and locators.
   The same code that fingerprints an element while recording finds it again at replay time. Nothing leaves the page here. */
(() => {
  if (globalThis.QaNinjaDom) return;
  const X = globalThis.QaNinjaXPath;
  const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio',
    range: 'slider', number: 'spinbutton', search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox',
    password: 'textbox', date: 'textbox', 'datetime-local': 'textbox', month: 'textbox', time: 'textbox', week: 'textbox', color: 'button', file: 'button' };
  const TAG_ROLES = { button: 'button', textarea: 'textbox', option: 'option', nav: 'navigation', main: 'main', aside: 'complementary',
    dialog: 'dialog', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', ul: 'list', ol: 'list', li: 'listitem', summary: 'button',
    progress: 'progressbar', meter: 'meter', fieldset: 'group', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading',
    h6: 'heading', iframe: 'iframe', label: 'label', p: 'paragraph', menu: 'list', output: 'status' };
  const INTERACTIVE = new Set(['link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'slider',
    'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'gridcell']);
  const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'treeitem', 'cell', 'columnheader', 'rowheader', 'listitem', 'switch', 'checkbox', 'radio', 'label', 'gridcell', 'tooltip', 'status', 'alert']);
  const SECRET_WORDS = /pass(word|code|phrase)?|pwd|secret|token|api[-_ ]?key|\botp\b|one[-_ ]?time|2fa|mfa|verification[-_ ]?code|cvv|cvc|csc|security[-_ ]?code|card[-_ ]?(number|no)|ccnum|iban|\bssn\b|social[-_ ]?security|\bpin\b/i;
  const SECRET_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-.*)$/;
  const seenPassword = new WeakSet();
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  const short = (text, limit = 100) => { const value = clean(text); return value.length > limit ? value.slice(0, limit - 1) + '…' : value; };

  function role(el) {
    const explicit = clean(el.getAttribute('role')).split(' ')[0];
    if (explicit && explicit !== 'none' && explicit !== 'presentation') return explicit;
    const tag = el.localName;
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'input') return INPUT_ROLES[(el.getAttribute('type') || 'text').toLowerCase()] ?? (el.type === 'hidden' ? '' : 'textbox');
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'img') return el.getAttribute('alt') === '' ? '' : 'img';
    if (tag === 'header') return el.closest('article,aside,main,nav,section') ? '' : 'banner';
    if (tag === 'footer') return el.closest('article,aside,main,nav,section') ? '' : 'contentinfo';
    if (tag === 'form' || tag === 'section') return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? (tag === 'form' ? 'form' : 'region') : '';
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return 'textbox';
    return TAG_ROLES[tag] || '';
  }
  function byIds(el, attribute) {
    const ids = clean(el.getAttribute(attribute)).split(' ').filter(Boolean);
    return ids.map(id => el.ownerDocument.getElementById(id)).filter(Boolean);
  }
  function labelText(el) {
    if (el.labels?.length) return [...el.labels].map(label => label.innerText).join(' ');
    return '';
  }
  function name(el, depth = 0) {
    if (depth > 2) return '';
    const labelled = byIds(el, 'aria-labelledby');
    if (labelled.length) return short(labelled.map(node => node === el ? '' : name(node, depth + 1) || node.innerText || node.textContent).join(' '));
    const aria = el.getAttribute('aria-label');
    if (clean(aria)) return short(aria);
    const tag = el.localName, kind = role(el);
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type)) return short(el.value || el.getAttribute('title') || (el.type === 'submit' ? 'Submit' : ''));
    if (tag === 'input' && el.type === 'image') return short(el.getAttribute('alt') || el.value || 'Submit');
    if (['input', 'select', 'textarea'].includes(tag)) {
      const label = labelText(el);
      if (clean(label)) return short(label);
      return short(el.getAttribute('title') || el.getAttribute('placeholder') || '');
    }
    if (tag === 'img' || tag === 'area') return short(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (tag === 'iframe') return short(el.getAttribute('title') || el.getAttribute('name') || '');
    if (tag === 'fieldset') return short(el.querySelector(':scope > legend')?.innerText || '');
    if (tag === 'table') return short(el.querySelector(':scope > caption')?.innerText || el.getAttribute('title') || '');
    if (NAME_FROM_CONTENT.has(kind) || tag === 'summary') return short(el.innerText || el.textContent || el.getAttribute('title') || '');
    return short(el.getAttribute('title') || '');
  }
  function visible(el) {
    if (!el.isConnected || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none' && Number(style.opacity) !== 0;
  }
  function inViewport(el) {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }
  function interactive(el) {
    const kind = role(el);
    return INTERACTIVE.has(kind) || (el.hasAttribute('tabindex') && el.tabIndex >= 0 && !!kind) || el.localName === 'summary';
  }
  function sensitive(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.localName === 'input' && el.type === 'password') { seenPassword.add(el); return true; }
    if (seenPassword.has(el)) return true;
    if (el.closest('[data-private],[data-sensitive],[data-qaninja-sensitive]')) return true;
    if (SECRET_AUTOCOMPLETE.test(clean(el.getAttribute('autocomplete')).toLowerCase())) return true;
    const words = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labelText(el)].map(clean).join(' ');
    if (SECRET_WORDS.test(words)) return true;
    // A short numeric code field (one-time codes, PINs).
    const numeric = el.getAttribute('inputmode') === 'numeric' || el.type === 'number' || /\\d|\[0-9\]/.test(el.getAttribute('pattern') || '');
    const max = Number(el.getAttribute('maxlength') || 0);
    return numeric && max >= 4 && max <= 8 && /code|pin|verif/i.test(words);
  }
  function luhn(digits) {
    let total = 0;
    for (let i = 0; i < digits.length; i++) {
      let n = Number(digits[digits.length - 1 - i]);
      if (i % 2) { n *= 2; if (n > 9) n -= 9; }
      total += n;
    }
    return total % 10 === 0;
  }
  function entropy(text) {
    const counts = {};
    for (const ch of text) counts[ch] = (counts[ch] || 0) + 1;
    return Object.values(counts).reduce((sum, count) => sum - count / text.length * Math.log2(count / text.length), 0);
  }
  function looksSecret(value) {
    const text = String(value || '');
    if (/eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/.test(text)) return true;
    if (/\b(sk|rk|pk)_(live|test)_\w{16,}|\bsk-(ant-|proj-|or-v1-)?[\w-]{20,}|\bgh[pousr]_\w{30,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[\w-]{35}\b|\bxox[abposr]-[\w-]{10,}/.test(text)) return true;
    const digits = text.replace(/[\s-]/g, '');
    if (/^\d{13,19}$/.test(digits) && luhn(digits)) return true;
    // Long random-looking strings: keys, tokens, recovery codes.
    return text.length >= 24 && !/\s/.test(text) && /[A-Za-z]/.test(text) && /\d/.test(text) && entropy(text) > 3.5;
  }
  function states(el) {
    const result = [];
    const kind = role(el);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') result.push('disabled');
    if (kind === 'checkbox' || kind === 'radio' || kind === 'switch') {
      const checked = el.localName === 'input' ? el.checked : el.getAttribute('aria-checked') === 'true';
      result.push(checked ? 'checked' : 'unchecked');
    }
    if (el.getAttribute('aria-selected') === 'true' || (el.localName === 'option' && el.selected)) result.push('selected');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) result.push(expanded === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-pressed') === 'true') result.push('pressed');
    if (el.required || el.getAttribute('aria-required') === 'true') result.push('required');
    if (el.getAttribute('aria-invalid') === 'true') result.push('invalid');
    if (el.readOnly) result.push('readonly');
    if (/^h[1-6]$/.test(el.localName)) result.push(`level=${el.localName[1]}`);
    if (el.localName === 'input' && el.type === 'password') result.push('password');
    return result;
  }
  function value(el) {
    const tag = el.localName;
    if (tag === 'select') return clean([...el.selectedOptions].map(option => option.text).join(', '));
    if (tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden'].includes(el.type))) {
      if (!el.value) return '';
      return sensitive(el) || looksSecret(el.value) ? '<redacted>' : short(el.value, 120);
    }
    if (el.isContentEditable) return sensitive(el) ? '<redacted>' : short(el.innerText, 120);
    return '';
  }
  function testId(el) {
    return el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa') || el.getAttribute('data-cy') || null;
  }
  // A locator bundle fingerprints an element several ways, so replay can still find it when one way breaks.
  function bundle(el) {
    let xpath = '', full = '';
    try { xpath = X.generate(el); } catch {}
    try { full = X.structural(el); } catch {}
    const attributes = {};
    for (const key of ['id', 'name', 'placeholder', 'aria-label', 'type', 'title']) {
      const item = el.getAttribute(key);
      if (item && !(key === 'id' && /\d{4,}|[a-f0-9]{8,}/i.test(item))) attributes[key] = item.slice(0, 120);
    }
    const href = el.getAttribute('href');
    if (href && !/^javascript:/i.test(href)) { try { attributes.href = new URL(href, location.href).pathname.slice(0, 200); } catch {} }
    return { xpath, full_xpath: full, role: role(el), name: name(el), text: short(el.innerText || '', 80), testid: testId(el),
      tag: el.localName, attributes };
  }
  function matchesName(el, wanted) {
    const target = clean(wanted).toLowerCase();
    return !!target && clean(name(el)).toLowerCase() === target;
  }
  globalThis.QaNinjaDom = { role, name, visible, inViewport, interactive, sensitive, looksSecret, states, value, bundle, testId,
    matchesName, clean, short };
})();
