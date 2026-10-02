importScripts('config.js', 'store.js', 'dist/auth.js', 'session.js', 'dist/executor.js');
const panels = new Map();
let operations = Promise.resolve();
let stepWrites = Promise.resolve();
let captureQueue = Promise.resolve();
let lastScreenshotAt = 0;
const inspectionFrames = new Map();
const safeTab = tab => tab?.id && /^(https?|file):/.test(tab.url || '');
const emit = (data, windowId) => { for (const [port, context] of panels) { if (windowId !== undefined && context.windowId !== windowId) continue; try { port.postMessage(data); } catch {} } };
const serialized = fn => { const next = operations.then(fn); operations = next.catch(() => {}); return next; };
// Free Finder: 50 inspections per rolling 24 hours. An inspection is a completed pick; exploring its path and
// children, testing, and match navigation are free. The API counts signed-in free accounts; this device
// keeps its own count too, so signing out never grants a fresh 50. Paid plans are unlimited.
const FINDER_LIMIT = 50, FINDER_WINDOW = 86400000, QUOTA_TTL = 300000;
let quotaWrites = Promise.resolve(), quotaSync = Promise.resolve();
const exhausted = quota => quota.limit !== null && quota.used >= quota.limit && quota.resetsAt > Date.now();
function deviceQuota(usage) {
  const open = usage?.start + FINDER_WINDOW > Date.now();
  return { limit: FINDER_LIMIT, used: open ? usage.count : 0, resetsAt: open ? usage.start + FINDER_WINDOW : null };
}
async function refreshQuota(method = 'GET', expected) {
  const session = await refreshAuth();
  if (expected && !sameAuth(expected)) throw changedAccount();
  const usage = await api('/me/finder-usage', method, undefined, session);
  const quota = { subject: session.subject, epoch: session.epoch, limit: usage.limit, used: usage.used, resetsAt: usage.resets_at ? usage.resets_at * 1000 : null, checkedAt: Date.now() };
  await chrome.storage.local.set({ finder_quota: quota });
  return quota;
}
async function finderQuota(refresh = false) {
  await authReady;
  const { finder_quota: cached, finder_usage, capabilities: caps } = await chrome.storage.local.get(['finder_quota', 'finder_usage', 'capabilities']);
  const usable = authState.signedIn && sameAuth(cached) && (cached.limit !== null || sameAuth(caps) && caps.valid_until * 1000 > Date.now());
  if (!authState.signedIn) return deviceQuota(finder_usage);
  if (!refresh && usable && cached.checkedAt + QUOTA_TTL > Date.now()) return cached;
  try { return await refreshQuota(); }
  catch { return usable && sameAuth(cached) && (cached.limit === null || cached.resetsAt > Date.now()) ? cached : deviceQuota(finder_usage); }
}
async function assertInspection() {
  await quotaWrites;
  if (exhausted(await finderQuota())) throw Object.assign(new Error(`You've used today's ${FINDER_LIMIT} inspections.`), { status: 429 });
}
// Counts locally at once so the next click is gated; the API call settles in the background.
function spendInspection() {
  const task = quotaWrites.then(async () => {
    const quota = await finderQuota();
    if (quota.limit === null) return;
    const now = Date.now();
    const identity = { ...authState };
    const { finder_quota: cached, finder_usage } = await chrome.storage.local.get(['finder_quota', 'finder_usage']);
    const device = deviceQuota(finder_usage);
    const updates = { finder_usage: { start: device.resetsAt ? device.resetsAt - FINDER_WINDOW : now, count: device.used + 1 } };
    if (identity.signedIn && sameAuth(cached)) {
      const open = cached.resetsAt > now;
      updates.finder_quota = { ...cached, used: (open ? cached.used : 0) + 1, resetsAt: open ? cached.resetsAt : now + FINDER_WINDOW };
    }
    await chrome.storage.local.set(updates);
    emit({ event: 'quota', quota: await finderQuota() });
    if (!identity.signedIn) return;
    quotaSync = quotaSync.then(async () => {
      try { await refreshQuota('POST', identity); }
      catch (error) { if (error.status !== 429) return; await refreshQuota().catch(() => {}); }
      emit({ event: 'quota', quota: await finderQuota() });
    }).catch(() => {});
  });
  quotaWrites = task.catch(() => {});
  return task;
}
async function currentDraft() {
  const { activeDraft } = await chrome.storage.local.get('activeDraft');
  return activeDraft ? NinjaStore.get('drafts', activeDraft) : null;
}
// Worker restart never silently restarts page capture. IndexedDB keeps all accepted steps.
const restored = (async () => {
  await chrome.storage.local.remove(['isRecording', 'session_id', 'recording_sequence']);
  await NinjaExecutor.recoverAfterRestart().catch(() => {});
  const draft = await currentDraft();
  if (draft && ['recording', 'pausing', 'finishing'].includes(draft.status)) {
    draft.status = 'paused';
    await NinjaStore.put('drafts', draft);
    await broadcast({ type: 'RECORD_STATE', recordingId: null }, draft.tabId);
  }
})();
async function broadcast(message, tabId) {
  const targets = tabId ? [{ id: tabId }] : await chrome.tabs.query({});
  await Promise.all(targets.map(tab => chrome.tabs.sendMessage(tab.id, message).catch(() => {})));
}
async function tabFor(port) {
  const [tab] = await chrome.tabs.query({ active: true, windowId: panels.get(port)?.windowId });
  if (!safeTab(tab)) throw new Error('Open a regular web page to inspect elements. Browser settings and store pages cannot be inspected.');
  return tab;
}
// A test run owns its window: recording and picking stay out of it.
const runTabError = () => Object.assign(new Error('That tab is running a test. Use another tab, or stop the run first.'), { status: 409 });
async function inspect(port, msg) {
  const tab = await tabFor(port);
  if (NinjaExecutor.isRunTab(tab.id)) throw runTabError();
  const context = inspectionFrames.get(tab.id) || { frameId: 0 };
  if (msg.action === 'pick') {
    await assertInspection();
    await serialized(() => pause());
    await broadcast({ type: 'INSPECT', action: 'clear' }, tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'INSPECT', action: 'pick' });
    return { picking: true };
  }
  // Picking runs in every frame, so cancelling must reach them all, like the Esc path.
  if (msg.action === 'cancel') {
    await broadcast({ type: 'INSPECT', action: 'stop' }, tab.id);
    return {};
  }
  // Only the pick is gated and counted; moving through the path and children stays free, even at the limit.
  const result = await chrome.tabs.sendMessage(tab.id, { ...msg, type: 'INSPECT', documentId: context.documentId }, { frameId: context.frameId });
  if (!result?.ok) throw new Error(result?.error || 'Reload this page and select an element again.');
  return { ...result.data, frameId: context.frameId };
}
async function pause(finish = false) {
  await restored;
  const draft = await currentDraft();
  if (!draft || ['ready', 'saved'].includes(draft.status)) return draft;
  if (draft.status === 'recording') {
    draft.status = finish ? 'finishing' : 'pausing';
    await NinjaStore.put('drafts', draft);
    // Broadcast to every eligible frame in the recording tab. Step messages already
    // accepted by this worker are awaited separately; content scripts stop immediately.
    const frames = await chrome.webNavigation.getAllFrames({ tabId: draft.tabId }).catch(() => []);
    const drains = await Promise.all((frames || []).map(frame => chrome.tabs.sendMessage(draft.tabId,
      { type: 'RECORD_DRAIN' }, { frameId: frame.frameId }).catch(() => null)));
    await stepWrites;
    await captureQueue;
    if (drains.some(result => result?.ok === false)) {
      draft.status = 'paused'; await NinjaStore.put('drafts', { ...(await currentDraft()), status: 'paused' });
      throw new Error('Some steps could not be stored. Your draft is preserved; retry saving.');
    }
  }
  const latest = await currentDraft();
  latest.status = finish ? 'ready' : 'paused';
  await NinjaStore.put('drafts', latest);
  emit({ event: 'recording', draft: latest });
  return latest;
}
async function record(action, caps) {
  await restored;
  if (action === 'pause' || action === 'finish') return pause(action === 'finish');
  if (!caps.recording) throw new Error(caps.signedIn ? 'A paid plan is required to record.' : 'Log in to record. XPath Finder is free.');
  if (!sameAuth(caps)) throw changedAccount();
  let draft = await currentDraft();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!safeTab(tab)) throw new Error('Open a web page before recording.');
  if (NinjaExecutor.isRunTab(tab.id)) throw runTabError();
  if (action === 'start') {
    if (draft && draft.status !== 'saved') throw new Error('Save or discard the current draft before starting another recording.');
    draft = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), name: `Recording ${new Date().toLocaleString()}`,
      status: 'recording', sequence: 0, tabId: tab.id, ownerId: caps.user_id, ownerSubject: caps.subject,
      captureTyping: (await chrome.storage.local.get('capture_typing')).capture_typing !== false };
    await chrome.storage.local.set({ activeDraft: draft.id });
  } else if (!draft || draft.status !== 'paused' || draft.ownerId !== caps.user_id || draft.ownerSubject !== caps.subject) throw new Error('No paused recording is available for this account.');
  draft.tabId = tab.id; draft.status = 'recording';
  await NinjaStore.put('drafts', draft);
  await broadcast({ type: 'INSPECT', action: 'clear' });
  try { await chrome.tabs.sendMessage(tab.id, { type: 'RECORD_STATE', recordingId: draft.id, captureTyping: draft.captureTyping !== false }); }
  catch { draft.status = 'paused'; await NinjaStore.put('drafts', draft); throw new Error('Reload this page before recording.'); }
  emit({ event: 'recording', draft });
  return draft;
}
async function screenshot(step, tabId) {
  // Throttle visible-tab capture; never capture a different tab/window as evidence.
  if (Date.now() - lastScreenshotAt < 550) return;
  lastScreenshotAt = Date.now();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.active) return;
  try {
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
    const blob = await (await fetch(data)).blob();
    await NinjaStore.put('steps', { ...(await NinjaStore.get('steps', step.id)), screenshot: blob });
  } catch {} // The step remains valid without an unavailable screenshot.
}
async function handlePanel(port, msg) {
  switch (msg.type) {
    case 'INSPECT': return inspect(port, msg);
    case 'AUTH_STATE': await refreshAuth(true); return { ...authState };
    case 'UPLOAD_TOKEN': return uploadToken(msg.ownerId, msg.ownerSubject, !!msg.fresh);
    case 'RECORD': {
      const caps = ['start', 'resume'].includes(msg.action) ? await capabilities(true) : null;
      return serialized(() => record(msg.action, caps));
    }
    case 'DRAFT': await restored; return { draft: await currentDraft() };
    // Typed-text capture: remembered for new recordings, applied at once to the current one.
    case 'RECORD_TYPING': return serialized(async () => {
      await chrome.storage.local.set({ capture_typing: !!msg.on });
      const draft = await currentDraft();
      if (draft && !['ready', 'saved'].includes(draft.status)) {
        draft.captureTyping = !!msg.on; await NinjaStore.put('drafts', draft);
        if (draft.status === 'recording') await broadcast({ type: 'RECORD_STATE', recordingId: draft.id, captureTyping: draft.captureTyping }, draft.tabId);
        emit({ event: 'recording', draft });
      }
      return { on: !!msg.on };
    });
    case 'CAPABILITIES': return capabilities(true);
    case 'FINDER_QUOTA': return finderQuota(msg.refresh);
    // Generate's test plans are the account's saved recordings; a plan's recording holds the steps its scripts use.
    case 'PLANS': return api('/workflows');
    case 'PLAN':
      if (!Number.isSafeInteger(msg.id) || msg.id < 1) throw new Error('That test plan no longer exists. Open Generate again.');
      return api(`/workflows/${msg.id}`);
    case 'DISCARD': return serialized(async () => {
      const draft = await pause();
      if (draft) await NinjaStore.remove(draft.id);
      await chrome.storage.local.remove('activeDraft'); emit({ event: 'recording', draft: null });
    });
    case 'SAVED': return serialized(async () => {
      const draft = await currentDraft();
      if (draft?.id === msg.id && ['ready', 'saved'].includes(draft.status)) {
        draft.status = 'saved'; draft.savedTo = msg.destination;
        await NinjaStore.put('drafts', draft); emit({ event: 'recording', draft });
      }
    });
    case 'WEBSITE': {
      const plan = msg.page === 'workflow' && Number.isSafeInteger(msg.id) && msg.id > 0;
      const run = msg.page === 'run' && /^run_[0-9a-f]{32}$/.test(msg.id || '');
      const next = msg.page === 'account' ? '/account' : plan ? `/workflow/${msg.id}` : run ? `/execute/runs/${msg.id}`
        : msg.page === 'execute' ? `/execute${msg.tab === 'agents' ? '?tab=agents' : ''}` : '/dashboard';
      return chrome.tabs.create({ url: CONFIG.APP_BASE_URL + next });
    }
    // Execute: tests and agents come from the API; the run itself lives in NinjaExecutor.
    case 'EXEC_TESTS': return api('/execute/tests');
    case 'EXEC_CONNECTIONS': return api('/execute/connections');
    case 'EXEC_RUNS': return api('/execute/runs?limit=5');
    case 'EXEC_PENDING': return NinjaExecutor.pending();
    case 'EXEC_STATE': return { run: NinjaExecutor.state(), prefs: await NinjaExecutor.prefs(), consentVersion: NinjaExecutor.CONSENT_VERSION };
    case 'EXEC_START': {
      if (!Number.isSafeInteger(msg.workflowId) || msg.workflowId < 1) throw new Error('Choose a test to run.');
      return NinjaExecutor.start({ source: 'panel', workflowId: msg.workflowId, mode: msg.mode, brain: msg.brain, baseUrl: msg.baseUrl,
        inputs: msg.inputs, secrets: msg.secrets, remember: !!msg.remember, consent: !!msg.consent });
    }
    case 'EXEC_APPROVE': return NinjaExecutor.start({ source: 'queued', runId: msg.runId, consent: !!msg.consent });
    case 'EXEC_DISMISS': return NinjaExecutor.dismiss(msg.runId);
    case 'EXEC_STOP': return NinjaExecutor.stop();
    case 'EXEC_TAKEOVER': return NinjaExecutor.takeover();
    case 'EXEC_RESUME': return NinjaExecutor.resume();
    case 'EXEC_ANSWER': NinjaExecutor.answer(msg.id, typeof msg.value === 'string' ? msg.value.slice(0, 500) : null); return {};
    case 'EXEC_PREFS': return msg.changes ? NinjaExecutor.setPrefs({
      ...('autoRun' in msg.changes && { autoRun: !!msg.changes.autoRun }), ...('closeWindow' in msg.changes && { closeWindow: !!msg.changes.closeWindow }),
      ...(msg.changes.consent && { consent: NinjaExecutor.CONSENT_VERSION }) }) : NinjaExecutor.prefs();
    case 'EXEC_SECRETS': {
      await authReady;
      return { names: authState.subject ? await NinjaExecutor.rememberedSecrets(authState.subject, msg.testId) : [] };
    }
    case 'EXEC_FORGET': await authReady; if (authState.subject) await NinjaExecutor.forgetSecrets(authState.subject, msg.testId); return {};
    // Coding agents through the local MCP bridge.
    case 'BRIDGE_STATE': await NinjaExecutor.bridgeKeepTrying(); return NinjaExecutor.bridgeView();
    case 'BRIDGE_PAIR': return NinjaExecutor.bridgePair(String(msg.code || ''));
    case 'BRIDGE_CONNECT': return NinjaExecutor.bridgeConnect();
    case 'BRIDGE_DISCONNECT': return NinjaExecutor.bridgeDisconnect(!!msg.forget);
    case 'BRIDGE_APPROVE': return NinjaExecutor.bridgeApprove(!!msg.allow);
    case 'SIGN_IN': {
      if (!CONFIG.CLERK_PUBLISHABLE_KEY) throw new Error('Sign-in is not configured yet. XPath Finder is available.');
      // The website's sign-in page also hosts sign-up (?mode=signup); both finish on a known page.
      const next = ['/account', '/dashboard'].includes(msg.next) ? msg.next : '/account';
      const query = new URLSearchParams({ ...(msg.mode === 'signup' && { mode: 'signup' }), next });
      return chrome.tabs.create({ url: `${CONFIG.APP_BASE_URL}/sign-in?${query}` });
    }
    case 'LOGOUT':
      await serialized(() => pause());
      ++authGeneration;
      // If Clerk cannot revoke the shared session, report the failure instead of claiming sign-out succeeded.
      await NinjaClerk.signOut(CONFIG);
      await applyAuth(null);
      return {};
    default: throw new Error('Unknown action.');
  }
}
function trustedPage(sender) {
  return sender?.id === chrome.runtime.id && ['sidebar.html', 'login.html'].some(page => sender.url?.split('?')[0] === chrome.runtime.getURL(page));
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'qaninja-panel' || !trustedPage(port.sender)) { port.disconnect(); return; }
  panels.set(port, {});
  port.onMessage.addListener(msg => {
    if (msg.type === 'HELLO') { panels.set(port, { windowId: msg.windowId }); return; }
    handlePanel(port, msg).then(data => port.postMessage({ requestId: msg.requestId, ok: true, data }))
      .catch(error => { try { port.postMessage({ requestId: msg.requestId, ok: false, error: error.message, status: error.status }); } catch {} });
  });
  port.onDisconnect.addListener(() => {
    panels.delete(port);
    if (!panels.size) { inspectionFrames.clear(); broadcast({ type: 'INSPECT', action: 'clear' }); }
  });
});
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const handle = async () => {
    if (msg.type === 'INSPECT_EVENT') {
      if (!panels.size) { await broadcast({ type: 'INSPECT', action: 'clear' }, sender.tab?.id); return; }
      if (['cancelled', 'error'].includes(msg.event)) await broadcast({ type: 'INSPECT', action: 'stop' }, sender.tab?.id);
      if (msg.event === 'selected') {
        inspectionFrames.set(sender.tab.id, { frameId: sender.frameId, documentId: msg.documentId });
        await spendInspection();
        // Stop picking in sibling frames, preserving only the chosen highlight.
        const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id });
        await Promise.all(frames.map(frame => chrome.tabs.sendMessage(sender.tab.id,
          { type: 'INSPECT', action: 'stop', keepHighlight: frame.frameId === sender.frameId }, { frameId: frame.frameId }).catch(() => {})));
      }
      emit({ ...msg, event: 'inspect', inspectionEvent: msg.event, tabId: sender.tab?.id, frameId: sender.frameId }, sender.tab?.windowId);
      return {};
    }
    if (msg.type === 'RECORD_CONTEXT') {
      await restored; const draft = await currentDraft();
      const live = draft?.status === 'recording' && draft.tabId === sender.tab?.id;
      return { recordingId: live ? draft.id : null, captureTyping: draft?.captureTyping !== false };
    }
    if (msg.type === 'RECORD_STEP') {
      await restored;
      if (NinjaExecutor.isRunTab(sender.tab?.id)) throw new Error('Steps are not recorded in a test run window.');
      const task = stepWrites.then(async () => {
        const draft = await currentDraft();
        if (!draft || draft.id !== msg.recordingId || draft.tabId !== sender.tab?.id) throw new Error('The recording session changed.');
        const saved = await NinjaStore.append(draft.id, { ...msg.step, tabId: sender.tab.id, frameId: sender.frameId,
          documentId: sender.documentId, screenshot: null });
        captureQueue = captureQueue.then(() => screenshot(saved, sender.tab.id)).catch(() => {});
        emit({ event: 'step', recordingId: draft.id });
      });
      stepWrites = task.catch(() => {});
      await task; return { ok: true };
    }
    if (msg.type === 'RECORD_ERROR') { emit({ event: 'error', message: msg.error }); return {}; }
    if (['SIGN_IN', 'AUTH_STATE'].includes(msg.type)) {
      if (!trustedPage(sender)) throw new Error('Authentication is only available to extension pages.');
      return { ok: true, data: await handlePanel(null, msg) };
    }
    return {};
  };
  handle().then(respond).catch(error => respond({ ok: false, error: error.message }));
  return true;
});
// The web app's "Run on this computer" (externally_connectable lists only the app's origin).
chrome.runtime.onMessageExternal.addListener((msg, sender, respond) => {
  NinjaExecutor.external(msg, sender).then(respond).catch(error => respond({ ok: false, error: 'failed', message: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'qaninja-pending') NinjaExecutor.checkPending().catch(() => {});
  if (alarm.name === 'qaninja-bridge') NinjaExecutor.bridgeKeepTrying().catch(() => {});
});
// A paired bridge reconnects on its own: now, and every minute while it is away (the alarm exists only while paired).
NinjaExecutor.bridgeKeepTrying().catch(() => {});
chrome.tabs.onRemoved.addListener(tabId => { if (NinjaExecutor.isRunTab(tabId)) NinjaExecutor.stop(); });
chrome.tabs.onActivated.addListener(async () => {
  await broadcast({ type: 'INSPECT', action: 'clear' }); inspectionFrames.clear(); emit({ event: 'reset' });
});
// A page opened from the address bar or a bookmark during a recording is a navigate step; link clicks already are clicks.
const TYPED = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated']);
chrome.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId !== 0 || !/^https?:/.test(details.url)) return;
  if (!TYPED.has(details.transitionType) && !(details.transitionQualifiers || []).includes('from_address_bar')) return;
  await restored;
  const draft = await currentDraft();
  if (draft?.status !== 'recording' || draft.tabId !== details.tabId) return;
  const url = new URL(details.url);
  stepWrites = stepWrites.then(() => NinjaStore.append(draft.id, { id: crypto.randomUUID(), url: details.url, xpath: '', action_type: 'navigate',
    label: (url.host + url.pathname).slice(0, 120), value: '', aria_label: '', css_selector: '', shadow_path: '', timestamp: new Date().toISOString(),
    tabId: details.tabId, frameId: 0, screenshot: null })).then(() => emit({ event: 'step', recordingId: draft.id })).catch(() => {});
});
chrome.webNavigation.onCommitted.addListener(details => {
  const selected = inspectionFrames.get(details.tabId);
  if (details.frameId === 0 || selected?.frameId === details.frameId) {
    inspectionFrames.delete(details.tabId); emit({ event: 'reset', tabId: details.tabId });
  }
});
// Cookie changes can arrive while the panel stays open. Also refresh on focus and before API calls.
chrome.cookies.onChanged.addListener(({ cookie }) => {
  const hosts = [CONFIG.CLERK_SYNC_HOST, CONFIG.APP_BASE_URL].filter(Boolean).map(url => new URL(url).hostname);
  const domain = cookie.domain.replace(/^\./, '');
  if (cookie.name.startsWith('__') && hosts.some(host => host === domain || host.endsWith('.' + domain))) {
    if (/^__(?:clerk|client)_uat(?:_|$)/.test(cookie.name) && cookie.value === '0') {
      authReady.then(() => applyAuth(null)).catch(() => {});
      return;
    }
    refreshAuth(true).catch(() => {});
  }
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
