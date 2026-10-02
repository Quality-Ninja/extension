// The QA Ninja MCP bridge (npx @qaninja/mcp) lets a coding agent such as Claude Code drive test runs in this browser.
// The bridge listens on 127.0.0.1; this side connects to it, proves it knows the pairing code (and the bridge proves it
// does too), and then answers the agent's requests. The person approves each connection in the side panel. The agent
// sees page text and screenshots of the test window, never secret values, and the API is called with this browser's
// own session.
const PORTS = Array.from({ length: 10 }, (_, index) => 47821 + index);
const SETTINGS_KEY = 'bridge';
const APPROVAL_TIMEOUT = 2 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g).map(pair => parseInt(pair, 16)));
const fail = (code, message) => Object.assign(new Error(message), { code });

let socket = null, connecting = null, approved = false, approvalWaiters = [];
let view = { status: 'disconnected', agent: '', paired: false, error: '' };
let deps = null;
let pending = null;      // the agent's open decision: { start, resolve }
let waiters = [];        // bridge requests waiting for the next decision point
let lastState = null, stateSeq = 0, deliveredSeq = 0;
let answerWithin = 45000; // MCP clients often give up on a request after a minute

export function init(dependencies) { deps = dependencies; }
// Tests shorten how long a request waits for the next decision point.
export function setAnswerWithin(ms) { answerWithin = ms; }

function publish(changes = {}) {
  view = { ...view, ...changes };
  emit({ event: 'bridge', bridge: { ...view, approvalNeeded: approvalWaiters.length > 0 } });
}
export function bridgeView() { return { ...view, approvalNeeded: approvalWaiters.length > 0 }; }

async function hmac(key, text) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(text)));
}
const codeKey = code => new TextEncoder().encode(String(code).toUpperCase().replace(/[\s-]/g, ''));
// A bridge replaces its code after any pairing attempt that fails, so a code someone captured can't be cracked in time.
const WRONG_CODE = 'That code does not match. The bridge has made a new one: ask your coding agent for its pairing code.';

function open(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { ws.close(); reject(fail('timeout', 'No bridge answered.')); }, 2000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(fail('closed', 'No bridge on this port.')); };
  });
}

// Mutual proof: each side shows it holds the key without sending it.
function handshake(ws, mode, key) {
  return new Promise((resolve, reject) => {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const timer = setTimeout(() => { ws.close(); reject(fail('timeout', 'The bridge did not finish connecting.')); }, 10000);
    ws.onmessage = async event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'challenge') {
        if (message.proof !== await hmac(key, `bridge|${nonce}|${message.nonce}`)) {
          clearTimeout(timer); ws.close();
          reject(Object.assign(fail('wrong_bridge', WRONG_CODE), { bridgeId: message.bridge_id })); return;
        }
        ws.send(JSON.stringify({ type: 'proof', proof: await hmac(key, `ext|${message.nonce}|${nonce}`) }));
        view.agent = message.agent || 'Coding agent';
      } else if (message.type === 'paired' || message.type === 'ready') {
        clearTimeout(timer); resolve(message);
      } else if (message.type === 'error') {
        clearTimeout(timer); ws.close();
        reject(fail(message.code, { bad_proof: WRONG_CODE, locked: 'Too many wrong codes. Wait a minute, then ask your coding agent for its new pairing code.',
          not_paired: 'The bridge was reset. Pair again with the code it printed.' }[message.code] || 'The bridge refused the connection.'));
      }
    };
    ws.onclose = () => { clearTimeout(timer); reject(fail('closed', 'The bridge closed the connection.')); };
    ws.send(JSON.stringify({ type: 'hello', nonce, mode, client: `QA Ninja extension ${chrome.runtime.getManifest().version}` }));
  });
}

function attach(ws) {
  socket = ws; approved = false;
  ws.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
    if (message.type === 'request') respond(message);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null; approved = false;
    for (const resolve of approvalWaiters.splice(0)) resolve(false);
    publish({ status: 'disconnected' });
  };
  publish({ status: 'connected', error: '' });
}

