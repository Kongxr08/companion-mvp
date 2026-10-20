import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Engine, AppError } from '../lib/engine.mjs';
import { handleApi } from '../lib/http.mjs';

const migration=readFileSync(new URL('../drizzle/0000_curious_hedge_knight.sql',import.meta.url),'utf8');
class D1Adapter{
  constructor(file=':memory:'){this.raw=new DatabaseSync(file);this.raw.exec(migration);this.batchSizes=[];}
  prepare(sql){
    const raw=this.raw;
    const make=args=>({
      bind:(...values)=>make(values),
      async first(){return raw.prepare(sql).get(...args)||null;},
      async all(){return {results:raw.prepare(sql).all(...args)};},
      execute(){const r=raw.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},
      async run(){return this.execute();},
    });return make([]);
  }
  async batch(statements){
    this.batchSizes.push(statements.length);this.raw.exec('BEGIN IMMEDIATE');
    try{const result=statements.map(s=>s.execute());this.raw.exec('COMMIT');return result;}
    catch(e){this.raw.exec('ROLLBACK');throw e;}
  }
}
function setup(file){
  const db=new D1Adapter(file),time={now:Date.UTC(2026,9,20,4)/1000},clock=()=>time.now;
  return {db,time,clock,a:new Engine(db,'alice',{},clock),b:new Engine(db,'bob',{},clock)};
}
const user={userId:'alice',email:'alice@example.test',displayName:'Alice'};
function req(route,body,origin='https://companion.test'){
  return new Request('https://companion.test'+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{Origin:origin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
test('new accounts have persona but no fabricated memories',async()=>{
  const {a}=setup(),s=await a.snapshot();assert.equal(s.settings.name,'绫濑沙季');assert.equal(s.memories.length,0);assert.equal(s.mode,'demo');
});
test('chat, name, preferences and mood persist across a database reconnect',async()=>{
  const file=path.join(mkdtempSync(path.join(tmpdir(),'companion-cloud-')),'state.db');
  const {a,db,clock}=setup(file);await a.chat('我叫小林。我喜欢雨天，谢谢。','one');db.raw.close();
  const raw=new DatabaseSync(file),adapter=Object.create(D1Adapter.prototype);adapter.raw=raw;adapter.batchSizes=[];
  const s=await new Engine(adapter,'alice',{},clock).snapshot();assert.equal(s.messages.length,2);assert.equal(s.memories.length,2);assert.ok(s.mood.valence>.6);raw.close();
});
test('two users cannot read or mutate each other’s records',async()=>{
  const {a,b}=setup();await a.chat('我喜欢猫。','same-token');await b.chat('我喜欢狗。','same-token');
  const sa=await a.snapshot(),sb=await b.snapshot();assert.equal(sa.memories[0].content,'我喜欢猫');assert.equal(sb.memories[0].content,'我喜欢狗');
  await assert.rejects(b.changeMemory({id:sa.memories[0].id},true),e=>e.status===404);
  assert.ok(!(JSON.stringify(await b.export())).includes('猫'));
});
test('request retries are idempotent and reused tokens cannot change text',async()=>{
  const {a}=setup();const one=await a.chat('我喜欢猫。','one');assert.deepEqual(await a.chat('我喜欢猫。','one'),one);
  assert.equal((await a.snapshot()).messages.length,2);await assert.rejects(a.chat('我喜欢狗。','one'),/请求编号/);
});
test('a model failure writes neither messages, memories nor mood',async()=>{
  const {a}=setup();const before=await a.snapshot();a.env={CHAT_MODE:'live',LLM_MODEL:'test'};a.complete=async()=>{throw new AppError('接口失败',502);};
  await assert.rejects(a.chat('我喜欢猫，谢谢。','one'),/接口失败/);const after=await a.snapshot();
  assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.memories,before.memories);assert.deepEqual(after.mood,before.mood);
});
test('concurrent duplicate requests commit exactly one exchange',async()=>{
  const {a,db,clock}=setup(),other=new Engine(db,'alice',{},clock);let n=0,release;const gate=new Promise(r=>{release=r;});
  for(const e of [a,other])e.reply=async()=>{if(++n===2)release();await gate;return ['你好',[]];};
  const values=await Promise.all([a.chat('你好','same'),other.chat('你好','same')]);assert.deepEqual(values[0],values[1]);assert.equal((await a.snapshot()).messages.length,2);
});
test('concurrent different writes detect conflict instead of overwriting',async()=>{
  const {a,db,clock,time}=setup(),other=new Engine(db,'alice',{},clock);let n=0,release;const gate=new Promise(r=>{release=r;});
  for(const e of [a,other])e.reply=async()=>{if(++n===2)release();await gate;return ['你好',[]];};
  const results=await Promise.allSettled([a.chat('你好甲','one'),other.chat('你好乙','two')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  assert.equal((await a.snapshot()).messages.length,2);assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM mutation_guards').get().n,0);
  time.now+=2;await other.chat(results[0].status==='rejected'?'你好甲':'你好乙',results[0].status==='rejected'?'one':'two');assert.equal((await a.snapshot()).messages.length,4);
});
test('corrected and forgotten memories invalidate stale model context',async()=>{
  const {a}=setup();await a.chat('我喜欢猫。','one');let s=await a.snapshot();await a.changeMemory({id:s.memories[0].id,content:'我喜欢狗'});
  s=await a.snapshot();assert.equal(s.memories[0].content,'我喜欢狗');assert.ok(!s.messages[0].content.includes('猫'));assert.equal((await a.account()).context_floor,2);
  await a.changeMemory({id:s.memories[0].id},true);assert.equal((await a.snapshot()).memories.length,0);
});
test('name correction replaces a previous name and hypothetical statements are ignored',async()=>{
  const {a,time}=setup();await a.chat('我叫甲。假如我喜欢狗呢？','one');assert.equal((await a.snapshot()).memories.length,0);
  time.now+=2;await a.chat('我叫甲。','two');time.now+=2;await a.chat('以后叫我乙。','three');const s=await a.snapshot();assert.equal(s.memories.length,1);assert.equal(s.memories[0].content,'以后叫我乙');
});
test('manual persona reset preserves messages, memories, mood and reminders',async()=>{
  const {a,time}=setup();await a.chat('我喜欢猫，谢谢。','one');await a.addTask('喝水',time.now+100);await a.saveSettings({name:'自定义',persona:'简短交流。',daily_limit:5});
  const before=await a.snapshot();await a.saveSettings({},true);const after=await a.snapshot();for(const key of ['messages','memories','mood','tasks'])assert.deepEqual(after[key],before[key]);assert.equal(after.settings.daily_limit,5);assert.equal(after.settings.name,'绫濑沙季');
});
test('settings validation rejects invalid types and leaves saved state unchanged',async()=>{
  const {a}=setup();await assert.rejects(a.saveSettings({idle_enabled:'yes'}),/布尔/);await assert.rejects(a.saveSettings({daily_limit:0}));await assert.rejects(a.saveSettings({persona:'x'.repeat(3001)}));assert.equal((await a.snapshot()).settings.daily_limit,3);
});
test('due reminders persist, honor quiet hours and are not duplicated by concurrent polls',async()=>{
  const {a,db,clock,time}=setup();time.now=Date.UTC(2026,9,20,14,59,40)/1000;await a.addTask('喝水',time.now+30);time.now+=60;
  assert.equal((await a.snapshot()).messages.length,0);time.now=Date.UTC(2026,9,21,0,1)/1000;
  const other=new Engine(db,'alice',{},clock);await Promise.all([a.snapshot(),other.snapshot()]);const s=await a.snapshot();assert.equal(s.messages.length,1);assert.equal(s.messages[0].kind,'reminder');assert.equal(s.tasks[0].status,'delivered');assert.equal(s.tasks[0].message_id,s.messages[0].id);
});
test('cancelling and clearing another user’s data never affects owner reminders',async()=>{
  const {a,b,time}=setup();const t=await a.addTask('喝水',time.now+30);await assert.rejects(b.cancelTask(t.id),e=>e.status===404);await b.clearHistory();await a.cancelTask(t.id);time.now+=40;assert.equal((await a.snapshot()).messages.length,0);
});
test('idle messages honor daily limits and survive new engine instances',async()=>{
  const {a,db,clock,time}=setup();await a.saveSettings({idle_enabled:true,idle_minutes:1,daily_limit:1});time.now+=61;assert.equal((await a.snapshot()).messages.length,1);time.now+=61;assert.equal((await new Engine(db,'alice',{},clock).snapshot()).messages.length,1);
});
test('data export contains full history, not only the last 200 displayed messages',async()=>{
  const {a,db,time}=setup();const messages=Array.from({length:300},(_,i)=>({id:i+1,role:i%2?'assistant':'user',content:'消息'+i,kind:'chat',created_at:time.now-100+i/1000}));
  await a.importBackup({format:'companion-mvp-v1',messages,memories:[],tasks:[]});assert.equal((await a.snapshot()).messages.length,200);assert.equal((await a.export()).messages.length,300);assert.ok(Math.max(...db.batchSizes)<=6);
});
test('import remaps source IDs, preserves preferences, and cannot overwrite a nonempty account',async()=>{
  const {a,b,time}=setup();await a.chat('我喜欢猫。','one');await a.addTask('喝水',time.now+100);const backup=await a.export();await b.importBackup(backup);
  const sb=await b.snapshot();assert.equal(sb.memories[0].source_id,sb.messages[0].id);assert.notEqual(sb.memories[0].source_id,backup.messages[0].id);assert.equal(sb.tasks.length,1);await assert.rejects(b.importBackup(backup),e=>e.status===409);
});
test('a malformed import is atomic and does not leave partial messages',async()=>{
  const {a,time}=setup();await assert.rejects(a.importBackup({format:'companion-mvp-v1',messages:[{id:1,role:'user',content:'你好',created_at:time.now}],memories:[{category:'secret',content:'bad'}],tasks:[]}));assert.equal((await a.snapshot()).messages.length,0);
});
test('database batch failure rolls back the whole mutation and revision',async()=>{
  const {a}=setup();const before=await a.account();await assert.rejects(a.commit(before,[a.stmt("INSERT INTO messages(user_id,role,content,event_key,created_at) VALUES(?,'user','one','duplicate',?)",a.uid,a.clock()),a.stmt("INSERT INTO messages(user_id,role,content,event_key,created_at) VALUES(?,'user','two','duplicate',?)",a.uid,a.clock())]));assert.equal((await a.account()).revision,before.revision);assert.equal((await a.snapshot()).messages.length,0);
});
test('anonymous callers are denied even when they supply forged user fields',async()=>{
  const {db,clock}=setup();const request=req('/api/chat',{message:'hello',request_id:'one',user_id:'alice'});request.headers.set('oai-authenticated-user-id','alice');
  const r=await handleApi(request,db,null,{},clock);assert.equal(r.status,401);assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,0);
});
test('cross-origin writes are rejected server-side',async()=>{
  const {db,clock}=setup();const r=await handleApi(req('/api/chat',{message:'hello',request_id:'one'},'https://attacker.test'),db,user,{},clock);assert.equal(r.status,403);
});
test('authenticated API ignores client-chosen owner IDs and never returns server secrets',async()=>{
  const {db,clock}=setup();const r=await handleApi(req('/api/chat',{message:'我喜欢猫。',request_id:'one',user_id:'bob'}),db,user,{},clock);assert.equal(r.status,200);
  const state=await handleApi(req('/api/state'),db,user,{LLM_API_KEY:'SENTINEL-SECRET'},clock);const raw=await state.text();assert.ok(!raw.includes('SENTINEL-SECRET'));assert.ok(raw.includes('我喜欢猫'));assert.match(state.headers.get('Cache-Control'),/no-store/);assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id='bob'").get().n,0);
});
test('oversized bodies and malformed JSON fail without mutating storage',async()=>{
  const {db,clock}=setup();const over=await handleApi(req('/api/chat',{message:'x'.repeat(70000),request_id:'one'}),db,user,{},clock);assert.equal(over.status,413);
  const bad=new Request('https://companion.test/api/chat',{method:'POST',headers:{Origin:'https://companion.test','Content-Type':'application/json'},body:'{' });assert.equal((await handleApi(bad,db,user,{},clock)).status,400);
});
test('model evidence must occur in current user text',async()=>{
  const {a}=setup();a.env={CHAT_MODE:'live',LLM_MODEL:'test'};a.complete=async()=>JSON.stringify({reply:'嗯。',memories:[{category:'fact',evidence:'我来自月球'},{category:'fact',evidence:'我每天骑车上班'}]});
  await a.chat('我每天骑车上班。','one');const s=await a.snapshot();assert.equal(s.memories.length,1);assert.equal(s.memories[0].content,'我每天骑车上班');
});
test('provider error bodies and secrets are not surfaced to the browser',async()=>{
  const {a}=setup(),original=globalThis.fetch;a.env={CHAT_MODE:'live',LLM_MODEL:'test',LLM_API_KEY:'SENTINEL-SECRET'};
  globalThis.fetch=async()=>new Response('SENTINEL-SECRET private prompt',{status:401});
  try{await assert.rejects(a.chat('你好','one'),e=>e.status===502&&!e.message.includes('SENTINEL'));assert.equal((await a.snapshot()).messages.length,0);}finally{globalThis.fetch=original;}
});
