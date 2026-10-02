const $ = id => document.getElementById(id);
let port, requestCounter = 0, mode = 'xpath', inspection = null, draft = null, caps = {}, busy = false;
// capsKnown stays false until plan state is known, so a cover never flashes for paid users.
let capsKnown = false, picking = false, pickPending = false, authEpoch = null, authRevision = 0;
// The free Finder's inspection count, from the worker: { limit, used, resetsAt }. limit is null on paid plans.
let quota = null, quotaTimer = null;
// Generate: the account's saved recordings (its test plans), the selected one, and the script framework.
let plans = null, plansRequest = null, planId = null, savedPlanId = null, framework = 'playwright', script = '';
const recordings = new Map();
const pending = new Map();
const TABS = { xpath: 'finder', record: 'recorder', generate: 'generator', execute: 'executor' };
const PLAN_NAMES = { FREE: 'Free plan', BASIC: 'Basic plan', SUPER: 'Supercharged plan' };
// Scripts come from the same generator as a recording's exports. Downloads are named for the plan.
const FRAMEWORKS = {
  playwright: { file: 'script_playwright.py', name: slug => `test_${slug}_playwright.py` },
  selenium: { file: 'script_selenium.py', name: slug => `test_${slug}_selenium.py` },
  cypress: { file: 'script_cypress.cy.js', name: slug => `${slug}.cy.js` },
  robot: { file: 'script_robot.robot', name: slug => `${slug}.robot` }
};
const PICK_HINT = 'Pick an element, explore its hierarchy, and copy its XPath.';
const PICKING_HINT = 'Click an element on the page. Press Esc to cancel.';
const STATUS = { recording: 'Recording this tab', paused: 'Recording paused', pausing: 'Pausing…', finishing: 'Finishing…', ready: 'Ready to save' };
const SAVED = { local: 'Saved to your folder', dashboard: 'Saved to your dashboard', zip: 'Downloaded as ZIP' };
function notice(message = '', error = false) {
  $('notice').textContent = message; $('notice').classList.toggle('error', error);
}
const calm = matchMedia('(prefers-reduced-motion: reduce)');
let toastTimer = 0;
const copiedTimers = new Map();
// Toasts confirm a finished action and leave on their own; pointing at one keeps it open.
function toast(title, detail = '') {
  const item = $('toast-template').content.firstElementChild.cloneNode(true);
  item.querySelector('.toast-title').textContent = title; item.querySelector('.toast-detail').textContent = detail;
  $('toast').replaceChildren(item); dismissToast(2400);
}
function dismissToast(delay = 0) {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    const item = $('toast').firstElementChild; if (!item) return;
    item.dataset.state = 'leaving'; setTimeout(() => item.remove(), 200);
  }, delay);
}
async function copyText(text, button, title, detail = text) {
  try { await navigator.clipboard.writeText(text); }
  catch { throw new Error("Couldn't copy to the clipboard. Click in the panel, then try again."); }
  notice(); toast(title, detail);
  // Restart the check animation on repeated copies.
  delete button.dataset.copied; void button.offsetWidth; button.dataset.copied = '';
  clearTimeout(copiedTimers.get(button)); copiedTimers.set(button, setTimeout(() => delete button.dataset.copied, 1500));
}
function connect() {
  port = chrome.runtime.connect({ name: 'qaninja-panel' });
  chrome.windows.getCurrent().then(win => port.postMessage({ type: 'HELLO', windowId: win.id }));
  port.onMessage.addListener(msg => {
    if (msg.requestId) {
      const handler = pending.get(msg.requestId); if (!handler) return;
      pending.delete(msg.requestId); clearTimeout(handler.timer);
      msg.ok ? handler.resolve(msg.data) : handler.reject(Object.assign(new Error(msg.error), { status: msg.status })); return;
    }
    if (msg.event === 'inspect') {
      if (mode !== 'xpath') return;
      if (msg.inspectionEvent === 'selected') { setPicking(false); renderInspection({ ...msg.state, frameId: msg.frameId }); notice(); }
      if (msg.inspectionEvent === 'cancelled') { setPicking(false); notice('Selection cancelled.'); }
      if (['error', 'unavailable'].includes(msg.inspectionEvent)) { setPicking(false); notice(msg.message, true); if (msg.inspectionEvent === 'unavailable') resetInspection(); }
    }
    if (msg.event === 'quota') { quota = msg.quota; renderPickState(); }
    if (msg.event === 'reset') resetInspection();
    if (msg.event === 'recording') { draft = msg.draft; renderRecording(); }
    if (msg.event === 'step') refreshDraft();
    if (msg.event === 'error') notice(msg.message, true);
    if (msg.event === 'run') { exec.run = msg.run; renderRun(); if (msg.run?.done) loadExecLists().catch(() => {}); }
    if (msg.event === 'ask') showAsk(msg.ask);
    if (msg.event === 'bridge') { exec.bridge = msg.bridge; renderBridge(); }
  });
  port.onDisconnect.addListener(() => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Connection interrupted. Your recording draft is preserved.')); }
    pending.clear(); setTimeout(connect, 300);
  });
}
function rpc(type, payload = {}) {
  const requestId = ++requestCounter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('This operation is taking too long. Your draft is preserved; retry.')); }, 90000);
    pending.set(requestId, { resolve, reject, timer });
    port.postMessage({ type, ...payload, requestId });
  });
}
function inspect(action, payload = {}) { return rpc('INSPECT', { action, ...payload }); }
// Hitting the limit is explained by the inspection gate, not a notice.
function fail(error) { if (error.status === 429) loadQuota(); else notice(error.message, true); }
function bind(id, fn) { $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(fail)); }
async function renderAuth() {
  const { auth_state: auth, capabilities: cached } = await chrome.storage.local.get(['auth_state', 'capabilities']);
  const signedIn = !!auth?.signedIn;
  $('menu-signin').hidden = signedIn; $('dashboard').hidden = !signedIn; $('logout').hidden = !signedIn;
  $('menu-plans').textContent = signedIn ? 'Plans and billing' : 'View plans';
  if (authEpoch !== (auth?.epoch || null)) {
    authEpoch = auth?.epoch || null; authRevision++;
    caps = {}; capsKnown = false; plans = null; plansRequest = null; planId = null; savedPlanId = null; recordings.clear();
    exec.tests = null; exec.connections = []; exec.secretNames = [];
    script = ''; $('script-text').textContent = ''; $('plans').replaceChildren();
  }
  if (!signedIn) { caps = { recording: false, signedIn: false }; capsKnown = true; }
  else if (cached?.epoch === auth.epoch && cached?.subject === auth.subject && cached.valid_until * 1000 > Date.now()) {
    caps = cached; capsKnown = true;
  }
  renderPlan();
  if (!capsKnown) await refreshCaps(true);
}
let sessionRefresh;
function refreshSession(quiet = true) {
  return sessionRefresh ||= (async () => {
    try { await rpc('AUTH_STATE'); }
    catch (error) { if (!quiet) notice(error.message, true); }
    await renderAuth(); await refreshCaps(quiet); await renderPlanState(); await loadQuota();
  })().finally(() => { sessionRefresh = null; });
}
// Signed out, the footer offers Log in and Sign up; signed in, it names the plan, which also decides the paid tabs' covers.
function renderPlan() {
  const signedOut = capsKnown && !caps.signedIn;
  $('account-status').hidden = signedOut; $('account-actions').hidden = !signedOut;
  $('account-status').textContent = signedOut ? '' : !capsKnown ? 'Signed in' : PLAN_NAMES[caps.plan] || 'Signed in';
}
// Every Log in and Sign up link opens login.html, which opens the website at once (open=1) and returns to this tab.
// Note: login.html's mode is login or signup; sidebar.html's mode (see startTab) is the tab.
function authLink(kind) {
  return 'login.html?' + new URLSearchParams({ mode: kind, ...(mode !== 'xpath' && { return: mode }), open: '1' });
}
function renderAuthLinks() {
  $('menu-signin').href = $('footer-login').href = authLink('login');
  $('footer-signup').href = authLink('signup');
}
async function renderPlanState() {
  renderPlan();
  if (mode === 'record') await renderRecording();
  if (mode === 'generate') await renderGenerate();
  if (mode === 'execute') await renderExecute();
}
async function refreshCaps(quiet = false) {
  const revision = authRevision;
  try { const result = await rpc('CAPABILITIES'); if (revision !== authRevision) return; caps = result; capsKnown = true; }
  catch (error) {
    if (revision !== authRevision) return;
    if (error.status === 401) {
      caps = { recording: false, signedIn: false }; capsKnown = true;
      if (!quiet) notice(`Your session ended. Log in again to ${mode === 'generate' ? 'see your test plans' : mode === 'execute' ? 'run tests' : 'record'}.`, true);
    } else if (!quiet) notice(error.message, true);
  }
  renderPlan();
}
const frozen = () => !!quota && quota.limit !== null && quota.used >= quota.limit && quota.resetsAt > Date.now();
async function loadQuota() {
  try { quota = await rpc('FINDER_QUOTA'); } catch {} // Without a count, the worker still gates each inspection.
  renderPickState();
}
function unlockTime(at) {
  const date = new Date(at), time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? `at ${time}` : `tomorrow at ${time}`;
}
function renderQuota() {
  const limited = quota?.limit != null, locked = frozen();
  $('quota').hidden = !limited || locked; $('quota-gate').hidden = !locked;
  if (limited) {
    const left = Math.max(0, quota.limit - (quota.resetsAt > Date.now() ? quota.used : 0));
    $('quota-rail').style.setProperty('--left', left);
    $('quota-text').textContent = `${left} ${left === 1 ? 'inspection' : 'inspections'} left today`;
  }
  // Only picking locks; exploring the element path belongs to the inspection already made.
  if (locked) $('quota-reset').textContent = `Inspecting unlocks ${unlockTime(quota.resetsAt)}. The element path, Test, and Copy still work. Paid plans include unlimited inspections.`;
  clearTimeout(quotaTimer);
  if (limited && quota.resetsAt > Date.now()) quotaTimer = setTimeout(loadQuota, Math.min(quota.resetsAt - Date.now() + 500, 2 ** 31 - 1));
}
function renderPickState() {
  const locked = frozen() && !picking;
  $('pick').classList.toggle('primary', !picking && !locked); $('pick').classList.toggle('picking', picking);
  $('pick').disabled = locked;
  $('pick-label').textContent = picking ? 'Cancel selection' : 'Select element';
  $('pick-hint').textContent = picking ? PICKING_HINT : PICK_HINT;
  $('pick-hint').hidden = locked || !picking && !!inspection?.current;
  $('trail-empty').hidden = !!inspection;
  // Copy validates against the live selection, so it needs one.
  $('copy').disabled = !inspection?.current;
  renderPathForm(); renderQuota();
}
// Swaps the expression between the generated XPath and the full path; hidden when there is nothing to swap to.
function renderPathForm() {
  const current = inspection?.current, full = !!current && $('expression').value === inspection.fullPath;
  $('full-path').hidden = !current || full && inspection.fullPath === inspection.xpath;
  $('full-path').textContent = full ? 'Use short XPath' : 'Use full XPath';
}
function setMatchCount(text, state = '') {
  $('match-count').textContent = text; $('match-count').dataset.state = state;
  // A fresh result lifts in, so testing again visibly re-checks even when the count is unchanged.
  if (state && !calm.matches) $('match-count').animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
}
// Splits a URL for the one-line tab: host and path, which truncate, then the last segment, which stays. The full URL is copied.
function urlParts(href) {
  const decode = part => { try { return decodeURIComponent(part); } catch { return part; } };
  let url;
  try { url = new URL(href); } catch { return { host: href, middle: '', tail: '' }; }
  if (!/^(https?|file):$/.test(url.protocol)) return { host: href, middle: '', tail: '' };
  const segments = url.pathname.split('/').filter(Boolean).map(segment => `/${decode(segment)}`);
  const tail = segments.pop() || (url.host ? '' : '/');
  return { host: url.host.replace(/^www\./, ''), middle: segments.join(''), tail };
}
let context = { url: '', kind: 'Page' };
function renderContext(data) {
  context = { url: data.url || '', kind: data.frameId ? 'Frame' : 'Page' };
  const { host, middle, tail } = urlParts(context.url), label = `Copy ${context.kind.toLowerCase()} URL`;
  $('frame-kind').textContent = context.kind;
  $('url-host').textContent = host; $('url-middle').textContent = middle; $('url-tail').textContent = tail;
  $('frame-context').title = `${label}\n${context.url}`; $('frame-context').setAttribute('aria-label', `${label}, ${host}${middle}${tail}`);
  $('frame-context').hidden = !context.url;
}
function setPicking(on) { picking = on; renderPickState(); }
async function cancelPick() { await inspect('cancel'); setPicking(false); }
function clearInspection() {
  inspection = null; $('breadcrumbs').replaceChildren(); $('children').replaceChildren();
  $('hierarchy').hidden = true; $('match-details').hidden = true; $('match-nav').hidden = true; $('frame-context').hidden = true;
  setMatchCount('');
  renderPickState();
}
function resetInspection() { picking = false; $('expression').value = ''; clearInspection(); }
function listItem(content) { const li = document.createElement('li'); li.append(content); return li; }
function span(className, text) { const element = document.createElement('span'); element.className = className; element.textContent = text; return element; }
function nodeButton(node, onSelect) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'node';
  button.append(span('node-name', `${node.tag}${node.identity}`));
  if (node.children) button.append(span('node-count', `${node.children} ${node.children === 1 ? 'child' : 'children'}`));
  if (node.label || node.hidden) {
    const small = document.createElement('small');
    if (node.label) small.append(span('node-label', node.label));
    if (node.hidden) small.append(span('node-flag', 'Hidden'));
    button.append(small);
  }
  button.addEventListener('click', () => onSelect().catch(fail));
  for (const event of ['mouseenter', 'focus']) button.addEventListener(event, () => inspect('preview', { nodeId: node.id }).catch(() => {}));
  for (const event of ['mouseleave', 'blur']) button.addEventListener(event, () => inspect('preview').catch(() => {}));
  return button;
}
function pathButton(node, current, landed) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = `${node.tag}${node.identity}`;
  button.title = node.label || button.textContent;
  // The target frame lands only when the selection moves, not when the same element re-renders.
  if (current) { button.className = landed ? 'target landed' : 'target'; button.setAttribute('aria-current', 'true'); }
  button.onclick = () => inspect('select', { nodeId: node.id }).then(renderInspection).catch(fail);
  return button;
}
function renderInspection(data, preserveExpression = false) {
  const previous = inspection?.current?.id;
  inspection = data;
  renderContext(data);
  if (!preserveExpression && data.current) $('expression').value = data.query || data.xpath;
  const count = data.query ? data.matchCount : data.current ? 1 : null;
  if (count === null) setMatchCount('');
  else setMatchCount(`${count} match${count === 1 ? '' : 'es'}`, count === 1 ? 'unique' : count ? 'multiple' : 'none');
  $('hierarchy').hidden = !data.current;
  $('breadcrumbs').replaceChildren();
  if (data.current) {
    const landed = data.current.id !== previous;
    $('breadcrumbs').append(...[...data.ancestors, data.current].map(node => listItem(pathButton(node, node.id === data.current.id, landed))));
    $('children').replaceChildren(...data.children.map(node => listItem(nodeButton(node, async () => renderInspection(await inspect('select', { nodeId: node.id }))))));
    $('child-count').textContent = data.childTotal ? `${data.childTotal} ${data.childTotal === 1 ? 'child' : 'children'}` : 'None';
    $('child-pages').hidden = data.childTotal <= 50;
    $('previous-children').disabled = data.childOffset === 0;
    $('next-children').disabled = data.childOffset + 50 >= data.childTotal;
    $('back').disabled = !data.canBack; $('original').disabled = !data.canOriginal;
  }
  $('match-nav').hidden = !(data.matchCount > 1);
  $('match-details').hidden = !(data.matchCount > 1);
  if (data.matchCount > 1) {
    $('match-position').textContent = `${data.matchIndex + 1} of ${data.matchCount}`;
    $('previous-match').disabled = data.matchIndex <= 0; $('next-match').disabled = data.matchIndex >= data.matchCount - 1;
    $('match-list').replaceChildren(...data.matches.map(node => listItem(nodeButton(node, async () => renderInspection(await inspect('match', { index: node.index }))))));
    $('match-pages').hidden = data.matchCount <= 50;
    $('previous-matches').disabled = data.matchIndex < 50;
    $('next-matches').disabled = (Math.floor(data.matchIndex / 50) + 1) * 50 >= data.matchCount;
  }
  renderPickState();
}
async function changeMode(next) {
  if (next === mode) return;
  // Leaving Record pauses a recording. Leaving XPath stops picking in every frame, then clears the selected one.
  if (mode === 'record') await rpc('RECORD', { action: 'pause' });
  if (mode === 'xpath') {
    if (picking) await inspect('cancel').catch(() => {});
    await inspect('clear').catch(() => {}); resetInspection();
  }
  mode = next;
  for (const [name, panel] of Object.entries(TABS)) {
    const tab = $(`mode-${name}`), selected = name === mode;
    $(panel).hidden = !selected; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
  // Logging in from the menu or footer comes back to this tab.
  renderAuthLinks();
  notice();
  if (mode === 'xpath') return;
  await refreshCaps();
  if (mode === 'record') await refreshDraft();
  else if (mode === 'generate') await renderGenerate(true);
  else await renderExecute(true);
}
// The empty test plan list and a dashboard save lead to another tab; focus goes to that tab.
async function openTab(name) { await changeMode(name); $(`mode-${name}`).focus(); }
async function refreshDraft() {
  const result = await rpc('DRAFT'); draft = result?.draft; await renderRecording();
}
async function renderRecording() {
  const status = draft?.status;
  // Without a paid plan Record opens on its cover. A draft kept from a paid plan stays saveable instead.
  $('record-cover').hidden = !capsKnown || !!caps.recording || !!draft;
  $('record-signin').hidden = !!caps.signedIn; $('record-plans').classList.toggle('primary', !!caps.signedIn);
  $('record-tools').hidden = !caps.recording && !draft;
  $('record-lapsed').hidden = !capsKnown || !!caps.recording || !draft;
  // A new recording can start once the current one is saved.
  $('record').hidden = !!draft && status !== 'saved';
  $('record').disabled = busy || !caps.recording;
  $('pause').hidden = !['recording', 'paused'].includes(status);
  $('pause').textContent = status === 'paused' ? 'Resume' : 'Pause';
  $('pause').disabled = busy || status === 'paused' && (!caps.recording || draft.ownerId !== caps.user_id || draft.ownerSubject !== caps.subject);
  $('finish').hidden = !['recording', 'paused'].includes(status);
  $('finish').disabled = busy;
  $('record-status').dataset.state = status || 'idle';
  $('record-status').textContent = !draft ? 'Ready to record' : status === 'saved' ? SAVED[draft.savedTo] || 'Saved' : STATUS[status] || 'Saving…';
  $('draft-view').hidden = !draft;
  $('save-actions').hidden = !['ready', 'saved'].includes(status);
  $('save-files').textContent = status === 'saved' ? 'Save again' : 'Save';
  // Once saved, starting a new recording is the primary action.
  $('save-files').classList.toggle('primary', status !== 'saved');
  $('open-generate').hidden = !(status === 'saved' && draft.savedTo === 'dashboard');
  $('save-files').disabled = busy; $('zip').disabled = busy; $('discard').disabled = busy;
  if (draft) {
    const steps = await NinjaStore.steps(draft.id);
    $('step-count').textContent = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
    $('draft-title').textContent = draft.name;
    $('capture-typing').checked = draft.captureTyping !== false;
    $('steps').replaceChildren(...steps.slice(-50).map(step => {
      const li = document.createElement('li'); li.value = step.sequence; li.textContent = stepText(step);
      const small = document.createElement('small'); small.textContent = step.xpath; li.append(small); return li;
    }));
    $('steps-note').hidden = steps.length <= 50;
    $('steps-note').textContent = `Showing the latest 50 of ${steps.length} steps.`;
  }
}
// Steps read as actions: "Typed into Email", "Pressed Enter", "Opened shop.example.com/cart".
const VERBS = { fill: 'Typed into', select: 'Selected in', check: 'Checked', uncheck: 'Unchecked', press: 'Pressed', navigate: 'Opened' };
function stepText(step) {
  if (step.action_type === 'press') return `Pressed ${step.key || 'Enter'}`;
  if (step.action_type === 'fill' && step.sensitive) return `Typed a secret into ${step.label}`;
  return VERBS[step.action_type] ? `${VERBS[step.action_type]} ${step.label}` : step.label;
}
let exporter, folderHandle = null;
function showFolder(handle) {
  folderHandle = handle; $('folder-name').textContent = `Folder: ${handle.name}`; $('choose-folder').textContent = 'Change folder';
}
async function exportSnapshot() {
  if (!draft) throw new Error('No recording to save.');
  const steps = await NinjaStore.steps(draft.id);
  if (!steps.length) throw new Error('Record a step before saving.');
  exporter ||= import(chrome.runtime.getURL('dist/exports.js'));
  return (await exporter).createExports(draft, steps);
}
async function chooseFolder() {
  if (!window.showDirectoryPicker) throw new Error('Folder access is unavailable in this browser. Use Download ZIP.');
  const handle = await window.showDirectoryPicker({ id: 'qaninja', startIn: 'desktop', mode: 'readwrite' });
  await NinjaStore.put('settings', handle, 'folder'); showFolder(handle);
  return handle;
}
async function save(destination = $('destination').value, folder) {
  if (busy) return;
  const savingDraft = draft;
  busy = true; await renderRecording(); notice('Preparing files…');
  try {
    const files = await exportSnapshot();
    if (destination === 'local') {
      const handle = folder || await NinjaStore.get('settings', 'folder');
      if (!handle || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('Choose a folder to grant access, or download a ZIP. Your recording is ready to save.');
      }
      const module = await exporter;
      await module.writeFolder(handle, draft, files);
    } else if (destination === 'zip') {
      await (await exporter).downloadZip(draft, files);
    } else {
      const revision = authRevision;
      const authorize = fresh => rpc('UPLOAD_TOKEN', { ownerId: savingDraft.ownerId, ownerSubject: savingDraft.ownerSubject, fresh });
      const auth = await authorize(false);
      if (revision !== authRevision || auth.epoch !== authEpoch) throw new Error('The account changed. Your draft is preserved.');
      const form = new FormData();
      form.append('metadata', JSON.stringify({ client_id: draft.id, name: draft.name, created_at: draft.createdAt }));
      for (const [name, blob] of files) form.append('files', blob, name);
      const send = current => {
        if (revision !== authRevision || current.epoch !== auth.epoch) throw new Error('The account changed. Your draft is preserved.');
        return fetch(CONFIG.API_BASE_URL + '/workflows', { method: 'POST', headers: { Authorization: `Bearer ${current.token}` }, body: form });
      };
      let response = await send(auth);
      if (response.status === 401) response = await send(await authorize(true));
      const result = await response.json();
      if (!response.ok) { if (response.status === 401) await refreshSession(); throw new Error(result.detail || 'Cloud save failed. Your draft is preserved.'); }
      if (revision !== authRevision) throw new Error('The account changed. Your draft is preserved.');
      savedPlanId = result.id;
    }
    await rpc('SAVED', { id: savingDraft.id, destination });
    notice(); // The record status line announces where the files went.
  } finally { busy = false; await renderRecording(); }
}
const GENERATE_PITCH = $('generate-cover-text').textContent;
// Generate opens on its cover without a paid plan. With one, it lists the account's test plans and shows the
// selected plan's script. A refused list means the session or plan ended since caps were checked.
async function renderGenerate(reload = false) {
  if (capsKnown && caps.recording && (reload || !plans) && await loadPlans() === 'refused') await refreshCaps();
  const open = capsKnown && !!caps.recording;
  $('generate-cover').hidden = !capsKnown || open; $('generate-tools').hidden = !open;
  if (open) return renderPlans();
  // Saved test plans outlive a subscription; the dashboard keeps them downloadable.
  const saved = caps.signedIn && caps.cloud_used || 0;
  $('generate-signin').hidden = !!caps.signedIn; $('generate-plans').classList.toggle('primary', !!caps.signedIn);
  $('generate-dashboard').hidden = !saved;
  $('generate-cover-text').textContent = saved ? `Your ${saved} saved test ${saved === 1 ? 'plan is' : 'plans are'} in your dashboard, where you can download or delete them. Generating tests here needs a paid plan.` : GENERATE_PITCH;
}
function loadPlans() {
  return plansRequest ||= (async () => {
    if (!plans) $('plans-state').textContent = 'Loading test plans…';
    const revision = authRevision;
    try { const result = await rpc('PLANS'); if (revision !== authRevision) return 'refused'; plans = result; }
    catch (error) {
      if ([401, 403].includes(error.status)) { plans = null; return 'refused'; }
      notice(error.message, true); return 'failed';
    } finally { $('plans-state').textContent = ''; }
    // Keep the selection when it still exists; otherwise start at the newest plan.
    if (!plans.some(plan => plan.id === planId)) planId = plans[0]?.id ?? null;
    return 'loaded';
  })().finally(() => { plansRequest = null; });
}
function renderPlans() {
  const count = plans?.length || 0;
  $('plans-retry').hidden = !!plans; $('plans-empty').hidden = !plans || !!count;
  $('plans-view').hidden = !count; $('script-view').hidden = !count;
  if (!count) return;
  $('plan-count').textContent = `${count} ${count === 1 ? 'plan' : 'plans'}`;
  $('plans').replaceChildren(...plans.map(plan => listItem(planButton(plan))));
  showPlan(planId).catch(fail);
}
function savedOn(iso) {
  const date = new Date(iso);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
}
function planButton(plan) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'plan'; button.dataset.id = plan.id; button.title = plan.name;
  button.append(span('plan-name', plan.name), span('plan-steps', `${plan.steps} ${plan.steps === 1 ? 'step' : 'steps'}`));
  const saved = document.createElement('small'); saved.textContent = `Saved ${savedOn(plan.created_at)}`; button.append(saved);
  button.addEventListener('click', () => showPlan(plan.id, true).catch(fail));
  return button;
}
// The selected plan wears the target frame; like the element path, it lands when the selection moves.
function markPlan(landed) {
  for (const button of $('plans').querySelectorAll('.plan')) {
    const current = Number(button.dataset.id) === planId;
    button.classList.toggle('target', current); button.classList.remove('landed');
    if (!current) { button.removeAttribute('aria-current'); continue; }
    button.setAttribute('aria-current', 'true');
    if (landed && !calm.matches) { void button.offsetWidth; button.classList.add('landed'); }
  }
}
async function showPlan(id, landed = false) {
  const revision = authRevision;
  landed &&= id !== planId; planId = id; markPlan(landed);
  if (!recordings.has(id)) {
    await renderScript();
    try { const result = await rpc('PLAN', { id }); if (revision !== authRevision) return; recordings.set(id, result.recording || {}); }
    catch (error) { if (planId === id) $('script-text').textContent = ''; throw error; }
  }
  await renderScript();
}
// Plan names become filenames: ASCII, lowercase, underscores. Python files start with test_ so pytest collects them.
function scriptName(plan) {
  const slug = plan.name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60).replace(/^_+|_+$/g, '');
  return FRAMEWORKS[framework].name(slug || `plan_${plan.id}`);
}
// Always renders the current plan and framework, so a slow fetch can't overwrite a newer choice.
async function renderScript() {
  const revision = authRevision;
  const plan = plans?.find(item => item.id === planId), recording = recordings.get(planId), chosen = framework;
  if (!plan) return;
  $('copy-script').disabled = $('download-script').disabled = !recording;
  $('script-code').setAttribute('aria-labelledby', `fw-${chosen}`);
  if (!recording) { script = ''; $('script-text').textContent = 'Loading…'; $('script-file').textContent = ''; return; }
  exporter ||= import(chrome.runtime.getURL('dist/exports.js'));
  const text = (await exporter).scripts({ name: plan.name }, recording.steps || [])[FRAMEWORKS[chosen].file];
  if (revision !== authRevision || plan.id !== planId || chosen !== framework) return;
  script = text; $('script-text').textContent = text; $('script-file').textContent = scriptName(plan);
  $('script-code').scrollTo(0, 0);
}
function setFramework(name, remember = true) {
  if (!FRAMEWORKS[name]) return;
  framework = name;
  if (remember) chrome.storage.local.set({ framework: name });
  for (const tab of $('frameworks').children) { const selected = tab.dataset.framework === name; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }
  return renderScript();
}
// Arrow keys move along a tab row. Mode tabs only move focus, because switching pauses a recording (Enter or
// Space switches); framework tabs switch at once.
function arrowKeys(row, activate) {
  row.addEventListener('keydown', event => {
    const tabs = [...row.querySelectorAll('[role="tab"]')], index = tabs.indexOf(document.activeElement);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (index < 0 || next === undefined) return;
    event.preventDefault(); const tab = tabs[(next + tabs.length) % tabs.length]; tab.focus(); if (activate) tab.click();
  });
}
for (const name of Object.keys(TABS)) if (name !== 'execute') bind(`mode-${name}`, () => changeMode(name));
arrowKeys($('mode-xpath').parentElement, false); arrowKeys($('frameworks'), true);
for (const tab of $('frameworks').children) bind(tab.id, () => setFramework(tab.dataset.framework));
bind('plans-record', () => openTab('record'));
bind('plans-retry', () => renderGenerate(true));
bind('open-generate', () => { planId = savedPlanId ?? planId; return openTab('generate'); });
bind('open-plan', () => rpc('WEBSITE', { page: 'workflow', id: planId }));
bind('copy-script', () => copyText(script, $('copy-script'), 'Script copied', $('script-file').textContent));
bind('download-script', () => {
  const url = URL.createObjectURL(new Blob([script], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = $('script-file').textContent;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});
bind('pick', async () => {
  if (pickPending) return;
  if (picking) { await cancelPick(); notice('Selection cancelled.'); return; }
  pickPending = true;
  // Starting a pick clears the page-side selection, so drop the stale path but keep the expression.
  try { clearInspection(); await inspect('pick'); setPicking(true); notice(); } finally { pickPending = false; }
});
$('expression').addEventListener('input', () => { setMatchCount('Press Test to check'); $('match-nav').hidden = true; $('match-details').hidden = true; renderPathForm(); });
// Cmd+Enter (Ctrl+Enter elsewhere) tests the expression, as in most editors.
$('expression').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('test').click(); } });
$('test').title = navigator.userAgentData?.platform === 'macOS' ? 'Test (⌘Enter)' : 'Test (Ctrl+Enter)';
bind('test', async () => {
  try { const data = await inspect('test', { expression: $('expression').value }); renderInspection(data, true); notice(); }
  catch (error) { setMatchCount(''); $('match-nav').hidden = true; $('match-details').hidden = true; throw error; }
});
bind('copy', async () => { const expression = $('expression').value; await inspect('validate', { expression }); await copyText(expression, $('copy'), 'XPath copied'); });
bind('frame-context', () => copyText(context.url, $('frame-context'), `${context.kind} URL copied`));
bind('full-path', async () => {
  const current = await inspect('state'), full = $('expression').value !== current.fullPath;
  const data = await inspect('select', { nodeId: current.current.id }); renderInspection(data);
  if (full) { $('expression').value = data.fullPath; renderPathForm(); }
});
bind('back', async () => renderInspection(await inspect('back'))); bind('original', async () => renderInspection(await inspect('original')));
for (const [id, delta] of [['previous-match', -1], ['next-match', 1]]) bind(id, async () => renderInspection(await inspect('match', { index: inspection.matchIndex + delta })));
bind('previous-matches', async () => renderInspection(await inspect('match', { index: (Math.floor(inspection.matchIndex / 50) - 1) * 50 })));
bind('next-matches', async () => renderInspection(await inspect('match', { index: (Math.floor(inspection.matchIndex / 50) + 1) * 50 })));
for (const [id, delta] of [['previous-children', -50], ['next-children', 50]]) bind(id, async () => renderInspection(await inspect('children', { offset: inspection.childOffset + delta }), true));
bind('record', async () => { draft = await rpc('RECORD', { action: 'start' }); await renderRecording(); $('pause').focus(); });
bind('pause', async () => { draft = await rpc('RECORD', { action: draft.status === 'paused' ? 'resume' : 'pause' }); await renderRecording(); });
async function folderForSave() {
  if ($('destination').value !== 'local') return undefined;
  const handle = folderHandle || await NinjaStore.get('settings', 'folder');
  if (!handle) return chooseFolder();
  if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted' ||
      await handle.requestPermission({ mode: 'readwrite' }) === 'granted') return handle;
  throw new Error('Folder access was denied. Choose a folder or download a ZIP. Your draft is preserved.');
}
bind('finish', async () => {
  // Acquire the handle during this user gesture, before export work consumes it.
  let folder, folderError;
  try { folder = await folderForSave(); } catch (error) { folderError = error; }
  draft = await rpc('RECORD', { action: 'finish' }); await renderRecording(); $('save-files').focus();
  if (folderError) { notice(folderError.name === 'AbortError' ? 'Folder selection cancelled. Choose a folder or download a ZIP; your draft is preserved.' : folderError.message, true); return; }
  await save($('destination').value, folder);
});
bind('save-files', async () => { const folder = await folderForSave(); await save($('destination').value, folder); });
bind('zip', () => save('zip'));
// Call the picker directly from the click gesture, before generating files.
$('choose-folder').onclick = () => chooseFolder().then(handle => ['ready', 'saved'].includes(draft?.status) ? save('local', handle) : undefined).catch(error => notice(error.name === 'AbortError' ? 'Folder selection cancelled. Your draft is preserved.' : error.message, true));
bind('discard', async () => { if (confirm('Discard this local draft? Files already saved are kept.')) { await rpc('DISCARD'); draft = null; await renderRecording(); $('record').focus(); } });
bind('dashboard', () => rpc('WEBSITE', { page: 'dashboard' })); bind('generate-dashboard', () => rpc('WEBSITE', { page: 'dashboard' }));
for (const id of ['record-plans', 'generate-plans', 'menu-plans', 'quota-plans']) bind(id, () => rpc('WEBSITE', { page: 'account' }));
bind('auth-refresh', () => refreshSession(false));
bind('logout', async () => { await rpc('LOGOUT'); caps = {}; capsKnown = false; await renderAuth(); await changeMode('xpath'); notice('Signed out. XPath Finder is ready.'); });
// The menu is a disclosure: close it on selection, outside clicks, and Esc. Esc otherwise cancels picking.
const menuSummary = $('menu').querySelector('summary');
$('menu').querySelector('.menu-panel').addEventListener('click', event => { if (event.target.closest('button')) { $('menu').open = false; menuSummary.focus(); } });
document.addEventListener('click', event => { if ($('menu').open && !$('menu').contains(event.target)) $('menu').open = false; });
$('toast').addEventListener('pointerenter', () => clearTimeout(toastTimer));
$('toast').addEventListener('pointerleave', () => dismissToast(1200));
$('toast').addEventListener('click', () => dismissToast());
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if ($('menu').open) { $('menu').open = false; menuSummary.focus(); return; }
  if (picking) cancelPick().then(() => notice('Selection cancelled.')).catch(error => notice(error.message, true));
});
$('capture-typing').onchange = () => rpc('RECORD_TYPING', { on: $('capture-typing').checked }).catch(fail);
chrome.storage.local.get('capture_typing').then(data => { if (!draft) $('capture-typing').checked = data.capture_typing !== false; });
$('destination').onchange = async () => { await chrome.storage.local.set({ destination: $('destination').value }); $('folder-row').hidden = $('destination').value !== 'local'; };
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('auth_state' in changes || 'capabilities' in changes)) return;
  renderAuth().then(renderPlanState).then(loadQuota).catch(fail);
});
window.addEventListener('focus', () => refreshSession().catch(fail));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSession().catch(fail); });
// Execute: run a saved test in a Chrome window that QA Ninja drives. The worker owns the run; this tab starts it,
// shows its progress, and answers the agent's questions.
const exec = { tests: null, connections: [], run: null, prefs: {}, consentVersion: 1, pending: [], recent: [], ask: null, secretNames: [], timer: 0 };
const PHASES = { opening: 'Opening the test window…', replaying: 'Replaying', recovering: 'The agent is fixing a step', verifying: 'The agent is checking the outcome',
  agent: 'The agent is running the test', done: 'Finished' };
