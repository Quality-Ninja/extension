// Recording v2: typed values are captured except anything secret, and exports never write a secret into a file.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');
const SECRETS = ['hunter2!', '123456', '4242 4242 4242 4242'];

async function recorder(page, captureTyping = true) {
  await page.goto('http://127.0.0.1:8765/form');
  await page.evaluate(captureTyping => {
    window.messages = []; window.listeners = [];
    window.chrome = { runtime: {
      sendMessage: async msg => { window.messages.push(msg); return msg.type === 'RECORD_CONTEXT' ? { recordingId: 'r1', captureTyping } : { ok: true }; },
      onMessage: { addListener: fn => window.listeners.push(fn) } } };
  }, captureTyping);
  for (const file of ['xpath.js', 'dom.js', 'content.js']) await page.addScriptTag({ path: path.resolve(__dirname, '..', file) });
  await expect.poll(() => page.locator('[data-qaninja-ui="recording"]').count()).toBe(1);
}
const steps = page => page.evaluate(() => window.messages.filter(msg => msg.type === 'RECORD_STEP').map(msg => msg.step));

test('typed values are captured, but never passwords, codes or secret-looking values', async ({ page }) => {
  await recorder(page);
  await page.locator('#email').fill('qa@example.com');
  await page.locator('#password').fill(SECRETS[0]);
  await page.locator('#otp').fill(SECRETS[1]);
  await page.locator('#note').fill(SECRETS[2]);
  await page.locator('#country').selectOption('Spain');
  await page.locator('#terms').check();
  await page.locator('#email').click();
  await page.locator('#email').press('Enter');
  await expect.poll(async () => (await steps(page)).length).toBeGreaterThanOrEqual(8);
  const recorded = await steps(page);
  const fills = recorded.filter(step => step.action_type === 'fill');
  expect(fills.map(step => [step.label, step.value, !!step.sensitive])).toEqual([
    ['Email', 'qa@example.com', false], ['Password', '', true], ['Code', '', true], ['Note', '', true]]);
  expect(recorded.find(step => step.action_type === 'select')).toMatchObject({ label: 'Country', value: 'Spain' });
  expect(recorded.find(step => step.action_type === 'check')).toMatchObject({ label: 'I agree' });
  expect(recorded.find(step => step.action_type === 'press')).toMatchObject({ key: 'Enter' });
  // The checkbox's own click is not a separate step, and every step fingerprints its element.
  expect(recorded.filter(step => step.action_type === 'click').map(step => step.label)).toEqual(['Email']);
  expect(fills[0].locators).toMatchObject({ role: 'textbox', name: 'Email', attributes: { id: 'email', name: 'email' } });
  const everything = JSON.stringify(await page.evaluate(() => window.messages));
  for (const secret of SECRETS) expect(everything).not.toContain(secret);
});

test('with typed-text capture off, fields are recorded without their values', async ({ page }) => {
  await recorder(page, false);
  await expect(page.locator('[data-qaninja-ui="recording"]')).toHaveCount(1);
  await page.locator('#email').fill('qa@example.com');
  await page.locator('#note').click();
  await expect.poll(async () => (await steps(page)).some(step => step.action_type === 'fill')).toBe(true);
  const fill = (await steps(page)).find(step => step.action_type === 'fill');
  expect(fill).toMatchObject({ label: 'Email', value: '', typed_hidden: true });
});