export async function pair(code) {
  if (!/^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/.test(String(code).trim())) throw fail('bad_code', 'Enter the 8-character code the bridge printed, like ABCD-1234.');
  disconnect();
  publish({ status: 'connecting', error: '' });
  let last = fail('not_found', 'No QA Ninja bridge is running. Start it from your coding agent (npx -y @qaninja/mcp).');
  for (const port of PORTS) {
    let ws;
    try { ws = await open(port); } catch { continue; }
    try {
      const result = await handshake(ws, 'pair', codeKey(code.trim()));
      await NinjaStore.put('settings', { secret: result.secret, bridgeId: result.bridge_id, port, pairedAt: Date.now() }, SETTINGS_KEY);
      chrome.alarms.create('qaninja-bridge', { periodInMinutes: 1 });
      attach(ws); publish({ paired: true });
      return bridgeView();
    } catch (error) { last = error; if (error.code === 'locked') break; }
  }
  publish({ status: 'disconnected', error: last.message });
  throw last;
}

export async function connect() {
  if (socket) return bridgeView();
  if (connecting) return connecting;
  connecting = (async () => {
    const saved = await NinjaStore.get('settings', SETTINGS_KEY);
    publish({ paired: !!saved });
    if (!saved) return bridgeView();
    for (const port of [saved.port, ...PORTS.filter(item => item !== saved.port)]) {
      let ws;
      try { ws = await open(port); } catch { continue; }
      try {
        const result = await handshake(ws, 'resume', unhex(saved.secret));
        if (result.bridge_id && result.bridge_id !== saved.bridgeId) { ws.close(); continue; }
        attach(ws);
        if (port !== saved.port) await NinjaStore.put('settings', { ...saved, port }, SETTINGS_KEY);
        return bridgeView();
      } catch (error) {
        // Another bridge on this port is skipped; our own bridge no longer knowing this pairing means it was reset or paired elsewhere.
        if (error.code === 'not_paired' || error.code === 'bad_proof' || (error.code === 'wrong_bridge' && error.bridgeId === saved.bridgeId)) {
          await NinjaStore.put('settings', null, SETTINGS_KEY); chrome.alarms.clear('qaninja-bridge');
          publish({ paired: false, error: error.message }); break;
        }
      }
    }
    publish({ status: 'disconnected' });
    return bridgeView();
  })().finally(() => { connecting = null; });
  return connecting;
}

export function disconnect(forget = false) {
  const ws = socket; socket = null; approved = false;
  ws?.close();
  for (const resolve of approvalWaiters.splice(0)) resolve(false);
  if (forget) { chrome.alarms.clear('qaninja-bridge'); NinjaStore.put('settings', null, SETTINGS_KEY).then(() => publish({ paired: false })); }
  publish({ status: 'disconnected' });
  return bridgeView();
}

export function approve(allow) {
  approved = !!allow;
  for (const resolve of approvalWaiters.splice(0)) resolve(approved);
  publish({});
  return bridgeView();
}

async function requireApproval() {
  if (approved) return;
  if (!deps.panelOpen()) throw fail('approval_required', `Open the QA Ninja side panel in Chrome (Execute tab) to allow ${view.agent || 'your coding agent'} to run tests in this browser.`);
  const allowed = await new Promise(resolve => {
    approvalWaiters.push(resolve);
    publish({});
    setTimeout(() => { const index = approvalWaiters.indexOf(resolve); if (index >= 0) { approvalWaiters.splice(index, 1); publish({}); resolve(false); } }, APPROVAL_TIMEOUT);
  });
  if (!allowed) throw fail('denied', 'The person at the browser did not allow this session.');
}

