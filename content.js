/* Recording capture stays inactive until the worker grants a recording session. */
(() => {
  if (globalThis.qaNinjaRecorder) return;
  let recordingId = null;
  const pending = new Set();
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
  window.addEventListener('click', event => {
    if (!recordingId || globalThis.qaNinjaInspector?.isPicking()) return;
    const target = event.composedPath().find(node => node instanceof Element);
    if (!target || target.closest('[data-qaninja-ui]')) return;
    let xpath;
    try { xpath = QaNinjaXPath.generate(target); } catch { return; }
    // Persist metadata first. Screenshots are captured independently in the worker.
    const step = { id: crypto.randomUUID(), recordingId, url: location.href, xpath,
      label: (target.getAttribute('aria-label') || target.innerText || target.getAttribute('placeholder') || target.localName).trim().slice(0, 120),
      timestamp: new Date().toISOString(), action_type: 'click', value: '',
      aria_label: target.getAttribute('aria-label') || '', css_selector: '', shadow_path: '' };
    const task = submit(step);
    pending.add(task);
    task.catch(error => chrome.runtime.sendMessage({ type: 'RECORD_ERROR', error: error.message }).catch(() => {}))
      .finally(() => pending.delete(task));
  }, true);
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === 'RECORD_STATE') { recordingId = msg.recordingId || null; respond({ ok: true }); }
    if (msg.type === 'RECORD_DRAIN') {
      recordingId = null;
      Promise.allSettled([...pending]).then(results => respond({ ok: results.every(result => result.status === 'fulfilled') }));
      return true;
    }
  });
  chrome.runtime.sendMessage({ type: 'RECORD_CONTEXT' }).then(result => { recordingId = result?.recordingId || null; }).catch(() => {});
  globalThis.qaNinjaRecorder = true;
})();
