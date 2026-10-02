/* Recording capture stays inactive until the worker grants a recording session.
   Recordings capture clicks, typed text, selections, checkboxes and Enter. Passwords, one-time codes, card numbers and
   other secret-looking fields never have their values captured: they become named secrets the test asks for at run
   time. A per-recording setting turns typed-text capture off entirely. */
(() => {
  if (globalThis.qaNinjaRecorder) return;
  const D = globalThis.QaNinjaDom;
  let recordingId = null, captureTyping = true, indicator = null;
  const pending = new Set();
  let typing = null; // { target, step } for the field being typed into
  let implicitSubmit = null; // Enter in a field also "clicks" the form's submit button; that click is not a step.
  async function submit(step) {
    let last;
    // The same event ID makes retries safe if an acknowledgement is lost.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await chrome.runtime.sendMessage({ type: 'RECORD_STEP', recordingId: step.recordingId, step });
        if (!result?.ok) throw new Error(result?.error || 'Unable to save this step.');
        return;
      } catch (error) { last = error; }
    }
    throw last;
  }
  function send(step) {
    const task = submit(step);
    pending.add(task);
    task.catch(error => chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: error.message }).catch(() => {}))
      .finally(() => pending.delete(task));
  }
  function base(target, action) {
    let xpath;
    try { xpath = QaNinjaXPath.generate(target); } catch { return null; }
    return { id: crypto.randomUUID(), recordingId, url: location.href, xpath, action_type: action,
      label: (D.name(target) || target.innerText || target.getAttribute('placeholder') || target.localName).trim().slice(0, 120),
      timestamp: new Date().toISOString(), value: '', aria_label: target.getAttribute('aria-label') || '', css_selector: '', shadow_path: '',
      locators: D.bundle(target), frame: window === top ? null : { url: location.href }, viewport: { width: innerWidth, height: innerHeight } };
  }
  const editable = node => node instanceof Element && (node.isContentEditable || node.localName === 'textarea' ||
    (node.localName === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color'].includes(node.type)));
  const toggle = node => node instanceof Element && node.localName === 'input' && ['checkbox', 'radio'].includes(node.type);
  const eventTarget = event => event.composedPath().find(node => node instanceof Element);
  const ignored = target => !target || target.closest('[data-qaninja-ui]');
  // Consecutive edits to one field become a single step, sent when the field is left or submitted.
  function flushTyping() {
    if (!typing) return;
    const { target, step } = typing; typing = null;
    const value = target.isContentEditable ? target.innerText : target.value;
    if (!value && !step.sensitive) return;
    if (step.sensitive || D.looksSecret(value)) Object.assign(step, { value: '', sensitive: true });
    else if (!captureTyping) Object.assign(step, { value: '', typed_hidden: true });
    else step.value = String(value).slice(0, 2000);
    send(step);
  }
  window.addEventListener('input', event => {
    if (!recordingId) return;
    const target = eventTarget(event);
    if (ignored(target) || !editable(target)) return;
    if (typing && typing.target !== target) flushTyping();
    if (!typing) {
      const step = base(target, 'fill');
      if (!step) return;
      if (D.sensitive(target)) step.sensitive = true;
      typing = { target, step };
    }
  }, true);
  window.addEventListener('change', event => {
    if (!recordingId) return;
    const target = eventTarget(event);
    if (ignored(target)) return;
    if (typing?.target === target) { flushTyping(); return; }
    if (target.localName === 'select') {
      const step = base(target, 'select');
      if (step) { step.value = [...target.selectedOptions].map(option => option.text.trim()).join(', ').slice(0, 500); send(step); }
    } else if (toggle(target)) {
      const step = base(target, target.checked || target.type === 'radio' ? 'check' : 'uncheck');
      if (step) send(step);
    }
  }, true);
  window.addEventListener('focusout', event => { if (typing && eventTarget(event) === typing.target) flushTyping(); }, true);
  window.addEventListener('keydown', event => {
    if (!recordingId || event.key !== 'Enter' || event.isComposing) return;
    const target = eventTarget(event);
    if (ignored(target) || target.localName === 'textarea' || target.isContentEditable) return;
    flushTyping();
    if (editable(target)) {
      const step = base(target, 'press');
      if (step) { step.key = 'Enter'; send(step); }
      implicitSubmit = { form: target.form || target.closest('form'), at: Date.now() };
    }
  }, true);
  window.addEventListener('click', event => {
    if (!recordingId || globalThis.qaNinjaInspector?.isPicking()) return;
    const target = eventTarget(event);
    if (ignored(target)) return;
    const submitted = implicitSubmit; implicitSubmit = null;
    if (event.detail === 0 && submitted?.form && Date.now() - submitted.at < 500 && target.closest('form') === submitted.form) return;
    flushTyping();
    // Checkboxes, radios and their labels are recorded as check or uncheck when they change.
    if (toggle(target) || (target.closest('label')?.control && toggle(target.closest('label').control))) return;
    const step = base(target, 'click');
    if (step) send(step);
  }, true);
  window.addEventListener('pagehide', flushTyping);
  // While recording, the page says so, and whether typed text is being captured.
  let pill = null;
  function showIndicator(on) {
    if (window !== top) return;
    if (!on) { indicator?.remove(); indicator = pill = null; return; }
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.dataset.qaninjaUi = 'recording';
      indicator.setAttribute('role', 'status');
      pill = document.createElement('span');
      pill.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 10px;border-radius:999px;' +
        'background:#1b2631;color:#fffff7;font:600 12px system-ui,sans-serif;box-shadow:0 2px 8px rgb(0 0 0/.3);border:1px solid #e74c3c;pointer-events:none';
      indicator.attachShadow({ mode: 'closed' }).append(pill);
      document.documentElement.append(indicator);
    }
    pill.textContent = captureTyping ? 'QA Ninja is recording · typed text is captured, passwords never' : 'QA Ninja is recording clicks';
  }
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === 'RECORD_STATE') {
      recordingId = msg.recordingId || null; captureTyping = msg.captureTyping !== false;
      showIndicator(!!recordingId); respond({ ok: true });
    }
    if (msg.type === 'RECORD_DRAIN') {
      flushTyping();
      recordingId = null; showIndicator(false);
      Promise.allSettled([...pending]).then(results => respond({ ok: results.every(result => result.status === 'fulfilled') }));
      return true;
    }
  });
  chrome.runtime.sendMessage({ type: 'RECORD_CONTEXT' }).then(result => {
    recordingId = result?.recordingId || null; captureTyping = result?.captureTyping !== false; showIndicator(!!recordingId);
  }).catch(() => {});
  globalThis.qaNinjaRecorder = true;
})();