// The run asks the coding agent to decide: this resolves the agent's waiting request with where things stand.
const external = {
  episode(start, observation, run) {
    return new Promise(resolve => {
      pending = { start, resolve, runId: run.id };
      const step = start.step_index != null ? run.spec.steps[start.step_index] : null;
      reach({ run_id: run.id, status: 'needs_agent',
        needs: { kind: start.kind, ...(step && { step_index: start.step_index, step: { index: step.index, label: step.label, action_type: step.action_type,
          description: describe(step) } }), ...(start.reason && { reason: start.reason }) },
        snapshot: observation.snapshot, url: observation.url, title: observation.title });
    });
  },
};
function describe(step) {
  const label = step.label || 'element';
  return { fill: `type into "${label}"`, select: `choose "${step.value}" in "${label}"`, check: `check "${label}"`, uncheck: `uncheck "${label}"`,
    press: `press ${step.key || 'Enter'}`, navigate: `go to ${step.url}` }[step.action_type] || `click "${label}"`;
}
function reach(state) {
  lastState = { ...state, seq: ++stateSeq };
  for (const resolve of waiters.splice(0)) resolve(lastState);
}
// A request answers within answerWithin: a run still replaying by then says so, and the agent calls wait
// (qaninja_wait_run) for the next decision point.
function answer(promise, runId) {
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), answerWithin); });
  return Promise.race([promise, late]).then(state => {
    clearTimeout(timer);
    if (!state) return { run_id: runId || externalRun()?.id || lastState?.run_id || null, status: 'running', seq: stateSeq };
    deliveredSeq = Math.max(deliveredSeq, state.seq);
    return state;
  });
}
const externalRun = () => { const run = deps.activeRun(); return run?.external ? run : null; };
function nextCheckpoint() { return new Promise(resolve => waiters.push(resolve)); }
export function runFinished(run, summary) {
  if (!run?.external) return;
  pending = null;
  reach({ run_id: run.id, status: 'finished', verdict: summary?.verdict || run.verdict || null, summary: summary?.summary || run.message || '',
    dashboard_url: `${CONFIG.APP_BASE_URL}/execute/runs/${run.id}` });
}

function activeRun() {
  const run = deps.activeRun();
  if (!run?.external) throw fail('no_run', 'No coding-agent run is open. Start one with qaninja_run_test or browser_open.');
  if (!run.page) throw fail('not_ready', 'The test window is still opening. Try again in a moment.');
  return run;
}

