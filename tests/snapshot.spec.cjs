// The executor's view of a page (snapshot.js with dom.js), driven directly as the worker would.
const { test, expect } = require('@playwright/test');
const path = require('path');

async function setup(page, url = 'http://127.0.0.1:8765/form') {
  await page.goto(url);
  await page.evaluate(() => {
    window.listeners = [];
    window.chrome = { runtime: { id: 'test', sendMessage: async () => ({}), onMessage: { addListener: fn => window.listeners.push(fn) } } };
    window.exec = msg => new Promise(resolve => window.listeners.forEach(fn => fn({ type: 'QN_EXEC', ...msg }, { id: 'test' }, resolve)));
  });
  for (const file of ['xpath.js', 'dom.js', 'snapshot.js']) await page.addScriptTag({ path: path.resolve(__dirname, '..', file) });
}
const exec = async (page, op, args = {}) => {
  const result = await page.evaluate(msg => window.exec(msg), { op, ...args });
  expect(result.ok, result.error).toBe(true);
  return result.data;
};

test('the page reads as roles and names with stable ids, and secrets are redacted', async ({ page }) => {
  await setup(page);
  await page.locator('#email').fill('qa@example.com');
  await page.locator('#password').fill('hunter2!');
  const first = (await exec(page, 'read_page')).text;
  expect(first).toMatch(/textbox "Email" \[\[e\d+\]\] value="qa@example.com"/);
  expect(first).toMatch(/textbox "Password" \[\[e\d+\]\] \[password\] value=<redacted>/);
  expect(first).toMatch(/combobox "Country" \[\[e\d+\]\] value="Poland"/);
  expect(first).toMatch(/checkbox "I agree" \[\[e\d+\]\] \[unchecked\]/);
  expect(first).not.toContain('hunter2!');
  const again = (await exec(page, 'read_page')).text;
  expect(again).toBe(first);
  const interactive = (await exec(page, 'read_page', { filter: 'interactive' })).text;
  expect(interactive).not.toMatch(/^- text:/m);
  const found = (await exec(page, 'find', { query: 'country picker' })).text;
  expect(found.split('\n')[0]).toMatch(/^combobox "Country"/);
});

test('recorded steps are located by xpath, then by role and name, then by text', async ({ page }) => {
  await setup(page);
  expect(await exec(page, 'locate', { step: { xpath: "//*[@id='go']", label: 'Go' } })).toMatchObject({ status: 'found', strategy: 'xpath' });
  const healed = await exec(page, 'locate', { step: { xpath: "//*[@id='renamed']", label: 'Go', locators: { role: 'button', name: 'Go', tag: 'button' } } });
  expect(healed).toMatchObject({ status: 'found', strategy: 'role_name' });
  expect(await exec(page, 'locate', { step: { xpath: "//*[@id='nope']", label: 'Nothing like this' } })).toMatchObject({ status: 'not_found' });
  const point = await exec(page, 'prepare', { local: healed.local });
  expect(point).toMatchObject({ obscured: false, tag: 'button' });
  const box = await page.locator('#go').boundingBox();
  expect(point.x).toBeGreaterThanOrEqual(box.x); expect(point.x).toBeLessThanOrEqual(box.x + box.width);
  // A secret field refuses plain values; the executor types secrets itself.
  const password = (await exec(page, 'read_page')).text.match(/textbox "Password" \[\[(e\d+)\]\]/)[1];
  const refused = await page.evaluate(msg => window.exec(msg), { op: 'set_value', local: password, value: 'x' });
  expect(refused).toMatchObject({ ok: false, code: 'sensitive_field' });
  const select = (await exec(page, 'read_page')).text.match(/combobox "Country" \[\[(e\d+)\]\]/)[1];
  await exec(page, 'set_value', { local: select, value: 'Spain' });
  expect(await page.locator('#country').inputValue()).toBe('Spain');
});

test('an element covered by an overlay is reported, not clicked through', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.textContent = 'We use cookies'; cover.setAttribute('role', 'dialog'); cover.setAttribute('aria-label', 'Cookie banner');
    cover.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:9';
    document.body.append(cover);
  });
  const go = (await exec(page, 'locate', { step: { xpath: "//*[@id='go']", label: 'Go' } })).local;
  expect(await exec(page, 'prepare', { local: go })).toMatchObject({ obscured: true, by: 'dialog "Cookie banner"' });
});
