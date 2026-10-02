// Execute in the service worker: one test run at a time, started from the side panel, the web app ("Run on this
// computer") or a queued request, and driven by executor/core.mjs. Bundled by build.js into dist/executor.js
// (global NinjaExecutor). Uses the worker's session globals: api, apiForm, refreshAuth, capabilities, authState, emit.
import * as bridge from './executor/bridge.mjs';
import { Run } from './executor/core.mjs';
import { runsApi } from './executor/runs-api.mjs';
import { vault } from './executor/secrets.mjs';

const CONSENT_VERSION = 1;
const RUN_ID = /^run_[0-9a-f]{32}$/;
const ACTIVE_KEY = 'exec_active';
let active = null;
const asks = new Map();
const fail = (message, code, status) => Object.assign(new Error(message), { code, status });

async function runnerId() {
  let { runner_id: id } = await chrome.storage.local.get('runner_id');
  if (!id) { id = 'ext-' + crypto.randomUUID().replace(/-/g, ''); await chrome.storage.local.set({ runner_id: id }); }
  return id;
}

export async function prefs() {
  const { exec_prefs: stored } = await chrome.storage.local.get('exec_prefs');
  return { consent: 0, autoRun: false, closeWindow: false, ...stored };
}
export async function setPrefs(changes) {
  const next = { ...(await prefs()), ...changes };
  await chrome.storage.local.set({ exec_prefs: next });
  await chrome.alarms.clear('qaninja-pending');
  if (next.autoRun) chrome.alarms.create('qaninja-pending', { periodInMinutes: 1 });
  return next;
}

export function state() { return active?.view() || null; }
export function isRunTab(tabId) { return !!active?.page && active.page.tabId === tabId; }
export function stop() { active?.stop(); return state(); }
export function takeover() { active?.takeover(); return state(); }
export function resume() { active?.resume(); return state(); }
export function answer(id, value) { const ask = asks.get(id); if (ask) { asks.delete(id); ask(value ?? null); } }

const ui = {
  update(view) { emit({ event: 'run', run: view }); },
  ask(question) {
    const id = crypto.randomUUID();
    emit({ event: 'ask', ask: { id, ...question } });
    return new Promise(resolve => {
      asks.set(id, resolve);
      setTimeout(() => { if (asks.has(id)) { asks.delete(id); resolve(null); } }, 5 * 60 * 1000);
    });
  },
};

async function secretsFor(spec, subject, given = {}, remember = false) {
  const values = new Map();
  const testId = spec.test?.id ?? 'adhoc';
  for (const { name } of spec.secrets || []) {
    const typed = typeof given[name] === 'string' && given[name] ? given[name] : null;
    if (typed && remember) await vault.remember(subject, testId, name, typed);
    const value = typed ?? await vault.recall(subject, testId, name);
    if (value != null) values.set(name, value);
  }
  return values;
}

// source: 'panel' creates a run; 'dashboard' and 'queued' claim one the API already holds; 'bridge' creates one that a
// coding agent drives (approving the session in the panel counts as consent).
export async function start({ source, workflowId, runId, mode, brain, baseUrl, inputs, secrets, remember, consent, external = null, adhoc = null }) {
  if (active) throw fail('Another run is in progress in this browser. Stop it first.', 'busy', 409);
  if (source === 'bridge') consent = true;
  const preferences = await prefs();
  if (!consent && preferences.consent < CONSENT_VERSION) throw fail('Confirm how test runs work before the first run.', 'consent_required', 412);
  if (consent && preferences.consent < CONSENT_VERSION) await setPrefs({ consent: CONSENT_VERSION });
  const session = await refreshAuth();
  if (!session.signedIn) throw fail('Log in to run tests.', 'not_signed_in', 401);
  const caps = await capabilities(true);
  if (!caps.execute) throw fail('Running tests needs a paid plan.', 'plan_required', 403);
  const runs = runsApi({ api, apiForm, runnerId: await runnerId() });
  let created;
  if (source === 'panel') {
    created = await runs.create({ workflow_id: workflowId, origin: 'extension', mode, brain, base_url: baseUrl || null, inputs: inputs || null });
  } else if (source === 'bridge') {
    created = await runs.create(adhoc ? { workflow_id: null, origin: 'mcp_local', mode: 'agent', brain: 'mcp', adhoc }
      : { workflow_id: workflowId, origin: 'mcp_local', mode, brain: 'mcp', base_url: baseUrl || null, inputs: inputs || null });
  } else {
    if (!RUN_ID.test(runId || '')) throw fail('That run no longer exists.', 'not_found', 404);
    created = await runs.claim(runId);
  }
  const values = await secretsFor(created.spec, session.subject, secrets || {}, !!remember);
  const run = new Run({ summary: created.run, spec: created.spec, api: runs, ui, secrets: values, interactive: source === 'panel',
    closeWindow: preferences.closeWindow, external });
  active = run;
  await chrome.storage.local.set({ [ACTIVE_KEY]: { id: run.id, runnerId: runs.runnerId, at: Date.now() } });
  run.start().catch(() => null).then(summary => bridge.runFinished(run, summary)).finally(async () => {
    if (active === run) active = null;
    await chrome.storage.local.remove(ACTIVE_KEY);
    emit({ event: 'run', run: run.view() });
  });
  ui.update(run.view());
  return created.run;
}

