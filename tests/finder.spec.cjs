const { test, expect } = require('@playwright/test');
const path = require('path');
async function setup(page) {
 await page.goto('http://127.0.0.1:8765/fixture');
 await page.evaluate(() => {
   window.messages=[]; window.listeners=[];
   window.chrome={ runtime: { sendMessage: async msg=>{window.messages.push(msg);return{}}, onMessage:{addListener:fn=>window.listeners.push(fn)} } };
   window.command=msg=>new Promise(resolve=>window.listeners.forEach(fn=>fn({type:'INSPECT',...msg},{},resolve)));
 });
 await page.addScriptTag({path:path.resolve(__dirname, '..', 'xpath.js')});
 await page.addScriptTag({path:path.resolve(__dirname, '..', 'inspector.js')});
}
async function command(page, action, args={}) { const result=await page.evaluate(({action,args})=>window.command({action,...args}),{action,args}); expect(result.ok,result.error).toBe(true); return result.data; }
async function select(page, selector) { await command(page,'pick'); await page.locator(selector).click({position:{x:3,y:3}}); return page.evaluate(()=>window.messages.filter(m=>m.event==='selected').at(-1).state); }

test.beforeEach(async({page})=>setup(page));

test('picker blocks activation; three ancestors and descendant recentering; history',async({page})=>{
 let state=await select(page,'#pick');
 expect(await page.evaluate(()=>window.activated)).toBe(0);
 expect(state.current.identity).toBe('#pick');
 expect(state.ancestors.map(n=>n.identity)).toEqual(['#great','#grand','#parent']);
 state=await command(page,'select',{nodeId:state.ancestors[0].id});
 expect(state.current.identity).toBe('#great');
 state=await command(page,'original');
 for(const expected of ['#child','#grandchild','#greatgrandchild']){
   state=await command(page,'select',{nodeId:state.children[0].id});
   expect(state.current.identity).toBe(expected);
 }
 state=await command(page,'back'); expect(state.current.identity).toBe('#grandchild');
 state=await command(page,'original'); expect(state.current.identity).toBe('#pick');
 await page.locator('#pick').click(); expect(await page.evaluate(()=>window.activated)).toBe(1);
});

test('selectors handle duplicate IDs, quotes, structural paths, and SVG',async({page})=>{
 const results=await page.evaluate(()=>{
  const nodes=[document.querySelectorAll('#duplicate')[1],document.querySelector('#quotes'),document.querySelector('circle')];
  document.querySelector('#quotes').removeAttribute('id');
  return nodes.map(node=>{
   const xpath=QaNinjaXPath.generate(node), full=QaNinjaXPath.structural(node);
   return {xpath,valid:QaNinjaXPath.unique(xpath,node),fullValid:QaNinjaXPath.unique(full,node)};
  });
 });
 expect(results.every(r=>r.valid&&r.fullValid)).toBe(true);
 expect(results[0].xpath).not.toBe("//*[@id='duplicate']"); expect(results[1].xpath).toContain('concat(');
});

test('queries preserve expression across paginated matches and detect changes',async({page})=>{
 let state=await command(page,'test',{expression:"//*[@id='many']/button"});
 expect(state.matchCount).toBe(120);expect(state.matches).toHaveLength(50);
 state=await command(page,'match',{index:55});expect(state.matchIndex).toBe(55);expect(state.query).toBe("//*[@id='many']/button");
 await page.locator('#many button').first().evaluate(node=>node.remove());
 const changed=await page.evaluate(()=>command({action:'match',index:56}));
 expect(changed.ok).toBe(false);expect(changed.error).toContain('changed');
});

test('child lists paginate and include hidden elements',async({page})=>{
 let state=await command(page,'test',{expression:"//*[@id='many']"});
 expect(state.childTotal).toBe(120); expect(state.children).toHaveLength(50);
 state=await command(page,'children',{offset:100}); expect(state.children).toHaveLength(20);
 state=await command(page,'test',{expression:'/html/body'});
 expect(state.children.find(n=>n.identity==='#hidden').hidden).toBe(true);
});

test('invalid, scalar, non-element, and empty queries produce actionable responses',async({page})=>{
 for(const expression of ['//*[','count(//button)','//@id']){
  const result=await page.evaluate(expression=>command({action:'test',expression}),expression);
  expect(result.ok).toBe(false);
 }
 const result=await command(page,'test',{expression:'//does-not-exist'});expect(result.matchCount).toBe(0);
});

test('Escape cancels; clear removes highlights and interception; original can be repicked',async({page})=>{
 await command(page,'pick');await page.keyboard.press('Escape');
 await page.locator('#pick').click();expect(await page.evaluate(()=>window.activated)).toBe(1);
 await select(page,'#pick');await command(page,'clear');
 await expect(page.locator('[data-qaninja-ui]')).toHaveCount(0);
 let state=await select(page,'#pick');state=await command(page,'select',{nodeId:state.ancestors.at(-1).id});expect(state.current.identity).toBe('#parent');
});

test('removed selection is unavailable and cannot be copied',async({page})=>{
 const state=await select(page,'#pick');
 await page.locator('#pick').evaluate(node=>node.remove());
 await expect.poll(()=>page.evaluate(()=>messages.some(m=>m.event==='unavailable'))).toBe(true);
 const result=await page.evaluate(xpath=>command({action:'validate',expression:xpath}),state.xpath);expect(result.ok).toBe(false);
 await expect(page.locator('[data-qaninja-ui]')).toBeHidden();
});

test('links do not navigate and shadow targets have an explicit explanation',async({page})=>{
 await select(page,'#link');expect(page.url()).toContain('/fixture');
 await command(page,'pick');await page.locator('#shadow button').click();
 expect(await page.evaluate(()=>messages.at(-1).message)).toContain('Shadow DOM');
});

test('Finder operates offline without API calls',async({page,context})=>{
 const requests=[];page.on('request',req=>requests.push(req.url()));
 await context.setOffline(true);await select(page,'#pick');
 const state=await command(page,'test',{expression:'//button'});expect(state.matchCount).toBeGreaterThan(1);
 expect(requests).toEqual([]);
});
