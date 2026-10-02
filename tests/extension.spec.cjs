const { test, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
let context, worker, panel, target, dir;
const executablePath = process.env.CHROME_EXTENSION_EXECUTABLE;
test.beforeEach(async ({}, testInfo) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaninja-extension-test-'));
  const source = path.resolve(__dirname, '..');
  for (const name of ['manifest.json','background.js','session.js','store.js','config.js','xpath.js','dom.js','inspector.js','snapshot.js','content.js','sidebar.js','sidebar.css','sidebar.html','login.js','login.html','browser-polyfill.min.js','icons','fonts','dist']) {
    fs.cpSync(path.join(source,name),path.join(dir,name),{recursive:true});
  }
  const productionBundle = testInfo.title.includes('production auth bundle');
  fs.writeFileSync(path.join(dir,'config.js'), `const CONFIG = {API_BASE_URL:'http://127.0.0.1:8765',APP_BASE_URL:'http://127.0.0.1:8765',CLERK_PUBLISHABLE_KEY:'${productionBundle ? '' : 'pk_test_mock'}',CLERK_SYNC_HOST:'http://127.0.0.1'};`);
  if (!productionBundle) fs.copyFileSync(path.join(__dirname,'clerk-double.js'), path.join(dir,'dist/auth.js'));
  context=await chromium.launchPersistentContext('',{ ...(executablePath ? {executablePath} : {channel:'chromium'}), headless:true, args:[`--disable-extensions-except=${dir}`,`--load-extension=${dir}`] });
  worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).hostname;
  panel=await context.newPage();await panel.goto(`chrome-extension://${extensionId}/sidebar.html`);
  await panel.setViewportSize({width:360,height:780});
  target=await context.newPage();await target.goto('http://127.0.0.1:8765/fixture');
  await target.bringToFront();
  await expect.poll(()=>panel.evaluate(()=>document.getElementById('expression').value)).toBe('');
});
test.afterEach(async({}, info)=>{
  if (info.status !== info.expectedStatus && panel && !panel.isClosed()) {
    await info.attach('panel-state', {body: await panel.locator('body').innerText(), contentType:'text/plain'});
  }
  await context?.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});
});
const click = id => panel.locator('#'+id).evaluate(node=>node.click());
const value = id => panel.locator('#'+id).inputValue();
async function waitResponse(fn) { await fn(); await expect.poll(()=>panel.evaluate(()=>pending.size)).toBe(0); }
// Signed out, the footer offers Log in and Sign up in place of the plan name.
async function expectSignedOut() {
  await expect(panel.locator('#footer-login')).toBeVisible();
  await expect(panel.locator('#footer-signup')).toBeVisible();
  await expect(panel.locator('#account-status')).toBeHidden();
}
async function setAccount(token, subject = token?.startsWith('free') ? 'user_2' : 'user_1', extra = {}) {
  await worker.evaluate(async ({token, subject, extra}) => {
    await NinjaStore.put('settings', token ? {token, subject, sessionId: 'sess_' + subject, ...extra} : null, 'test_clerk');
    await refreshAuth(true);
  }, {token, subject, extra});
}