test('v2 exports name secrets and read them from the environment in every script', async ({ page }) => {
  await page.goto('http://127.0.0.1:8765/fixture');
  await page.evaluate(async () => { window.exportModule = await import('/dist/exports.js'); });
  const result = await page.evaluate(async () => {
    const draft = { id: 'v2', name: 'Sign in', createdAt: new Date().toISOString(), captureTyping: true };
    const base = { url: 'https://app.example.com/login', frameId: 0, timestamp: draft.createdAt };
    const steps = [
      { ...base, id: 'a', sequence: 1, action_type: 'navigate', label: 'app.example.com/login', xpath: '' },
      { ...base, id: 'b', sequence: 2, action_type: 'fill', label: 'Email', xpath: "//*[@id='email']", value: 'qa@example.com' },
      { ...base, id: 'c', sequence: 3, action_type: 'fill', label: 'Password', xpath: "//*[@id='password']", value: '', sensitive: true },
      { ...base, id: 'd', sequence: 4, action_type: 'select', label: 'Country', xpath: "//*[@id='country']", value: 'Spain' },
      { ...base, id: 'e', sequence: 5, action_type: 'check', label: 'I agree', xpath: "//*[@id='terms']" },
      { ...base, id: 'f', sequence: 6, action_type: 'press', label: 'Password', xpath: "//*[@id='password']", key: 'Enter' },
      { ...base, id: 'g', sequence: 7, action_type: 'click', label: 'Continue', xpath: "//button" },
    ];
    const files = await exportModule.createExports(draft, steps);
    const read = async name => files.get(name).text();
    const scripts = {};
    for (const [name] of files) if (/\.(py|js|robot)$/.test(name)) scripts[name] = await read(name);
    return { recording: JSON.parse(await read('recording.json')), csv: await read('data.csv'), readme: await read('README.txt'), en: await read('documentation_en.txt'), scripts };
  });
  expect(result.recording).toMatchObject({ schema_version: 2, capture: { typed_values: true }, start_url: 'https://app.example.com/login',
    secrets: [{ name: 'password_1', label: 'password', kind: 'secret' }] });
  expect(result.recording.steps[2]).toMatchObject({ value: '', sensitive: true, value_ref: { kind: 'secret', name: 'password_1' } });
  expect(result.scripts['script_playwright.py']).toContain('os.environ["QANINJA_PASSWORD_1"]');
  expect(result.scripts['script_playwright.py']).toContain('.select_option(label="Spain")');
  expect(result.scripts['script_cypress.cy.js']).toContain('Cypress.env("QANINJA_PASSWORD_1"), { log: false }');
  expect(result.scripts['script_robot.robot']).toContain('Input Password    xpath=');
  expect(result.scripts['script_robot.robot']).toContain('%{QANINJA_PASSWORD_1}');
  expect(result.readme).toContain('QANINJA_PASSWORD_1');
  expect(result.csv.split('\r\n')[0]).toContain('"action_type"');
  expect(result.csv).toContain('(secret: password_1)');
  expect(result.en).toContain('Typed a secret into: Password');
  for (const [name, script] of Object.entries(result.scripts)) {
    if (name.endsWith('.py')) { const parsed = spawnSync('python3', ['-c', 'import ast,sys;ast.parse(sys.stdin.read())'], { input: script }); expect(parsed.status, parsed.stderr.toString()).toBe(0); }
    if (name.endsWith('.js')) expect(() => new vm.Script(script)).not.toThrow();
  }
});

test('a version 1 database upgrades to version 2 without losing drafts or steps', async ({ page }) => {
  await page.goto('http://127.0.0.1:8765/fixture');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('qaninja', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts', { keyPath: 'id' });
      request.result.createObjectStore('steps', { keyPath: 'id' }).createIndex('recording', 'recordingId');
      request.result.createObjectStore('settings');
    };
    request.onsuccess = () => {
      const tx = request.result.transaction(['drafts', 'steps'], 'readwrite');
      tx.objectStore('drafts').put({ id: 'old', status: 'ready', createdAt: '2026-01-01T00:00:00Z' });
      tx.objectStore('steps').put({ id: 's1', recordingId: 'old', sequence: 1, label: 'Kept' });
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  }));
  await page.addScriptTag({ path: path.resolve(__dirname, '..', 'store.js') });
  const upgraded = await page.evaluate(async () => {
    await NinjaStore.put('secrets', { id: 'x', scope: 'user_1', testId: '7', name: 'password_1' });
    return { steps: (await NinjaStore.steps('old')).map(step => step.label), draft: (await NinjaStore.get('drafts', 'old')).status,
      secrets: (await NinjaStore.all('secrets')).length };
  });
  expect(upgraded).toEqual({ steps: ['Kept'], draft: 'ready', secrets: 1 });
});