const STEP_STATUS = { pending: 'Waiting', running: 'Running', passed: 'Passed', healed: 'Fixed by the agent', failed: 'Failed', blocked: 'Blocked', skipped: 'Skipped' };
const PROVIDERS = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', openrouter: 'OpenRouter', chatgpt: 'ChatGPT' };
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function selectedTest() { return exec.tests?.find(test => test.id === Number($('exec-test').value)); }
async function loadExecLists() {
  const [pending, recent] = await Promise.all([rpc('EXEC_PENDING').catch(() => []), rpc('EXEC_RUNS').catch(() => ({ data: [] }))]);
  exec.pending = pending || []; exec.recent = recent?.data || [];
  renderExecLists();
}
async function renderExecute(reload = false) {
  const open = capsKnown && !!caps.execute;
  $('execute-cover').hidden = !capsKnown || open; $('execute-tools').hidden = !open;
  $('execute-signin').hidden = !!caps.signedIn; $('execute-plans').classList.toggle('primary', !!caps.signedIn);
  if (!open) return;
  const revision = authRevision;
  if (reload || !exec.tests) {
    const [tests, connections, status] = await Promise.all([rpc('EXEC_TESTS'), rpc('EXEC_CONNECTIONS').catch(() => []), rpc('EXEC_STATE')]);
    if (revision !== authRevision) return;
    exec.tests = tests; exec.connections = connections; exec.run = status.run; exec.prefs = status.prefs; exec.consentVersion = status.consentVersion;
    loadExecLists().catch(() => {});
  }
  renderSetup(); renderRun();
  rpc('BRIDGE_STATE').then(view => { exec.bridge = view; renderBridge(); }).catch(() => {});
  clearInterval(exec.timer);
  exec.timer = setInterval(() => { if (mode === 'execute' && !document.hidden) loadExecLists().catch(() => {}); }, 15000);
}
function renderSetup() {
  const tests = exec.tests || [];
  $('exec-empty').hidden = !!tests.length; $('exec-setup').hidden = !tests.length || !!(exec.run && !exec.run.done);
  $('exec-consent').hidden = (exec.prefs.consent || 0) >= exec.consentVersion;
  $('exec-auto-run').checked = !!exec.prefs.autoRun; $('exec-close-window').checked = !!exec.prefs.closeWindow;
  if (!tests.length) return;
  const chosen = Number($('exec-test').value) || tests[0].id;
  $('exec-test').replaceChildren(...tests.map(test => { const option = element('option', '', test.name); option.value = test.id; return option; }));
  $('exec-test').value = String(tests.some(test => test.id === chosen) ? chosen : tests[0].id);
  const brains = [];
  if (caps.execute_managed_available) {
    const left = Math.max(0, (caps.execute_managed_limit || 0) - (caps.execute_managed_used || 0));
    brains.push(['managed', `QA Ninja Agent (${left} ${left === 1 ? 'run' : 'runs'} left this month)`]);
  }
  for (const item of exec.connections) {
    if (item.status === 'active' && item.model) brains.push([item.id, `${item.label || PROVIDERS[item.provider]} · ${item.model}`]);
  }
  brains.push(['none', 'No agent (replay only)']);
  // The test's default agent applies unless the person picked one themselves.
  const previous = $('exec-brain').dataset.touched ? $('exec-brain').value : null;
  $('exec-brain').replaceChildren(...brains.map(([value, label]) => { const option = element('option', '', label); option.value = value; return option; }));
  const test = selectedTest();
  const preferred = test?.settings?.default_brain;
  $('exec-brain').value = brains.some(([value]) => value === previous) ? previous : brains.some(([value]) => value === preferred) ? preferred : brains[0][0];
  if (!$('exec-mode').dataset.touched) $('exec-mode').value = test?.settings?.default_mode || 'assisted';
  renderTestMeta();
}
async function renderTestMeta() {
  const test = selectedTest(); if (!test) return;
  const last = test.last_run;
  $('exec-test-meta').textContent = `${test.steps} ${test.steps === 1 ? 'step' : 'steps'}` + (last?.verdict ? ` · last run ${last.verdict.toLowerCase()}` : '') +
    (test.settings?.goal ? ` · Goal: ${test.settings.goal}` : '');
  if (!$('exec-base-url').dataset.touched) $('exec-base-url').value = test.settings?.base_url || '';
  const noAgent = $('exec-brain').value === 'none';
  $('exec-mode').disabled = noAgent; if (noAgent) $('exec-mode').value = 'replay';
  $('exec-brain-meta').textContent = noAgent ? 'Broken steps fail the run instead of being fixed.' : $('exec-brain').value === 'managed' ? 'Runs on QA Ninja. A run counts only if the agent is needed.' : 'Runs on your own key.';
  // The recording's own secret fields and any the test's settings add, by name; values are typed here, never stored by QA Ninja.
  const secrets = test.secrets || test.settings?.secrets || [];
  const names = await rpc('EXEC_SECRETS', { testId: test.id }).then(result => result.names).catch(() => []);
  exec.secretNames = names;
  $('exec-forget').hidden = !names.length;
  $('exec-secrets').hidden = !secrets.length;
  $('exec-secret-fields').replaceChildren(...secrets.map(secret => {
    const field = element('div', 'field');
    const label = element('label', '', secret.label || secret.name); label.htmlFor = `secret-${secret.name}`;
    const input = element('input'); input.type = 'password'; input.id = `secret-${secret.name}`; input.dataset.secret = secret.name; input.autocomplete = 'off';
    input.placeholder = names.includes(secret.name) ? 'Saved on this device' : 'Enter for this run';
    field.append(label, input); return field;
  }));
}
function runState(run) {
  if (!run) return 'idle';
  if (run.done) return (run.verdict || (run.error ? 'error' : 'done')).toLowerCase();
  return run.paused ? 'paused' : 'running';
}
function renderRun() {
  const run = exec.run;
  $('exec-run').hidden = !run;
  $('exec-setup').hidden = !exec.tests?.length || !!(run && !run.done);
  if (!run) return;
  const total = run.steps.filter(step => step.index < 1000).length;
  const current = run.current != null ? run.steps.findIndex(step => step.index === run.current) + 1 : 0;
  $('exec-run-title').textContent = run.name || 'Run';
  $('exec-run-status').dataset.state = runState(run);
  $('exec-run-status').textContent = run.done ? (run.verdict ? `Run ${run.verdict.toLowerCase()}` : run.error ? 'Run stopped' : 'Run finished')
    : run.paused ? 'You have control of the test window' : run.phase === 'replaying' && current ? `Replaying step ${current} of ${total}` : PHASES[run.phase] || 'Starting…';
  $('exec-run-message').textContent = run.message || '';
  $('exec-run-verdict').hidden = !run.verdict; $('exec-run-verdict').textContent = run.verdict || ''; $('exec-run-verdict').dataset.verdict = run.verdict || '';
  $('exec-run-steps').replaceChildren(...run.steps.slice(-60).map(step => {
    const li = element('li', '', step.label || `Step ${step.index + 1}`); li.value = step.index + 1; li.dataset.status = step.status;
    li.append(element('small', '', STEP_STATUS[step.status] || step.status)); return li;
  }));
  $('exec-takeover').hidden = $('exec-stop').hidden = !!run.done;
  $('exec-takeover').textContent = run.paused ? 'Resume' : 'Take over';
  $('exec-open-run').hidden = $('exec-new-run').hidden = !run.done;
}
function renderExecLists() {
  $('exec-pending').hidden = !exec.pending.length;
  $('exec-pending-list').replaceChildren(...exec.pending.map(run => {
    const li = element('li', 'run-item');
    li.append(element('span', 'run-name', run.name), element('small', 'meta', run.origin === 'mcp_remote' ? 'From a coding agent' : 'From the dashboard'));
    const actions = element('span', 'run-actions');
    const start = element('button', 'compact primary', 'Run'); start.type = 'button';
    start.addEventListener('click', () => startPending(run.id).catch(fail));
    const dismiss = element('button', 'compact quiet', 'Dismiss'); dismiss.type = 'button';
    dismiss.addEventListener('click', () => rpc('EXEC_DISMISS', { runId: run.id }).then(loadExecLists).catch(fail));
    actions.append(start, dismiss); li.append(actions); return li;
  }));
  $('exec-recent').hidden = !exec.recent.length;
  $('exec-recent-list').replaceChildren(...exec.recent.map(run => {
    const button = element('button', 'run-item'); button.type = 'button';
    const chip = element('span', 'verdict', run.verdict || run.status); chip.dataset.verdict = run.verdict || run.status.toUpperCase();
    button.append(element('span', 'run-name', run.name), chip, element('small', 'meta', `${run.steps_passed}/${run.steps_total} steps${run.healed_steps ? ` · ${run.healed_steps} fixed` : ''}`));
    button.addEventListener('click', () => rpc('WEBSITE', { page: 'run', id: run.id }).catch(fail));
    return element('li').appendChild(button).parentElement;
  }));
}
async function startPending(runId) {
  await rpc('EXEC_APPROVE', { runId, consent: (exec.prefs.consent || 0) >= exec.consentVersion });
  notice(); await loadExecLists();
}
async function startRun() {
  const test = selectedTest(); if (!test) throw new Error('Choose a test to run.');
  const secrets = {};
  for (const input of $('exec-secret-fields').querySelectorAll('input[data-secret]')) if (input.value) secrets[input.dataset.secret] = input.value;
  try {
    exec.run = { name: test.name, steps: [], phase: 'opening', done: false };
    renderRun();
    await rpc('EXEC_START', { workflowId: test.id, mode: $('exec-mode').value, brain: $('exec-brain').value, baseUrl: $('exec-base-url').value.trim() || null,
      secrets, remember: $('exec-remember').checked, consent: (exec.prefs.consent || 0) >= exec.consentVersion });
    for (const input of $('exec-secret-fields').querySelectorAll('input')) input.value = '';
    notice();
  } catch (error) {
    exec.run = (await rpc('EXEC_STATE').catch(() => ({}))).run || null; renderRun(); renderSetup();
    if (error.message.startsWith('Confirm how test runs work')) { $('exec-consent').hidden = false; $('exec-consent-accept').focus(); }
    throw error;
  }
}
function showAsk(ask) {
  exec.ask = ask;
  $('exec-ask').hidden = false; $('exec-ask-reason').textContent = ask.reason || '';
  $('exec-ask-label').textContent = ask.label || ask.name; $('exec-ask-value').value = ''; $('exec-ask-value').focus();
}
async function answerAsk(value) {
  if (!exec.ask) return;
  await rpc('EXEC_ANSWER', { id: exec.ask.id, value }); exec.ask = null; $('exec-ask').hidden = true;
}
function renderBridge() {
  const bridge = exec.bridge || { status: 'disconnected', paired: false };
  const connected = bridge.status === 'connected';
  $('bridge-status').textContent = connected ? `Connected to ${bridge.agent || 'your coding agent'}` : bridge.status === 'connecting' ? 'Connecting…'
    : bridge.paired ? 'Paired, not connected' : 'Not connected';
  $('bridge-pair').hidden = connected || bridge.paired;
  $('bridge-actions').hidden = !connected && !bridge.paired;
  $('bridge-reconnect').hidden = connected; $('bridge-disconnect').hidden = !connected;
  $('bridge-approval').hidden = !bridge.approvalNeeded;
  $('bridge-approval-text').textContent = `${bridge.agent || 'Your coding agent'} wants to run tests in this browser. It will see page text and screenshots of the test window, never your secrets.`;
  if (bridge.error && !connected) notice(bridge.error, true);
}
bind('bridge-pair-button', async () => { exec.bridge = await rpc('BRIDGE_PAIR', { code: $('bridge-code').value }); $('bridge-code').value = ''; renderBridge(); toast('Coding agent connected', exec.bridge.agent || ''); });
bind('bridge-reconnect', async () => { exec.bridge = await rpc('BRIDGE_CONNECT'); renderBridge(); if (exec.bridge.status !== 'connected') notice('The bridge is not running. Start your coding agent, then reconnect.', true); });
bind('bridge-disconnect', async () => { exec.bridge = await rpc('BRIDGE_DISCONNECT', { forget: false }); renderBridge(); });
bind('bridge-forget', async () => { exec.bridge = await rpc('BRIDGE_DISCONNECT', { forget: true }); renderBridge(); });
bind('bridge-allow', async () => { exec.bridge = await rpc('BRIDGE_APPROVE', { allow: true }); renderBridge(); });
bind('bridge-deny', async () => { exec.bridge = await rpc('BRIDGE_APPROVE', { allow: false }); renderBridge(); });
$('bridge-code').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('bridge-pair-button').click(); } });
bind('mode-execute', () => changeMode('execute'));
bind('execute-plans', () => rpc('WEBSITE', { page: 'account' }));
bind('exec-consent-accept', async () => { exec.prefs = await rpc('EXEC_PREFS', { changes: { consent: true } }); renderSetup(); });
bind('exec-start', startRun);
bind('exec-stop', () => rpc('EXEC_STOP'));
bind('exec-takeover', () => rpc(exec.run?.paused ? 'EXEC_RESUME' : 'EXEC_TAKEOVER'));
bind('exec-open-run', () => rpc('WEBSITE', { page: 'run', id: exec.run?.id }));
bind('exec-new-run', async () => { exec.run = null; renderRun(); await renderExecute(true); });
bind('exec-manage', () => rpc('WEBSITE', { page: 'execute', tab: 'agents' }));
bind('exec-record', () => openTab('record'));
bind('exec-ask-send', () => answerAsk($('exec-ask-value').value));
bind('exec-ask-skip', () => answerAsk(null));
bind('exec-forget', async () => { const test = selectedTest(); if (test) { await rpc('EXEC_FORGET', { testId: test.id }); await renderTestMeta(); toast('Saved secrets removed', test.name); } });
$('exec-test').addEventListener('change', () => { for (const id of ['exec-base-url', 'exec-mode', 'exec-brain']) delete $(id).dataset.touched; renderSetup(); });
$('exec-brain').addEventListener('change', () => { $('exec-brain').dataset.touched = '1'; renderTestMeta().catch(fail); });
$('exec-mode').addEventListener('change', () => { $('exec-mode').dataset.touched = '1'; });
$('exec-base-url').addEventListener('input', () => { $('exec-base-url').dataset.touched = '1'; });
$('exec-auto-run').addEventListener('change', () => rpc('EXEC_PREFS', { changes: { autoRun: $('exec-auto-run').checked } }).then(prefs => { exec.prefs = prefs; }).catch(fail));
$('exec-close-window').addEventListener('change', () => rpc('EXEC_PREFS', { changes: { closeWindow: $('exec-close-window').checked } }).then(prefs => { exec.prefs = prefs; }).catch(fail));
$('exec-ask-value').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('exec-ask-send').click(); } });

connect();
renderAuthLinks(); renderAuth().catch(fail); renderPickState(); loadQuota(); refreshSession().catch(fail);
$('version').textContent = `QA Ninja ${chrome.runtime.getManifest().version}`;
chrome.storage.local.get(['destination', 'framework']).then(data => {
  $('destination').value = data.destination || 'local'; $('folder-row').hidden = $('destination').value !== 'local';
  if (data.framework) setFramework(data.framework, false);
});
NinjaStore.get('settings', 'folder').then(handle => { if (handle) showFolder(handle); });
// Signing in from a cover comes back with ?mode=, so the panel reopens on that tab.
const startTab = new URLSearchParams(location.search).get('mode');
if (startTab) { history.replaceState(null, '', location.pathname); if (TABS[startTab]) changeMode(startTab).catch(fail); }
