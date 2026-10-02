const http = require('http');
const fs = require('fs');
const path = require('path');
const fixture = `<!doctype html><html><body>
<section id="great"><form id="grand"><div id="parent"><button id="pick" type="button"><span id="child"><b id="grandchild"><i id="greatgrandchild">Go</i></b></span></button><a id="link" href="/gone">Do not follow</a></div></form></section>
<button id="duplicate">One</button><button id="duplicate">Two</button>
<div id="quotes" aria-label="It&#39;s &quot;quoted&quot;">Quoted</div>
<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="20"></circle></svg>
<div id="many"></div><div id="empty"></div><div id="hidden" hidden>Hidden child</div>
<div id="shadow"></div><iframe src="/frame" title="frame"></iframe>
<script>window.activated=0;document.getElementById('pick').onclick=()=>window.activated++;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.activated++};for(let i=0;i<120;i++){const e=document.createElement('button');e.textContent='Item '+i;document.getElementById('many').append(e)}document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow button</button>';</script>
</body></html>`;
const finderUsage = {};
// Execute fixtures: a shop and a login page that record whether clicks were trusted (real input, not script).
const shop = `<!doctype html><html><head><title>Shop</title></head><body><main><h1>Cart</h1>
<button id="add" type="button">Add to cart</button><button id="buy" type="button">Buy now</button>
<p id="done" hidden>Order confirmed</p><a href="/login">Sign in</a></main>
<script>window.trusted=[];for(const b of document.querySelectorAll('button'))b.addEventListener('click',e=>{window.trusted.push([b.id,e.isTrusted]);if(b.id==='buy')document.getElementById('done').hidden=false;});</script></body></html>`;
const login = `<!doctype html><html><head><title>Sign in</title></head><body><main><h1>Sign in</h1>
<form id="form"><label for="email">Email</label><input id="email" name="email"><label for="password">Password</label>
<input id="password" name="password" type="password"><button id="submit" type="submit">Sign in</button></form><p id="welcome"></p></main>
<script>document.getElementById('form').onsubmit=e=>{e.preventDefault();window.passwordLength=document.getElementById('password').value.length;
document.getElementById('welcome').textContent='Welcome '+document.getElementById('email').value;};</script></body></html>`;
// Recording v2: fields whose values must never be captured, next to ones that may be.
const form = `<!doctype html><html><head><title>Form</title></head><body><form id="f">
<label for="email">Email</label><input id="email" name="email">
<label for="password">Password</label><input id="password" type="password">
<label for="otp">Code</label><input id="otp" autocomplete="one-time-code">
<label for="note">Note</label><input id="note">
<label for="country">Country</label><select id="country"><option>Poland</option><option>Spain</option></select>
<label><input id="terms" type="checkbox"> I agree</label><button id="go" type="submit">Go</button></form>
<script>document.getElementById('f').onsubmit=e=>e.preventDefault();</script></body></html>`;
// The Execute API double: a scenario sets the run's spec and the agent's scripted replies; every request is logged.
let scenario = { spec: null, script: 'none' }, execLog = { requests: [], steps: [], events: [], artifacts: 0, turns: [], finish: null };
const RUN_ID = 'run_' + 'a'.repeat(32);
function readBody(req) { return new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); }); }
function turnReply(body) {
  execLog.turns.push(body);
  if (scenario.script === 'heal') {
    if (body.episode) {
      const ref = (body.observation.snapshot.match(/button "Buy now" \[(ref_\d+)\]/) || [])[1];
      return { turn_seq: body.turn_seq, episode_id: 'ep_1', status: 'act', message: 'Clicking Buy now', cancel_requested: false,
        actions: [{ tool_use_id: 'toolu_1', name: 'left_click', input: { target: { type: 'ref', ref } }, toolset: true, kind: 'browser' }] };
    }
    return { turn_seq: body.turn_seq, episode_id: 'ep_1', status: 'step_done', step_done: { step_index: body.turn_seq ? 1 : 0, ref: null, summary: 'Clicked Buy now' }, cancel_requested: false };
  }
  if (scenario.script === 'navigate') {
    if (body.episode) return { turn_seq: body.turn_seq, episode_id: 'ep_2', status: 'act', cancel_requested: false,
      actions: [{ tool_use_id: 'toolu_2', name: 'navigate', input: { url: 'http://127.0.0.1:8764/elsewhere' }, toolset: true, kind: 'browser' }] };
    return { turn_seq: body.turn_seq, episode_id: 'ep_2', status: 'verdict', verdict: { status: 'BLOCKED', reason: 'Navigation was blocked.', blocked_reason: 'navigation_blocked' }, cancel_requested: false };
  }
  return { turn_seq: body.turn_seq, episode_id: 'ep_0', status: 'verdict', verdict: { status: 'PASSED', reason: 'Looks right.', blocked_reason: null }, cancel_requested: false };
}
async function execute(req, res) {
  const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  const raw = await readBody(req);
  execLog.requests.push({ url: req.url, method: req.method, body: raw.toString('latin1') });
  const body = req.headers['content-type']?.includes('application/json') && raw.length ? JSON.parse(raw) : {};
  const summary = { id: RUN_ID, name: 'Checkout', status: 'running', verdict: null, steps_total: scenario.spec?.steps.length || 0 };
  if (req.url === '/execute/tests') return json([{ id: 7, name: 'Checkout', steps: 2, settings: { default_mode: 'assisted', default_brain: 'managed', secrets: scenario.spec?.secrets || [] }, last_run: null }]);
  if (req.url === '/execute/connections') return json([]);
  if (req.url.startsWith('/execute/runs?')) return json({ data: [], next_cursor: null });
  if (req.url === '/execute/runs/pending') return json([]);
  if (req.url === '/execute/runs' && req.method === 'POST') return json({ run: summary, spec: scenario.spec });
  const match = req.url.match(/^\/execute\/runs\/(run_[a-f0-9]{32})\/(\w+)$/);
  if (!match) { res.statusCode = 404; return json({ detail: 'Not found' }); }
  const action = match[2];
  if (action === 'claim') return json({ run: summary, spec: scenario.spec });
  if (action === 'heartbeat') return json({ cancel_requested: false, status: 'running' });
  if (action === 'steps') { execLog.steps.push(...body.steps); return json({ ok: true, cancel_requested: false }); }
  if (action === 'events') { execLog.events.push(...body.events); return json({ ok: true, saved: body.events.length }); }
  if (action === 'artifacts') { execLog.artifacts++; return json({ id: 'art_' + execLog.artifacts, existing: false }); }
  if (action === 'turns') return json(turnReply(body));
  if (action === 'finish') { execLog.finish = body; return json({ ...summary, status: body.status, verdict: body.verdict || null, summary: body.summary, error: body.error }); }
  res.statusCode = 404; return json({ detail: 'Not found' });
}
// The paid account's test plans: saved recordings, newest first.
const plans = [
 {id:7,name:'Checkout',created_at:'2026-09-28T15:04:00Z',steps:2,recording:{schema_version:1,name:'Checkout',steps:[
   {sequence:1,label:'Add to cart',url:'https://shop.example.com/',xpath:"//*[@id='add-to-cart']"},
   {sequence:2,label:'Place order',url:'https://shop.example.com/cart',xpath:"//*[@id='place-order']"}]}},
 {id:3,name:'Sign in with SSO',created_at:'2026-09-20T09:30:00Z',steps:1,recording:{schema_version:1,name:'Sign in with SSO',steps:[
   {sequence:1,label:'Continue with SSO',url:'https://app.example.com/login',xpath:"//button[@data-provider='sso']"}]}}
];
http.createServer((req, res) => {
 if (req.url.startsWith('/sign-in')) { res.setHeader('Content-Type','text/html'); return res.end('<!doctype html><title>Sign in</title><p>Clerk sign-in fixture</p>'); }
 const paid = ['Bearer paid-test-token','Bearer other-paid-test-token'].includes(req.headers.authorization);
 if (req.headers.authorization==='Bearer expired-test-token') { res.statusCode=401; res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({detail:'Token expired.'})); }
 if (req.headers.authorization==='Bearer rejected-test-token') { res.statusCode=401; res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({detail:'Session revoked.'})); }
 if (req.url === '/workflows' && req.method === 'POST') {
   req.resume(); req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:8,existing:false}));}); return;
 }
 if (req.url === '/me/capabilities') {
   res.setHeader('Content-Type','application/json');
   return res.end(JSON.stringify({user_id:req.headers.authorization==='Bearer other-paid-test-token'?3:paid?1:2,plan:paid?'BASIC':'FREE',recording:paid,cloud_save:paid,cloud_limit:paid?25:0,cloud_used:0,valid_until:Math.floor(Date.now()/1000)+3600,
     execute:paid,execute_managed_available:paid,execute_managed_limit:paid?10:0,execute_managed_used:0}));
 }
 if (req.url === '/_exec/scenario' && req.method === 'POST') {
   readBody(req).then(raw => { scenario = JSON.parse(raw); execLog = { requests: [], steps: [], events: [], artifacts: 0, turns: [], finish: null }; res.end('{}'); }); return;
 }
 if (req.url === '/_exec/log') { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(execLog)); }
 if (req.url.startsWith('/execute/')) {
   if (!paid) { res.statusCode = 403; res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({detail:'An active paid plan is required.'})); }
   execute(req, res); return;
 }
 if (req.url === '/shop') { res.setHeader('Content-Type','text/html'); return res.end(shop); }
 if (req.url === '/login') { res.setHeader('Content-Type','text/html'); return res.end(login); }
 if (req.url === '/form') { res.setHeader('Content-Type','text/html'); return res.end(form); }
 if (req.url === '/workflows' && req.method === 'GET') {
   res.setHeader('Content-Type','application/json');
   return res.end(JSON.stringify(paid ? plans.map(({recording,...plan})=>plan) : []));
 }
 const plan = req.method === 'GET' && plans.find(item => req.url === `/workflows/${item.id}`);
 if (plan) {
   res.setHeader('Content-Type','application/json');
   if (!paid) { res.statusCode=403; return res.end(JSON.stringify({detail:'An active paid plan is required.'})); }
   return res.end(JSON.stringify({id:plan.id,name:plan.name,recording:plan.recording}));
 }
 if (req.url === '/me/finder-usage') {
   res.setHeader('Content-Type','application/json');
   if (req.headers.authorization==='Bearer paid-test-token') return res.end(JSON.stringify({limit:null,used:0,resets_at:null}));
   const key=req.headers.authorization||'', usage=finderUsage[key] ||= {used:0,resets_at:null};
   if (req.method==='POST') {
     if (usage.used>=50) { res.statusCode=429; return res.end(JSON.stringify({detail:"You've used today's 50 XPath inspections."})); }
     usage.used++; usage.resets_at ||= Math.floor(Date.now()/1000)+86400;
   }
   return res.end(JSON.stringify({limit:50,...usage}));
 }
 if (req.url === '/fixture' || req.url.startsWith('/fixture/')) { res.setHeader('Content-Type','text/html'); return res.end(fixture); }
 if (req.url === '/frame') { res.setHeader('Content-Type','text/html'); return res.end('<html><body><button id="frame-button">In frame</button></body></html>'); }
 const file = path.resolve(__dirname, '..', '.' + req.url);
 if (!file.startsWith(path.resolve(__dirname, '..') + path.sep)) { res.statusCode=404; return res.end(); }
 try { res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file)); }
 catch {res.statusCode=404;res.end();}
}).listen(8765,'127.0.0.1');
http.createServer((req, res) => { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Elsewhere</title><p>Not allowed</p>'); }).listen(8764,'127.0.0.1');
