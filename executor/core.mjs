// One test run: replay recorded steps with trusted input, ask the agent only when a step no longer replays, a value is
// missing, or the outcome needs judging, and report everything as evidence. Stop, take over and resume at any time.
import { RunPage } from './page.mjs';
import { redactor } from './secrets.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HALT = 'Not executed: an earlier action in this turn failed.';
const TOOK_OVER = 'Not executed: the person running the test took over the browser. Re-read the page; it may have changed.';
const AGENT_BRAINS = new Set(['managed', 'byok', 'oauth']);
const SNAPSHOT_LIMIT = 24000;
const stopped = () => Object.assign(new Error('The run was stopped.'), { code: 'cancelled' });

export class Run {
  constructor({ summary, spec, api, ui, secrets, interactive, closeWindow, external = null }) {
    // external: a coding agent connected through the MCP bridge decides instead of QA Ninja's API.
    Object.assign(this, { summary, spec, api, ui, interactive, closeWindow, external });
    this.id = summary.id;
    this.secrets = secrets; // Map name -> value, for this run only
    this.redact = redactor(secrets);
    this.page = null; this.turnSeq = 0; this.eventSeq = 0; this.events = []; this.currentStep = null;
    this.cancelled = false; this.cancelReason = ''; this.paused = false; this.resumeWaiters = [];
    this.phase = 'starting'; this.message = ''; this.verdict = null; this.done = false; this.error = '';
    this.steps = spec.steps.map(step => ({ index: step.index, label: step.label || step.action_type, status: 'pending' }));
    this.agentStep = spec.steps.length; this.lastAgentStep = null; this.screenshots = 0;
    this.abort = new AbortController();
  }

  view() {
    return { id: this.id, name: this.summary.name, mode: this.spec.mode, brain: this.spec.brain, phase: this.phase,
      paused: this.paused, current: this.currentStep, steps: this.steps, message: this.message, verdict: this.verdict,
      done: this.done, error: this.error, startedAt: this.startedAt };
  }
  update(changes = {}) { Object.assign(this, changes); this.ui.update(this.view()); }

  stop(reason = 'Stopped by the person running the test.') {
    this.cancelled = true; this.cancelReason = reason; this.abort.abort();
    for (const resolve of this.resumeWaiters.splice(0)) resolve();
  }
  takeover() { this.update({ paused: true, message: 'You have control. Resume when you are done.' }); }
  resume() { this.update({ paused: false, message: '' }); for (const resolve of this.resumeWaiters.splice(0)) resolve(); }
  async gate() {
    if (this.cancelled) throw stopped();
    if (this.paused) {
      this.heartbeatPhase = 'paused';
      await new Promise(resolve => this.resumeWaiters.push(resolve));
      this.heartbeatPhase = null;
      if (this.cancelled) throw stopped();
    }
  }

  event(item) {
    this.events.push({ client_seq: ++this.eventSeq, step_index: this.currentStep, level: 'info', data: {}, at: Math.floor(Date.now() / 1000),
      ...item, message: this.redact(String(item.message || '')).slice(0, 2000) });
    if (this.events.length >= 50) this.flushEvents();
  }
  async flushEvents() {
    while (this.events.length) {
      const batch = this.events.splice(0, 100);
      await this.api.events(this.id, batch).catch(() => {});
    }
  }

  async upload(bytes, filename, stepIndex, kind = 'screenshot', type = 'image/jpeg') {
    try { return (await this.api.artifact(this.id, { kind, filename, stepIndex, bytes, type })).id; }
    catch (error) { this.event({ kind: 'system', level: 'warning', message: `Evidence not saved: ${error.message}` }); return null; }
  }
  async capture(name, stepIndex) {
    try { return await this.upload(await this.page.screenshot(), `${name}.jpg`, stepIndex); } catch { return null; }
  }