// A worker restart loses the run in memory: report it as interrupted and release the test window.
export async function recoverAfterRestart() {
  const { [ACTIVE_KEY]: stale } = await chrome.storage.local.get(ACTIVE_KEY);
  if (!stale) return;
  await chrome.storage.local.remove(ACTIVE_KEY);
  try {
    const targets = await chrome.debugger.getTargets();
    for (const target of targets) if (target.attached && target.tabId && target.type === 'page') await chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
  } catch {}
  try {
    await refreshAuth();
    await api(`/execute/runs/${stale.id}/finish`, 'POST', { runner_id: stale.runnerId, status: 'error', error: 'runner_restarted' });
  } catch {}
}

export async function pending() { return api('/execute/runs/pending'); }
export async function dismiss(runId) { if (!RUN_ID.test(runId)) throw fail('Unknown run.', 'not_found', 404); return api(`/execute/runs/${runId}/cancel`, 'POST'); }

// With auto-run on, queued runs from the web app or a coding agent start without asking.
export async function checkPending() {
  const preferences = await prefs();
  if (!preferences.autoRun || active || preferences.consent < CONSENT_VERSION) return;
  const queued = await pending().catch(() => []);
  const next = queued.find(run => !run.cancel_requested);
  if (next) await start({ source: 'queued', runId: next.id, consent: true }).catch(error => emit({ event: 'error', message: error.message }));
}

export async function forgetSecrets(subject, testId) { await vault.forget(subject, testId); }
export async function rememberedSecrets(subject, testId) { return vault.names(subject, testId); }
// Secrets belong to the account that saved them; signing out (no subject) removes them all.
export async function keepSecretsFor(subject) { await vault.keepOnly(subject || ''); }

// The web app's "Run on this computer". Only the app's own origin may ask (externally_connectable), and the run must
// belong to the account signed in here: the API returns 404 otherwise.
export async function external(message, sender) {
  const appOrigin = new URL(CONFIG.APP_BASE_URL).origin;
  if (sender.origin !== appOrigin) return { ok: false, error: 'forbidden', message: 'Not allowed.' };
  if (message?.type === 'QANINJA_PING') {
    const auth = await refreshAuth().catch(() => authState);
    let execute = false;
    if (auth.signedIn) execute = !!(await capabilities().catch(() => ({}))).execute;
    return { ok: true, version: chrome.runtime.getManifest().version, signedIn: !!auth.signedIn, subject: auth.subject || null, execute, busy: !!active };
  }
  if (message?.type === 'QANINJA_RUN') {
    const auth = await refreshAuth().catch(() => ({ signedIn: false }));
    if (!auth.signedIn) return { ok: false, error: 'not_signed_in', message: 'Log in to the QA Ninja extension with the same account.' };
    if (message.subject && message.subject !== auth.subject) return { ok: false, error: 'account_mismatch', message: 'The QA Ninja extension is signed in to a different account.' };
    if (active) return { ok: false, error: 'busy', message: 'Another run is in progress in this browser.' };
    try {
      await start({ source: 'dashboard', runId: message.runId, consent: message.consent === true });
      return { ok: true };
    } catch (error) {
      const code = error.code || (error.status === 404 ? 'not_found' : 'failed');
      return { ok: false, error: ['not_found', 'busy', 'not_signed_in', 'consent_required'].includes(code) ? code : 'failed', message: error.message };
    }
  }
  return { ok: false, error: 'unknown', message: 'Unknown request.' };
}

// The MCP bridge for coding agents (see executor/bridge.mjs).
bridge.init({ start, activeRun: () => active, panelOpen: () => typeof panels !== 'undefined' && panels.size > 0 });
export const bridgePair = code => bridge.pair(code);
export const bridgeConnect = () => bridge.connect();
export const bridgeDisconnect = forget => bridge.disconnect(forget);
export const bridgeApprove = allow => bridge.approve(allow);
export const bridgeView = () => bridge.bridgeView();
export const bridgeKeepTrying = () => bridge.keepTrying();
export const bridgeAnswerWithin = ms => bridge.setAnswerWithin(ms);

export { CONSENT_VERSION };
