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
const TABS = { xpath: 'finder', record: 'recorder', generate: 'generator' };
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
}
async function refreshCaps(quiet = false) {
  const revision = authRevision;
  try { const result = await rpc('CAPABILITIES'); if (revision !== authRevision) return; caps = result; capsKnown = true; }
  catch (error) {
    if (revision !== authRevision) return;
    if (error.status === 401) {
      caps = { recording: false, signedIn: false }; capsKnown = true;
      if (!quiet) notice(`Your session ended. Log in again to ${mode === 'generate' ? 'see your test plans' : 'record'}.`, true);
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
  if (mode === 'record') await refreshDraft(); else await renderGenerate(true);
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
    $('steps').replaceChildren(...steps.slice(-50).map(step => {
      const li = document.createElement('li'); li.value = step.sequence; li.textContent = step.label;
      const small = document.createElement('small'); small.textContent = step.xpath; li.append(small); return li;
    }));
    $('steps-note').hidden = steps.length <= 50;
    $('steps-note').textContent = `Showing the latest 50 of ${steps.length} steps.`;
  }
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
for (const name of Object.keys(TABS)) bind(`mode-${name}`, () => changeMode(name));
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
$('destination').onchange = async () => { await chrome.storage.local.set({ destination: $('destination').value }); $('folder-row').hidden = $('destination').value !== 'local'; };
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('auth_state' in changes || 'capabilities' in changes)) return;
  renderAuth().then(renderPlanState).then(loadQuota).catch(fail);
});
window.addEventListener('focus', () => refreshSession().catch(fail));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSession().catch(fail); });
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
