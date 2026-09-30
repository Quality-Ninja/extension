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
   return res.end(JSON.stringify({user_id:req.headers.authorization==='Bearer other-paid-test-token'?3:paid?1:2,plan:paid?'BASIC':'FREE',recording:paid,cloud_save:paid,cloud_limit:paid?25:0,cloud_used:0,valid_until:Math.floor(Date.now()/1000)+3600}));
 }
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