const METHODS = {
  async status() {
    const run = deps.activeRun();
    return { signed_in: !!authState.signedIn, account: authState.subject || null, approved,
      active_run: run ? { id: run.id, name: run.summary.name, status: run.done ? 'finished' : 'running' } : null };
  },
  async list_tests() {
    return (await api('/execute/tests')).map(test => ({ id: test.id, name: test.name, steps: test.steps, last_run: test.last_run }));
  },
  async get_test({ test_id }) { return api(`/execute/tests/${Number(test_id)}`); },
  async get_run({ run_id }) {
    if (!/^run_[0-9a-f]{32}$/.test(run_id || '')) throw fail('bad_request', 'run_id looks like run_ followed by 32 hex characters.');
    const run = await api(`/execute/runs/${run_id}`);
    const failing = run.steps.find(step => ['failed', 'blocked'].includes(step.status)) || null;
    return { run: { id: run.id, name: run.name, status: run.status, verdict: run.verdict, blocked_reason: run.blocked_reason, summary: run.summary,
      steps_passed: run.steps_passed, steps_total: run.steps_total, healed_steps: run.healed_steps }, failing_step: failing,
      errors: run.events.filter(event => event.level === 'error').slice(0, 10).map(event => ({ kind: event.kind, message: event.message, step_index: event.step_index })),
      dashboard_url: `${CONFIG.APP_BASE_URL}/execute/runs/${run.id}` };
  },
  async run_test({ test_id, mode = 'assisted', base_url, inputs }) {
    await requireApproval();
    const wait = nextCheckpoint();
    const run = await deps.start({ source: 'bridge', workflowId: Number(test_id), mode: mode === 'replay' ? 'replay' : 'assisted', baseUrl: base_url || null,
      inputs: inputs || null, external });
    return answer(wait, run?.id);
  },
  async open({ url, allowed_origins = [], goal = '' }) {
    await requireApproval();
    const wait = nextCheckpoint();
    const run = await deps.start({ source: 'bridge', adhoc: { start_url: url, allowed_origins, goal, name: 'Coding agent session' }, mode: 'agent', external });
    return answer(wait, run?.id);
  },
  // The newest decision point the agent hasn't seen, or the next one within 45 seconds.
  async wait() {
    if (lastState && lastState.seq > deliveredSeq) { deliveredSeq = lastState.seq; return lastState; }
    if (externalRun()) return answer(nextCheckpoint());
    if (lastState) return lastState;
    throw fail('no_run', 'No coding-agent run is open. Start one with qaninja_run_test or browser_open.');
  },
  async snapshot({ filter = null, ref = null }) {
    const run = activeRun();
    const info = await run.page.info();
    return { text: await run.page.readPage({ filter, ref }), url: run.redact(info.url), title: run.redact(info.title) };
  },
  async act({ action, input = {} }) {
    const run = activeRun();
    if (action === 'screenshot') return METHODS.screenshot();
    const result = await run.act({ name: String(action), input }).catch(error => ({ ok: false, text: `Error: ${error.message}` }));
    const info = await run.page.info();
    return { ok: result.ok, text: run.redact(result.text || ''), url: run.redact(info.url), title: run.redact(info.title) };
  },
  async screenshot() {
    const run = activeRun();
    const bytes = await run.page.screenshot();
    run.upload(bytes, `agent-${Date.now()}.jpg`, run.currentStep).catch(() => {});
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    const info = await run.page.info();
    return { image: btoa(binary), url: run.redact(info.url), title: run.redact(info.title) };
  },
  async console() { return { text: activeRun().page.consoleText() }; },
  async network() { return { text: activeRun().page.networkText() }; },
  async step_done({ step_index, ref = null, summary = '' }) {
    if (!pending) throw fail('no_pending_step', 'Nothing is waiting for a step. Check the last result of qaninja_run_test.');
    if (['recover', 'data'].includes(pending.start.kind) && Number(step_index) !== pending.start.step_index) {
      throw fail('wrong_step', `Report step_index ${pending.start.step_index}, the step that needs fixing.`);
    }
    if (!['recover', 'data'].includes(pending.start.kind)) throw fail('wrong_call', 'This run is waiting for a verdict. Call qaninja_finish_run.');
    const { resolve } = pending; pending = null;
    const wait = nextCheckpoint();
    resolve({ step_done: { step_index: Number(step_index), ref, summary: String(summary).slice(0, 500) } });
    return answer(wait);
  },
  async finish({ verdict, reason = '', blocked_reason = null }) {
    if (!['PASSED', 'FAILED', 'BLOCKED'].includes(verdict)) throw fail('bad_request', 'verdict is PASSED, FAILED or BLOCKED.');
    if (!pending) {
      if (lastState?.status === 'finished') return lastState;
      throw fail('no_pending_step', 'This run is not waiting for a verdict.');
    }
    if (verdict === 'PASSED' && ['recover', 'data'].includes(pending.start.kind)) throw fail('wrong_call', 'Fix the step and call qaninja_step_done; a run passes only once every step has run.');
    const { resolve } = pending; pending = null;
    const wait = nextCheckpoint();
    resolve({ verdict: { status: verdict, reason: String(reason).slice(0, 1000), blocked_reason: verdict === 'BLOCKED' ? (blocked_reason || 'other') : null } });
    return answer(wait);
  },
};

async function respond(message) {
  const reply = body => socket?.send(JSON.stringify({ type: 'response', id: message.id, ...body }));
  try {
    const method = METHODS[message.method];
    if (!method) throw fail('unknown_method', `Unknown method ${message.method}.`);
    if (!authState.signedIn && !['status'].includes(message.method)) throw fail('not_signed_in', 'Sign in to the QA Ninja extension in Chrome first.');
    reply({ result: await method(message.params || {}) });
  } catch (error) {
    reply({ error: { code: error.code || 'failed', message: error.message || 'The request failed.' } });
  }
}

export async function keepTrying() {
  const saved = await NinjaStore.get('settings', SETTINGS_KEY).catch(() => null);
  if (saved && !socket) await connect().catch(() => {});
  await sleep(0);
}