  async reportStep(index, status, extra = {}) {
    const step = this.spec.steps[index];
    const label = extra.label || step?.label || '';
    const entry = this.steps.find(item => item.index === index);
    if (entry) Object.assign(entry, { status, label: label || entry.label });
    else this.steps.push({ index, label, status });
    this.ui.update(this.view());
    const body = { step_index: index, recorded_step_id: step?.id ?? null, label: this.redact(label).slice(0, 200),
      action_type: extra.action_type || step?.action_type || 'click', status, resolution: extra.resolution || 'replay',
      locator_used: extra.strategy || '', locator: extra.locator || null, action: extra.action || null,
      url: this.redact((await this.page?.info().catch(() => ({})))?.url || '').slice(0, 4000),
      error_code: extra.error_code || null, error_message: extra.error_message ? this.redact(extra.error_message).slice(0, 1000) : null,
      screenshot_artifact_id: extra.screenshot || null, duration_ms: Math.min(extra.duration || 0, 3600000) };
    await this.api.steps(this.id, [body]).catch(error => this.event({ kind: 'system', level: 'warning', message: `Step result not saved: ${error.message}` }));
  }

  heartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      try {
        const result = await this.api.heartbeat(this.id, { step_index: this.currentStep, phase: this.heartbeatPhase || this.phaseName() });
        if (result.cancel_requested && !this.cancelled) this.stop('Cancelled from the dashboard.');
      } catch {}
      this.flushEvents();
    }, 15000);
  }
  phaseName() {
    return { replaying: 'replaying', recovering: 'recovering', verifying: 'verifying', agent: 'agent' }[this.phase] || '';
  }

  async start() {
    this.startedAt = Date.now();
    this.update({ phase: 'opening' });
    this.heartbeat();
    let status = 'completed', verdict = null, error = '';
    try {
      this.page = await RunPage.open({ startUrl: this.spec.start_url, viewport: this.spec.viewport, allowedOrigins: this.spec.allowed_origins,
        onEvent: item => this.event(item), redact: this.redact,
        onDetach: reason => { if (!this.done) this.stop(reason === 'canceled_by_user' ? 'Debugging was cancelled in Chrome.' : 'The test window was closed.'); } });
      await this.page.running(true);
      verdict = await this.execute();
    } catch (problem) {
      if (problem.code === 'cancelled' || this.cancelled) { status = 'cancelled'; error = this.cancelReason; }
      else if (problem.verdict) verdict = problem.verdict;
      else { status = 'error'; error = this.redact(problem.message || 'The run stopped unexpectedly.'); }
    }
    clearInterval(this.heartbeatTimer);
    await this.flushEvents();
    const failing = this.steps.find(step => ['failed', 'blocked'].includes(step.status))?.index ?? null;
    const body = { status, ...(verdict && { verdict: verdict.status, summary: this.redact(verdict.reason || '').slice(0, 2000),
      blocked_reason: verdict.blocked_reason || null }), failing_step: failing, error: error.slice(0, 500) };
    if (status === 'completed' && !verdict) Object.assign(body, { status: 'error', error: 'No verdict was reached.' });
    let summary = null;
    for (let attempt = 0; attempt < 3 && !summary; attempt++) {
      summary = await this.api.finish(this.id, body).catch(() => null);
      if (!summary) await sleep(2000);
    }
    this.update({ done: true, phase: 'done', verdict: summary?.verdict || verdict?.status || null, error: summary?.error || error,
      message: summary?.summary || verdict?.reason || error });
    await this.page?.close({ closeWindow: this.closeWindow }).catch(() => {});
    return summary;
  }

  agentAvailable() { return AGENT_BRAINS.has(this.spec.brain) || (this.spec.brain === 'mcp' && !!this.external); }

  async execute() {
    const { spec } = this;
    if (spec.mode !== 'agent' || spec.replaying_trace) {
      this.update({ phase: 'replaying' });
      for (const step of spec.steps) {
        await this.gate();
        this.currentStep = step.index;
        const entry = this.steps.find(item => item.index === step.index);
        if (entry) entry.status = 'running';
        this.update({ message: '' });
        const started = Date.now();
        const outcome = await this.replay(step).catch(error => ({ ok: false, error_code: error.code || 'action_failed', error_message: error.message }));
        if (outcome.ok) {
          const shot = await this.capture(`step-${step.index}`, step.index);
          await this.reportStep(step.index, 'passed', { ...outcome, screenshot: shot, duration: Date.now() - started });
          continue;
        }
        if (this.cancelled) throw stopped();
        const blocked = ['missing_secret', 'navigation_blocked', 'file_upload_required', 'frame_unreachable'].includes(outcome.error_code);
        if (!this.agentAvailable() || spec.mode === 'replay' || outcome.error_code === 'missing_secret') {
          const shot = await this.capture(`step-${step.index}`, step.index);
          await this.reportStep(step.index, blocked ? 'blocked' : 'failed', { ...outcome, screenshot: shot, duration: Date.now() - started });
          return { status: blocked ? 'BLOCKED' : 'FAILED', blocked_reason: blocked ? outcome.error_code : null,
            reason: `Step ${step.index + 1} (${step.label || step.action_type}) could not be replayed: ${outcome.error_message || outcome.error_code}.` };
        }
        const kind = outcome.error_code === 'missing_input' ? 'data' : 'recover';
        const result = await this.episode({ kind, step_index: step.index, reason: outcome.error_code });
        const shot = await this.capture(`step-${step.index}`, step.index);
        if (result.verdict) {
          const status = result.verdict.status === 'BLOCKED' ? 'blocked' : 'failed';
          await this.reportStep(step.index, status, { ...outcome, resolution: 'agent', screenshot: shot, duration: Date.now() - started,
            error_message: result.verdict.reason });
          return result.verdict;
        }
        const bundle = result.step_done.ref ? await this.page.bundle(result.step_done.ref).catch(() => null) : null;
        await this.reportStep(step.index, 'healed', { resolution: 'agent', strategy: 'agent', locator: bundle, screenshot: shot,
          duration: Date.now() - started, error_code: outcome.error_code, error_message: result.step_done.summary });
      }
    }
    this.currentStep = null;
    if (spec.mode === 'agent' && !spec.replaying_trace) {
      if (!this.agentAvailable()) return { status: 'BLOCKED', blocked_reason: 'other', reason: 'Agent mode needs an agent.' };
      const result = await this.episode({ kind: 'agent' });
      return result.verdict || { status: 'BLOCKED', blocked_reason: 'other', reason: 'The agent did not give a verdict.' };
    }
    const failed = [];
    for (const assertion of spec.assertions || []) {
      const ok = await this.page.check(assertion).catch(() => false);
      this.event({ kind: 'system', level: ok ? 'info' : 'error', message: `Check ${assertion.type} "${assertion.value}": ${ok ? 'passed' : 'failed'}` });
      if (!ok) failed.push(assertion);
    }
    if (failed.length) {
      return { status: 'FAILED', reason: `Check failed: ${failed.map(item => `${item.type.replace('_', ' ')} "${item.value}"`).join('; ')}.` };
    }
    if (this.agentAvailable() && spec.expected_outcome) {
      const result = await this.episode({ kind: 'verify' });
      return result.verdict || { status: 'BLOCKED', blocked_reason: 'other', reason: 'The agent did not judge the outcome.' };
    }
    const healed = this.steps.filter(step => step.status === 'healed').length;
    return { status: 'PASSED', reason: `All ${spec.steps.length} steps replayed${healed ? `; the agent fixed ${healed}` : ''}.` };
  }

  value(step) {
    if (step.value_ref?.kind === 'secret') return { secret: true, value: this.secrets.get(step.value_ref.name) ?? null, name: step.value_ref.name };
    if (step.value_ref?.kind === 'input') return { value: this.spec.inputs?.[step.value_ref.name] ?? null, name: step.value_ref.name };
    return { value: step.value };
  }

  async replay(step) {
    const page = this.page;
    if (step.action_type === 'navigate') { await page.goto(step.url); return { ok: true, strategy: 'navigate' }; }
    if (step.action_type === 'press') { await page.key(step.key || 'Enter'); return { ok: true, strategy: 'keyboard' }; }
    const needed = ['fill', 'select'].includes(step.action_type) ? this.value(step) : null;
    if (needed && needed.value == null) {
      return needed.secret ? { ok: false, error_code: 'missing_secret', error_message: `No value was given for the secret "${needed.name}"` }
        : { ok: false, error_code: 'missing_input', error_message: `No value for "${needed.name || step.label}"` };
    }
    if (page.blockedReason) return { ok: false, error_code: page.blockedReason, error_message: 'The page needs a file upload' };
    // Pages render asynchronously: keep looking for a while before calling a step broken.
    let found, deadline = Date.now() + 8000;
    for (;;) {
      await this.gate();
      found = await page.locate(step);
      if (found.status === 'found' || Date.now() > deadline) break;
      await sleep(400);
    }
    if (found.status !== 'found') {
      return { ok: false, error_code: found.status === 'ambiguous' ? 'locator_ambiguous' : 'locator_not_found',
        error_message: found.status === 'ambiguous' ? `${found.count} elements matched` : 'The element was not found' };
    }
    const target = { type: 'ref', ref: found.ref };
    try {
      if (step.action_type === 'click') await page.click(target);
      else if (step.action_type === 'fill') await page.fill(found.ref, needed.value, { secret: !!needed.secret });
      else if (step.action_type === 'select') await page.formInput(found.ref, needed.value);
      else if (['check', 'uncheck'].includes(step.action_type)) {
        if (await page.checked(found.ref) !== (step.action_type === 'check')) await page.click(target);
      }
    } catch (error) {
      return { ok: false, error_code: error.code === 'obscured' ? 'obscured' : error.code || 'action_failed', error_message: error.message };
    }
    return { ok: true, strategy: found.strategy, locator: step.override || step.locators || null };
  }

  async observe(withScreenshot = true) {
    const info = await this.page.info();
    let snapshot = '';
    try { snapshot = await this.page.readPage({}); } catch (error) { snapshot = `(could not read the page: ${error.message})`; }
    if (snapshot.length > SNAPSHOT_LIMIT) snapshot = snapshot.slice(0, SNAPSHOT_LIMIT) + '\n- (truncated; use read_page with a ref or find to see more)';
    const screenshot = withScreenshot ? await this.capture(`observe-${++this.screenshots}`, this.currentStep) : null;
    return { url: this.redact(info.url), title: this.redact(info.title), snapshot, screenshot_artifact_id: screenshot };
  }

  // One agent task, driven by the API until the model reports the step done or gives a verdict.
  async episode(start) {
    const kind = start.kind;
    this.update({ phase: kind === 'verify' ? 'verifying' : kind === 'agent' ? 'agent' : 'recovering',
      message: kind === 'verify' ? 'The agent is checking the outcome.' : kind === 'agent' ? 'The agent is running the test.' : `The agent is fixing step ${start.step_index + 1}.` });
    this.episodeKind = kind;
    if (this.external) {
      this.update({ message: 'Waiting for your coding agent.' });
      // Stop ends the wait, and an agent that never answers can't hold the browser past the run's time limit.
      let timer, onAbort;
      const left = this.startedAt + (this.spec.budgets?.max_seconds || 1800) * 1000 - Date.now();
      const decision = await Promise.race([
        this.external.episode(start, await this.observe(false), this),
        new Promise(resolve => { onAbort = resolve; this.abort.signal.addEventListener('abort', onAbort); if (this.abort.signal.aborted) resolve(); }),
        new Promise(resolve => { timer = setTimeout(() => resolve({ verdict: { status: 'BLOCKED', blocked_reason: 'budget_exhausted',
          reason: 'Your coding agent did not answer before the run reached its time limit.' } }), Math.max(0, left)); }),
      ]).finally(() => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', onAbort); });
      if (this.cancelled) throw stopped();
      return decision;
    }
    let response = await this.api.turn(this.id, { turn_seq: this.turnSeq++, episode: start, observation: await this.observe(), results: [] },
      { signal: this.abort.signal });
    const episodeId = response.episode_id;
    for (;;) {
      if (response.cancel_requested && !this.cancelled) this.stop('Cancelled from the dashboard.');
      if (this.cancelled) throw stopped();
      if (response.message) this.update({ message: this.redact(response.message).slice(0, 300) });
      if (response.status === 'step_done') return { step_done: response.step_done };
      if (response.status === 'verdict') return { verdict: response.verdict };
      const results = [];
      let halted = false;
      for (const action of response.actions || []) {
        if (halted) { results.push({ tool_use_id: action.tool_use_id, ok: false, text: HALT }); continue; }
        if (this.paused) {
          await this.gate();
          results.push({ tool_use_id: action.tool_use_id, ok: false, text: TOOK_OVER }); halted = true; continue;
        }
        const result = await this.act(action).catch(error => ({ ok: false, text: `Error: ${this.redact(error.message)}` }));
        results.push({ tool_use_id: action.tool_use_id, ok: result.ok, text: this.redact(result.text || '').slice(0, 60000),
          images: result.images || [], ...(result.browser_state && { browser_state: result.browser_state }) });
        if (!result.ok) halted = true;
        if (this.cancelled) throw stopped();
      }
      response = await this.api.turn(this.id, { turn_seq: this.turnSeq++, episode_id: episodeId, results }, { signal: this.abort.signal });
    }
  }

  // Agent-mode actions become steps, so a passing agent run can be saved as the test's replay path.
  async trace(action, element, extra) {
    if (this.episodeKind !== 'agent') return;
    const index = extra.reuse ?? this.agentStep++;
    this.lastAgentStep = { index, element, action_type: extra.action_type };
    await this.reportStep(index, 'passed', { resolution: 'agent', label: element?.name || element?.text || extra.label || action.name,
      action_type: extra.action_type, locator: element || null, action: extra.action || null, strategy: 'agent' });
  }

  async act(action) {
    const page = this.page, input = action.input || {};
    const ok = text => ({ ok: true, text });
    const target = input.target;
    const element = async () => target?.type === 'ref' ? await page.bundle(target.ref).catch(() => null) : null;
    switch (action.name) {
      case 'navigate': {
        if (['back', 'forward', 'reload'].includes(input.url)) await page.history(input.url);
        else {
          await page.goto(input.url);
          await this.trace(action, null, { action_type: 'navigate', label: input.url });
        }
        const state = await page.browserState();
        return { ok: true, text: `Navigated to ${state.tabs[0].url}.`, browser_state: state };
      }
      case 'screenshot': {
        const id = await this.capture(`agent-${++this.screenshots}`, this.currentStep);
        return id ? { ok: true, text: '', images: [id] } : { ok: false, text: 'Error: the screenshot could not be taken.' };
      }
      case 'zoom': {
        const [x0, y0, x1, y1] = input.region || [];
        const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
        const bytes = await page.screenshot({ x: x0, y: y0, width, height, scale: Math.min(2, 1280 / width) });
        const id = await this.upload(bytes, `zoom-${++this.screenshots}.jpg`, this.currentStep);
        return id ? { ok: true, text: '', images: [id] } : { ok: false, text: 'Error: the zoomed image could not be saved.' };
      }
      case 'left_click': case 'right_click': case 'double_click': case 'triple_click': {
        const bundle = await element();
        const point = await page.click(target, { button: action.name === 'right_click' ? 'right' : 'left',
          clickCount: { double_click: 2, triple_click: 3 }[action.name] || 1, modifiers: input.modifiers || input.text || '' });
        if (action.name === 'left_click' && bundle) await this.trace(action, bundle, { action_type: 'click' });
        if (this.lastAgentStep) this.lastAgentStep.editable = !!point?.info?.editable;
        return ok(`Clicked ${target.type === 'ref' ? 'element ' + target.ref : `at (${target.x}, ${target.y})`}.`);
      }
      case 'hover': await page.hover(target); return ok('Hovering.');
      case 'left_click_drag': {
        await page.drag(input.from, target);
        return ok('Dragged.');
      }
      case 'left_mouse_down': case 'left_mouse_up': case 'mouse_move': await page.pointer(action.name, target); return ok('Done.');
      case 'scroll': await page.scroll(target, input.scroll_direction, input.scroll_amount); return ok(`Scrolled ${input.scroll_direction}.`);
      case 'scroll_to': await page.scrollTo(target.ref); return ok(`Scrolled ${target.ref} into view.`);
      case 'read_page': return ok(await page.readPage({ filter: input.filter || null, depth: input.depth || 15, ref: input.ref || null }));
      case 'find': return ok(await page.find(input.query));
      case 'get_page_text': return ok(await page.pageText());
      case 'read_console': return ok(page.consoleText());
      case 'read_network': return ok(page.networkText());
      case 'form_input': {
        const bundle = await element();
        const text = await page.formInput(target.ref, input.value);
        const kind = typeof input.value === 'boolean' ? (input.value ? 'check' : 'uncheck') : bundle?.tag === 'select' ? 'select' : 'fill';
        await this.trace(action, bundle, { action_type: kind, action: typeof input.value === 'boolean' ? null : { value: String(input.value) } });
        return ok(text);
      }
      case 'type': {
        await page.type(String(input.text));
        const last = this.lastAgentStep;
        if (this.episodeKind === 'agent' && last?.editable && last.action_type === 'click') {
          await this.trace(action, last.element, { reuse: last.index, action_type: 'fill', action: { value: String(input.text) } });
        }
        return ok(`Typed ${String(input.text).length} characters.`);
      }
      case 'key': {
        await page.key(input.text, input.repeat || 1);
        if (/^[A-Za-z]+$/.test(input.text)) await this.trace(action, null, { action_type: 'press', label: input.text, action: { key: input.text } });
        return ok(`Pressed ${input.text}.`);
      }
      case 'wait': await sleep(Math.min(Number(input.duration) || 1, 10) * 1000); await page.settle(3000); return ok('Waited.');
      case 'type_secret': {
        const value = this.secrets.get(input.secret_name);
        if (value == null) return { ok: false, text: `Error: no value was given for the secret "${input.secret_name}". Finish with verdict BLOCKED (missing_secret).` };
        const bundle = await element();
        await page.fill(target.ref, value, { secret: true });
        if (input.submit) await page.key('Enter');
        await this.trace(action, bundle, { action_type: 'fill', action: { value_ref: { kind: 'secret', name: input.secret_name } } });
        return ok(`Typed the secret "${input.secret_name}" into ${target.ref}.`);
      }
      case 'request_input': {
        if (!this.interactive) return { ok: false, text: 'Error: nobody is watching this run to answer. Finish with verdict BLOCKED (missing_input).' };
        const answer = await this.ui.ask({ runId: this.id, name: input.name, label: input.label, reason: input.reason });
        if (answer == null) return { ok: false, text: 'Error: the person running the test did not provide a value. Finish with verdict BLOCKED (missing_input).' };
        return ok(`Value for "${input.name}": ${answer}`);
      }
      default:
        return { ok: false, text: `Error: ${action.name} is not available in this browser.` };
    }
  }
}
