const { test, expect } = require('@playwright/test');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');
test('durable step ordering, retry deduplication, and reload recovery',async({page})=>{
 await page.goto('http://127.0.0.1:8765/fixture');
 await page.addScriptTag({path:path.resolve(__dirname,'..','store.js')});
 const before=await page.evaluate(async()=>{
   await NinjaStore.put('drafts',{id:'draft',status:'recording',createdAt:new Date().toISOString()});
   await Promise.all(Array.from({length:75},(_,i)=>NinjaStore.append('draft',{id:'step-'+i,label:'Step '+i})));
   await NinjaStore.append('draft',{id:'step-0',label:'Duplicate'});
   return (await NinjaStore.steps('draft')).map(s=>s.sequence);
 });
 expect(before).toEqual(Array.from({length:75},(_,i)=>i+1));
 await page.reload();await page.addScriptTag({path:path.resolve(__dirname,'..','store.js')});
 expect(await page.evaluate(async()=>(await NinjaStore.steps('draft')).length)).toBe(75);
 await page.evaluate(async()=>{const draft=await NinjaStore.get('drafts','draft');draft.status='ready';await NinjaStore.put('drafts',draft)});
 const rejected=await page.evaluate(()=>NinjaStore.append('draft',{id:'late'}).then(()=>false,()=>true));expect(rejected).toBe(true);
});

test('all exports generate offline with Unicode, escaped scripts, and valid PDF',async({page,context})=>{
 await page.goto('http://127.0.0.1:8765/fixture');
 await page.evaluate(async()=>{window.exportModule=await import('/dist/exports.js')});
 await context.setOffline(true);
 const result=await page.evaluate(async()=>{
   const draft={id:'123',name:'Quoted " workflow\nTest',createdAt:new Date().toISOString()};
   const steps=[{id:'step1',sequence:1,timestamp:draft.createdAt,url:'https://example.com/"\\test',xpath:'//*[@title="Hi\\there"]',label:'日本語 español — "quoted"',frameId:0}];
   window.files=await exportModule.createExports(draft,steps);window.draft=draft;
   const scripts={};for(const [name,blob] of files)if(/\.(py|js|robot)$/.test(name))scripts[name]=await blob.text();
   return {names:[...files.keys()],pdf:(await files.get('report.pdf').text()).slice(0,5),jp:await files.get('documentation_jp.txt').text(),scripts};
 });
 expect(result.names).toEqual(expect.arrayContaining(['recording.json','data.csv','report.pdf','documentation_en.txt','documentation_es.txt','documentation_jp.txt','script_robot.robot','script_playwright.py','script_selenium.py','script_cypress.cy.js']));
 expect(result.pdf).toBe('%PDF-');expect(result.jp).toContain('日本語');
 for(const [name,script] of Object.entries(result.scripts)){
   if(name.endsWith('.py')){const parsed=spawnSync('python3',['-c','import ast,sys;ast.parse(sys.stdin.read())'],{input:script});expect(parsed.status,parsed.stderr.toString()).toBe(0)}
   if(name.endsWith('.js'))expect(()=>new vm.Script(script)).not.toThrow();
 }
});

test('folder writes are retryable and only mark complete after every file succeeds',async({page})=>{
 await page.goto('http://127.0.0.1:8765/fixture');
 const result=await page.evaluate(async()=>{
   const module=await import('/dist/exports.js');
   const root=await navigator.storage.getDirectory();
   const draft={id:'folder-test'};
   const files=new Map([['one.txt',new Blob(['first'])],['screenshots/two.jpg',new Blob(['second'])]]);
   await module.writeFolder(root,draft,files);
   const folder=await root.getDirectoryHandle('QaNinja-folder-test');
   const first=JSON.parse(await (await (await folder.getFileHandle('COMPLETE.json')).getFile()).text());
   const broken={getDirectoryHandle:async()=>({removeEntry: (...args)=>folder.removeEntry(...args),getFileHandle:async()=>{throw new Error('Disk full')}})};
   const failed=await module.writeFolder(broken,draft,files).then(()=>false,()=>true);
   const incomplete=await folder.getFileHandle('COMPLETE.json').then(()=>false,()=>true);
   await module.writeFolder(root,draft,files);
   const restored=await folder.getFileHandle('COMPLETE.json').then(()=>true);
   return{first,failed,incomplete,restored};
 });
 expect(result.first.files).toHaveLength(2);expect(result.failed&&result.incomplete&&result.restored).toBe(true);
});