test('installed extension: account-free selection, recentering, frames, and navigation', async()=>{
  const apiRequests=[];context.on('request',req=>{if(req.url().includes('/me/')||req.url().includes('/workflows'))apiRequests.push(req.url())});
  await expect(panel.locator('#trail-empty')).toBeVisible();
  await waitResponse(()=>click('pick'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  await expect.poll(()=>value('expression')).toBe("//*[@id='pick']");
  expect(await target.evaluate(()=>window.activated)).toBe(0);
  await expect(panel.locator('#trail-empty')).toBeHidden();
  expect(await panel.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await panel.screenshot({path:'/tmp/qaninja-sidebar-selected.png'});
  await panel.locator('#children button').first().evaluate(node=>node.click());
  await expect.poll(()=>value('expression')).toBe("//*[@id='child']");
  await waitResponse(()=>click('original'));
  await expect.poll(()=>value('expression')).toBe("//*[@id='pick']");
  await waitResponse(()=>click('pick'));
  await target.frameLocator('iframe').locator('#frame-button').click();
  await expect.poll(()=>value('expression')).toBe("//*[@id='frame-button']");
  await expect(panel.locator('#frame-context')).toContainText('Frame');
  await panel.locator('#expression').evaluate(node=>{node.value='//button'});
  await waitResponse(()=>click('test'));
  await expect(panel.locator('#match-count')).toHaveText('1 match');
  expect(apiRequests).toEqual([]);
  await target.reload();
  await expect.poll(()=>value('expression')).toBe('');
  await expect(panel.locator('#trail-empty')).toBeVisible();
  await panel.screenshot({path:'/tmp/qaninja-sidebar.png'});
});

test('installed extension: copies confirm with a toast; long page URLs stay on one line', async()=>{
  await panel.evaluate(()=>{window.copied=[];navigator.clipboard.writeText=async text=>{window.copied.push(text)}});
  const long='/fixture/7a1960d0-b9b1-4594-9d7b-100ba202f697/b2c_1a_signin/oauth2/v2.0/authorize?response_type=id_token&state='+'x'.repeat(300);
  await target.goto('http://127.0.0.1:8765'+long);
  await waitResponse(()=>click('pick'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  await expect.poll(()=>value('expression')).toBe("//*[@id='pick']");
  await expect(panel.locator('#frame-context')).toContainText('/authorize');
  expect((await panel.locator('#frame-context').boundingBox()).height).toBeLessThanOrEqual(32);
  expect(await panel.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await waitResponse(()=>click('copy'));
  await expect(panel.locator('#toast')).toContainText('XPath copied');
  await expect(panel.locator('#copy')).toHaveAttribute('data-copied','');
  await click('frame-context');
  await expect(panel.locator('#toast')).toContainText('Page URL copied');
  expect(await panel.evaluate(()=>window.copied)).toEqual(["//*[@id='pick']",'http://127.0.0.1:8765'+long]);
  await expect(panel.locator('#toast .toast')).toHaveCount(0,{timeout:5000});
  // Use full XPath swaps to the full path and back.
  await waitResponse(()=>click('full-path'));
  await expect.poll(()=>value('expression')).toBe('/html[1]/body[1]/section[1]/form[1]/div[1]/button[1]');
  await expect(panel.locator('#full-path')).toHaveText('Use short XPath');
  await waitResponse(()=>click('full-path'));
  await expect.poll(()=>value('expression')).toBe("//*[@id='pick']");
  // A refused clipboard write explains itself instead of confirming.
  await panel.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw new DOMException('Document is not focused.','NotAllowedError')}});
  await waitResponse(()=>click('copy'));
  await expect(panel.locator('#notice')).toContainText("Couldn't copy");
  await expect(panel.locator('#toast .toast')).toHaveCount(0);
});

test('installed extension: paid recording, drain, local export and mode isolation', async()=>{
  await setAccount('paid-test-token');
  await waitResponse(()=>click('mode-record'));
  await expect(panel.locator('#record')).toBeEnabled();
  await waitResponse(()=>click('record'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  await expect.poll(()=>panel.locator('#step-count').textContent()).toBe('1 step');
  await waitResponse(()=>click('mode-xpath'));
  await waitResponse(()=>click('pick'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  expect(await panel.evaluate(async()=>(await NinjaStore.steps(draft.id)).length)).toBe(1);
  await waitResponse(()=>click('mode-record'));
  await waitResponse(()=>click('pause'));
  await target.locator('#duplicate').first().click();
  await panel.evaluate(()=>{window.showDirectoryPicker=async()=>{throw new DOMException('cancelled','AbortError')}});
  await waitResponse(()=>click('finish'));
  await expect(panel.locator('#record-status')).toHaveText('Ready to save');
  await expect(panel.locator('#notice')).toContainText('Folder selection cancelled');
  expect(await panel.evaluate(async()=>(await NinjaStore.steps(draft.id)).length)).toBe(2);
  // A real OPFS directory exercises the same write interface without automating OS dialogs.
  await panel.evaluate(async()=>NinjaStore.put('settings',await navigator.storage.getDirectory(),'folder'));
  await waitResponse(()=>click('save-files'));
  await expect(panel.locator('#record-status')).toHaveText('Saved to your folder');
  const names=await panel.evaluate(async()=>{const root=await navigator.storage.getDirectory();const folder=await root.getDirectoryHandle('QaNinja-'+draft.id);const names=[];for await(const name of folder.keys())names.push(name);return names});
  expect(names).toEqual(expect.arrayContaining(['COMPLETE.json','data.csv','report.pdf','script_robot.robot']));
});

test('installed extension: only picks count; at the limit picking freezes but the path stays explorable', async()=>{
  const used=()=>worker.evaluate(async()=>(await chrome.storage.local.get('finder_usage')).finder_usage.count);
  await expect(panel.locator('#quota-text')).toHaveText('50 inspections left today');
  await worker.evaluate(()=>chrome.storage.local.set({finder_usage:{start:Date.now(),count:48}}));
  await waitResponse(()=>panel.evaluate(()=>loadQuota()));
  await waitResponse(()=>click('pick'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  await expect(panel.locator('#quota-text')).toHaveText('1 inspection left today');
  // Children, ancestors, Back, and Original element all belong to that one inspection.
  await waitResponse(()=>panel.locator('#children button').first().evaluate(node=>node.click()));
  await expect.poll(()=>value('expression')).toBe("//*[@id='child']");
  await waitResponse(()=>panel.locator('#breadcrumbs button').first().evaluate(node=>node.click()));
  await expect.poll(()=>value('expression')).toBe("//*[@id='grand']");
  await waitResponse(()=>click('back'));
  await expect.poll(()=>value('expression')).toBe("//*[@id='child']");
  await waitResponse(()=>click('original'));
  await expect.poll(()=>value('expression')).toBe("//*[@id='pick']");
  await expect(panel.locator('#quota-text')).toHaveText('1 inspection left today');
  expect(await used()).toBe(49);
  // The next pick is the 50th inspection.
  await waitResponse(()=>click('pick'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  await expect(panel.locator('#quota-gate')).toBeVisible();
  await expect(panel.locator('#quota-reset')).toContainText('Inspecting unlocks');
  await expect(panel.locator('#quota')).toBeHidden();
  await expect(panel.locator('#pick')).toBeDisabled();
  // The worker refuses even if the panel is bypassed.
  expect(await panel.evaluate(()=>inspect('pick').then(()=>0,error=>error.status))).toBe(429);
  // The last inspection stays explorable, and Test and Copy still work.
  await expect(panel.locator('#children button').first()).toBeEnabled();
  await waitResponse(()=>panel.locator('#children button').first().evaluate(node=>node.click()));
  await expect.poll(()=>value('expression')).toBe("//*[@id='child']");
  await waitResponse(()=>click('original'));
  await expect.poll(()=>value('expression')).toBe("//*[@id='pick']");
  await panel.screenshot({path:'/tmp/qaninja-sidebar-quota.png'});
  await waitResponse(()=>click('test'));
  await expect(panel.locator('#match-count')).toHaveText('1 match');
  await waitResponse(()=>click('full-path'));
  await expect(panel.locator('#notice')).toBeEmpty();
  expect(await used()).toBe(50);
  // The window ends 24 hours after the first inspection.
  await worker.evaluate(()=>chrome.storage.local.set({finder_usage:{start:Date.now()-25*3600000,count:50}}));
  await waitResponse(()=>panel.evaluate(()=>loadQuota()));
  await expect(panel.locator('#quota-text')).toHaveText('50 inspections left today');
  await expect(panel.locator('#pick')).toBeEnabled();
  await expect(panel.locator('#quota-gate')).toBeHidden();
});

test('installed extension: signed-in free accounts are counted by the API; paid plans are unlimited', async()=>{
  await setAccount('free-test-token');
  await expect(panel.locator('#quota-text')).toHaveText('50 inspections left today');
  await waitResponse(()=>click('pick'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  await expect.poll(()=>worker.evaluate(async()=>(await chrome.storage.local.get('finder_quota')).finder_quota?.used)).toBe(1);
  await expect(panel.locator('#quota-text')).toHaveText('49 inspections left today');
  // Exploring the picked element's path is not another inspection.
  await waitResponse(()=>panel.locator('#children button').first().evaluate(node=>node.click()));
  await expect.poll(()=>value('expression')).toBe("//*[@id='child']");
  expect(await worker.evaluate(async()=>(await chrome.storage.local.get('finder_quota')).finder_quota.used)).toBe(1);
  await expect(panel.locator('#quota-text')).toHaveText('49 inspections left today');
  await setAccount('paid-test-token');
  await expect(panel.locator('#quota')).toBeHidden();
  await expect(panel.locator('#pick')).toBeEnabled();
});

test('installed extension: free recording cover and panel disconnect cleanup', async()=>{
  await waitResponse(()=>click('mode-record'));
  await expect(panel.locator('#record-cover')).toBeVisible();
  await expect(panel.locator('#record-tools')).toBeHidden();
  await waitResponse(()=>click('mode-xpath'));
  await waitResponse(()=>click('pick'));
  await panel.close();
  await expect.poll(()=>target.locator('[data-qaninja-ui]').count()).toBe(0);
  await target.locator('#pick').click({position:{x:3,y:3}});
  expect(await target.evaluate(()=>window.activated)).toBe(1);
});

test('installed extension: worker interruption restores a paused draft without losing steps', async()=>{
  await setAccount('paid-test-token');
  await waitResponse(()=>click('mode-record'));
  await waitResponse(()=>click('record'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  await expect.poll(()=>panel.locator('#step-count').textContent()).toBe('1 step');
  const id=await panel.evaluate(()=>draft.id);
  const cdp=await context.newCDPSession(target);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect.poll(async()=>panel.evaluate(async()=>{try{return (await rpc('DRAFT')).draft?.status}catch{return 'retry'}})).toBe('paused');
  expect(await panel.evaluate(async id=>(await NinjaStore.steps(id)).length,id)).toBe(1);
  // The page must stop capture even though the old recording had been active.
  await target.locator('#pick').click({position:{x:3,y:3}});
  await panel.reload();
  await target.bringToFront();
  await waitResponse(()=>click('mode-record'));
  await expect(panel.locator('#record-status')).toHaveText('Recording paused');
  expect(await panel.evaluate(async id=>(await NinjaStore.steps(id)).length,id)).toBe(1);
});

test('installed extension: cancel picking from the panel, keyboard tabs, and menu dismissal', async()=>{
  await waitResponse(()=>click('pick'));
  await expect(panel.locator('#pick-label')).toHaveText('Cancel selection');
  await waitResponse(()=>click('pick'));
  await expect(panel.locator('#pick-label')).toHaveText('Select element');
  await expect(panel.locator('#notice')).toHaveText('Selection cancelled.');
  // Cancelling stops picking in every frame, so the page receives clicks again.
  await target.locator('#pick').click({position:{x:3,y:3}});
  expect(await target.evaluate(()=>window.activated)).toBe(1);
  await waitResponse(()=>click('pick'));
  await panel.keyboard.press('Escape');
  await expect(panel.locator('#pick-label')).toHaveText('Select element');
  // Arrow keys move focus only; switching modes pauses recording, so it needs Enter or Space.
  await panel.locator('#mode-xpath').focus();
  await panel.keyboard.press('ArrowRight');
  expect(await panel.evaluate(()=>document.activeElement.id)).toBe('mode-record');
  await expect(panel.locator('#mode-xpath')).toHaveAttribute('aria-selected','true');
  await panel.evaluate(()=>{document.getElementById('menu').open=true});
  await panel.keyboard.press('Escape');
  expect(await panel.evaluate(()=>document.getElementById('menu').open)).toBe(false);
});

test('installed extension: sign-in opens the website and cancellation keeps Finder available', async()=>{
  await panel.goto(panel.url().replace('sidebar.html','login.html'));
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
  const website = context.waitForEvent('page');
  await panel.locator('#auth-btn').click();
  const tab = await website;
  await expect.poll(()=>tab.url()).toContain('/sign-in?next=%2Faccount');
  await tab.close();
  await panel.locator('#auth-check').click();
  await expect(panel.locator('#error-msg')).toContainText('Finish logging in');
  await panel.locator('#back-link').click();
  await expect(panel.locator('#pick')).toBeEnabled();
});

test('installed extension: paid tabs open on covers, and every Log in link returns to its tab', async()=>{
  const apiRequests=[];context.on('request',req=>{if(req.url().includes('/me/')||req.url().includes('/workflows'))apiRequests.push(req.url())});
  await expect(panel.locator('[role="tablist"][aria-label="Tool"] [role="tab"]')).toHaveText(['XPath','Record','Generate','Execute']);
  await expectSignedOut();
  await expect(panel.locator('#promo')).toHaveCount(0);
  await expect(panel.locator('#footer-login')).toHaveAttribute('href','login.html?mode=login&open=1');
  await expect(panel.locator('#footer-signup')).toHaveAttribute('href','login.html?mode=signup&open=1');
  await waitResponse(()=>click('mode-generate'));
  await expect(panel.locator('#mode-generate')).toHaveAttribute('aria-selected','true');
  await expect(panel.locator('#generate-cover')).toBeVisible();
  await expect(panel.locator('#generate-tools')).toBeHidden();
  // The preview under the sheet is a picture: hidden from assistive tech and inert.
  await expect(panel.locator('#generate-cover .cover-preview')).toHaveAttribute('aria-hidden','true');
  await expect(panel.locator('#generate-signin')).toHaveAttribute('href','login.html?mode=login&return=generate&open=1');
  await waitResponse(()=>click('mode-execute'));
  await expect(panel.locator('#execute-cover')).toBeVisible();
  await expect(panel.locator('#execute-tools')).toBeHidden();
  await expect(panel.locator('#execute-signin')).toHaveAttribute('href','login.html?mode=login&return=execute&open=1');
  expect(await panel.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await waitResponse(()=>click('mode-record'));
  await expect(panel.locator('#record-cover')).toBeVisible();
  await expect(panel.locator('#record-signin')).toHaveAttribute('href','login.html?mode=login&return=record&open=1');
  // The menu and footer links follow the open tab.
  await expect(panel.locator('#menu-signin')).toHaveAttribute('href','login.html?mode=login&return=record&open=1');
  await expect(panel.locator('#footer-signup')).toHaveAttribute('href','login.html?mode=signup&return=record&open=1');
  expect(await panel.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  expect(apiRequests).toEqual([]);
  // Signed in on the free plan, the covers ask for a plan rather than a log in, and the footer names the plan.
  await setAccount('free-test-token');
  await expect(panel.locator('#account-status')).toHaveText('Free plan');
  await expect(panel.locator('#account-actions')).toBeHidden();
  await expect(panel.locator('#record-signin')).toBeHidden();
  await expect(panel.locator('#record-plans')).toHaveClass(/primary/);
});

test('installed extension: footer Sign up opens the website once and returns when signed in', async()=>{
  await waitResponse(()=>click('mode-generate'));
  const website = context.waitForEvent('page');
  await click('footer-signup');
  const tab = await website;
  await expect.poll(()=>tab.url()).toContain('/sign-in?mode=signup&next=%2Faccount');
  await expect(panel.locator('#form-title')).toHaveText('Finish signing up on the website');
  await expect(panel.locator('#auth-check')).toBeVisible();
  // The panel's URL keeps the state but not open=1, so reloading does not open another tab.
  await expect.poll(()=>new URL(panel.url()).search).toBe('?mode=signup&return=generate&opened=1');
  const pages = context.pages().length;
  await panel.reload();
  await expect(panel.locator('#form-title')).toHaveText('Finish signing up on the website');
  await panel.waitForTimeout(500);
  expect(context.pages().length).toBe(pages);
  // Switching to log in changes the words without opening anything.
  await panel.locator('#auth-toggle').click();
  await expect(panel.locator('#form-title')).toHaveText('Log in');
  await expect(panel.locator('#auth-toggle')).toHaveText('Need an account? Sign up');
  await setAccount('free-test-token');
  await expect(panel.locator('#mode-generate')).toHaveAttribute('aria-selected','true');
  await expect(panel.locator('#account-status')).toHaveText('Free plan');
});

test('installed extension: Generate lists test plans and writes each framework\'s script', async()=>{
  await setAccount('paid-test-token');
  await panel.evaluate(()=>{window.copied=[];navigator.clipboard.writeText=async text=>{window.copied.push(text)}});
  await waitResponse(()=>click('mode-generate'));
  await expect(panel.locator('#generate-cover')).toBeHidden();
  await expect(panel.locator('#plans .plan')).toHaveCount(2);
  await expect(panel.locator('#plan-count')).toHaveText('2 plans');
  // The newest plan is selected and its Playwright script is written from its steps.
  await expect(panel.locator('#plans .plan.target')).toContainText('Checkout');
  await expect(panel.locator('#script-text')).toContainText(`page.locator("xpath=//*[@id='add-to-cart']").click()`);
  await expect(panel.locator('#script-file')).toHaveText('test_checkout_playwright.py');
  await waitResponse(()=>click('fw-robot'));
  await expect(panel.locator('#script-text')).toContainText("Click Element    xpath=//*[@id='place-order']");
  await expect(panel.locator('#script-file')).toHaveText('checkout.robot');
  await waitResponse(()=>click('copy-script'));
  await expect(panel.locator('#toast')).toContainText('Script copied');
  await expect(panel.locator('#toast')).toContainText('checkout.robot');
  expect((await panel.evaluate(()=>window.copied))[0]).toContain('*** Test Cases ***');
  await waitResponse(()=>panel.locator('#plans .plan').nth(1).evaluate(node=>node.click()));
  await expect(panel.locator('#plans .plan.target')).toContainText('Sign in with SSO');
  await expect(panel.locator('#plans .plan[aria-current="true"]')).toHaveCount(1);
  await expect(panel.locator('#script-text')).toContainText("xpath=//button[@data-provider='sso']");
  const download=panel.waitForEvent('download');
  await click('download-script');
  expect((await download).suggestedFilename()).toBe('sign_in_with_sso.robot');
  // The framework is remembered for the next visit.
  expect(await worker.evaluate(async()=>(await chrome.storage.local.get('framework')).framework)).toBe('robot');
  expect(await panel.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await panel.screenshot({path:'/tmp/qaninja-sidebar-generate.png'});
});

test('installed extension: signing in from a cover returns to that tab', async()=>{
  await panel.goto(panel.url().replace('sidebar.html','login.html?return=generate'));
  await expect(panel.locator('#back-link')).toHaveAttribute('href','sidebar.html?mode=generate');
  await expect(panel.locator('#back-link')).toHaveText('Back to Generate');
  await setAccount('paid-test-token');
  await expect(panel.locator('#mode-generate')).toHaveAttribute('aria-selected','true');
  await expect(panel.locator('#plans .plan')).toHaveCount(2);
  // The panel drops ?mode= once it has opened the tab.
  expect(new URL(panel.url()).search).toBe('');
});


test('installed extension: production auth bundle loads with unconfigured anonymous Finder', async()=>{
  await expectSignedOut();
  await waitResponse(()=>click('pick'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  await expect.poll(()=>value('expression')).toBe("//*[@id='pick']");
  await panel.goto(panel.url().replace('sidebar.html','login.html'));
  await panel.locator('#auth-btn').click();
  await expect(panel.locator('#error-msg')).toContainText('not configured');
});

test('installed extension: account change pauses the draft and blocks transfer to another account', async()=>{
  await setAccount('paid-test-token');
  await expect(panel.locator('#account-status')).toHaveText('Basic plan');
  await waitResponse(()=>click('mode-record'));
  await waitResponse(()=>click('record'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  await expect(panel.locator('#step-count')).toHaveText('1 step');
  const original = await worker.evaluate(async()=>await currentDraft());
  await setAccount('other-paid-test-token', 'user_other');
  await expect(panel.locator('#record-status')).toHaveText('Recording paused');
  await expect(panel.locator('#pause')).toBeDisabled();
  const refused = await panel.evaluate(async()=> {
    try { await rpc('UPLOAD_TOKEN',{ownerId:draft.ownerId,ownerSubject:draft.ownerSubject}); return null; }
    catch (error) { return error.status; }
  });
  expect(refused).toBe(409);
  expect((await worker.evaluate(async()=>await currentDraft())).id).toBe(original.id);
  await waitResponse(()=>click('finish'));
  // Export remains available even though another account cannot resume or upload the draft.
  await expect(panel.locator('#zip')).toBeEnabled();
});

test('installed extension: offline access is bounded and cannot survive known sign-out', async()=>{
  await setAccount('paid-test-token');
  await expect(panel.locator('#account-status')).toHaveText('Basic plan');
  await worker.evaluate(async()=> {
    const session = await NinjaStore.get('settings', 'test_clerk');
    await NinjaStore.put('settings', {...session,error:true}, 'test_clerk');
  });
  expect(await worker.evaluate(async()=> (await capabilities(true)).recording)).toBe(true);
  await worker.evaluate(async()=> {
    const {capabilities: caps} = await chrome.storage.local.get('capabilities');
    await chrome.storage.local.set({capabilities:{...caps,valid_until:1}});
  });
  expect(await worker.evaluate(async()=> {try {await capabilities(true);return false;}catch{return true;}})).toBe(true);
  await setAccount(null);
  expect(await worker.evaluate(async()=> (await capabilities(true)).signedIn)).toBe(false);
  expect(await worker.evaluate(async()=> (await chrome.storage.local.get('capabilities')).capabilities)).toBeUndefined();
});

test('installed extension: tokens refresh after rejection and stay inaccessible to content scripts', async()=>{
  await setAccount('expired-test-token','user_1',{refreshToken:'paid-test-token'});
  const caps = await worker.evaluate(async()=> await capabilities(true));
  expect(caps.plan).toBe('BASIC');
  // sender.url identifies a web page even though content scripts share the extension ID.
  expect(await worker.evaluate(()=>trustedPage({id:chrome.runtime.id,url:'https://example.com'}))).toBe(false);
  expect(await worker.evaluate(()=>trustedPage({id:chrome.runtime.id,url:chrome.runtime.getURL('sidebar.html')}))).toBe(true);
  const [content] = await worker.evaluate(async()=> {
    const [tab] = await chrome.tabs.query({url:'http://127.0.0.1:8765/fixture'});
    return chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=> {
      let storage = {};
      try { storage = await chrome.storage.local.get(null); } catch {}
      const response = await chrome.runtime.sendMessage({type:'AUTH_STATE'});
      return {storage,response};
    }});
  });
  expect(JSON.stringify(content.result.storage)).not.toContain('paid-test-token');
  expect(JSON.stringify(content.result.storage)).not.toContain('expired-test-token');
  expect(content.result.response.ok).toBe(false);
  const storage = await worker.evaluate(()=>chrome.storage.local.get(null));
  expect(storage.ninja_token).toBeUndefined();
  expect(storage.auth_state.token).toBeUndefined();
});

test('installed extension: cloud upload uses the owner token and ignores completion after an account switch', async()=>{
  await setAccount('paid-test-token');
  await expect(panel.locator('#account-status')).toHaveText('Basic plan');
  await waitResponse(()=>click('mode-record'));
  await panel.selectOption('#destination','dashboard');
  await waitResponse(()=>click('record'));
  await target.locator('#pick').click({position:{x:3,y:3}});
  await expect(panel.locator('#step-count')).toHaveText('1 step');
  let complete, markStarted;
  const started = new Promise(resolve=>{ markStarted = resolve; });
  await context.route('http://127.0.0.1:8765/workflows',async route=>{
    if (route.request().method() !== 'POST') return route.continue();
    expect(route.request().headers().authorization).toBe('Bearer paid-test-token');
    expect(route.request().headers()['content-type']).toContain('multipart/form-data');
    complete = () => route.fulfill({contentType:'application/json',body:JSON.stringify({id:8})});
    markStarted();
  });
  await click('finish');
  await started;
  await setAccount('other-paid-test-token','user_other');
  await expect.poll(()=>panel.evaluate(()=>authEpoch)).toBe(await worker.evaluate(()=>authState.epoch));
  await complete();
  await expect(panel.locator('#notice')).toContainText('account changed');
  expect((await worker.evaluate(async()=>await currentDraft())).savedTo).toBeUndefined();
});

test('installed extension: shared logout preserves device usage and clears capabilities', async()=>{
  await worker.evaluate(()=>chrome.storage.local.set({finder_usage:{start:Date.now(),count:12}}));
  await setAccount('paid-test-token');
  await expect(panel.locator('#account-status')).toHaveText('Basic plan');
  await waitResponse(()=>click('logout'));
  await expectSignedOut();
  const storage=await worker.evaluate(()=>chrome.storage.local.get(null));
  expect(storage.test_clerk).toBeUndefined();
  expect(await worker.evaluate(()=>NinjaStore.get('settings','test_clerk'))).toBeNull();
  expect(storage.capabilities).toBeUndefined();
  expect(storage.finder_usage.count).toBe(12);
});

test('installed extension: API rejection clears previously verified paid access', async()=>{
  await setAccount('paid-test-token');
  await expect(panel.locator('#account-status')).toHaveText('Basic plan');
  await worker.evaluate(async()=> {
    await NinjaStore.put('settings', {subject:'user_1',sessionId:'sess_user_1',token:'rejected-test-token'}, 'test_clerk');
    try { await capabilities(true); } catch {}
  });
  await expectSignedOut();
  const storage = await worker.evaluate(()=>chrome.storage.local.get(['capabilities','finder_quota']));
  expect(storage.capabilities).toBeUndefined();
  expect(storage.finder_quota).toBeUndefined();
});

test('installed extension: website cookie changes synchronize open and closed panels', async()=>{
  const changeSession = async (token, value) => worker.evaluate(async ({token,value})=>{
    await NinjaStore.put('settings', token ? {subject:'user_1',sessionId:'sess_user_1',token} : null, 'test_clerk');
    await chrome.cookies.set({url:'http://127.0.0.1',name:'__client_uat',value});
  },{token,value});
  await changeSession('paid-test-token','1');
  await expect(panel.locator('#account-status')).toHaveText('Basic plan');
  const url = panel.url();
  await panel.close();
  await changeSession(null,'0');
  await expect.poll(()=>worker.evaluate(()=>authState.signedIn)).toBe(false);
  panel = await context.newPage(); await panel.goto(url);
  await expectSignedOut();
  expect(await worker.evaluate(()=>NinjaStore.get('settings','folder'))).toBeUndefined();
});
