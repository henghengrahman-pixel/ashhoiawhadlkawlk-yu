import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LiveChatClient} from '../src/livechat.js';

const poller=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const ui=fs.readFileSync(new URL('../public/assets/js/pages/conversations.js',import.meta.url),'utf8');
const pgResilience=fs.readFileSync(new URL('../src/postgres-resilience.js',import.meta.url),'utf8');

test('v1.32.3 uses newest LiveChat thread, not Array.at(-1)',()=>{
  const lc=new LiveChatClient({accountId:'agent@example.com',pat:'x',base:'https://example.invalid',inboxMode:'all_active'});
  const chat={threads:[
    {id:'OLD',created_at:'2026-09-17T10:00:00Z',active:false},
    {id:'NEW',created_at:'2026-09-17T11:00:00Z',active:true}
  ]};
  assert.equal(lc.chatState(chat).active,true);
  assert.doesNotMatch(fs.readFileSync(new URL('../src/livechat.js',import.meta.url),'utf8'),/threads\.at\(-1\)/);
  assert.doesNotMatch(db,/threads\.at\(-1\)/);
});


test('v1.32.3 get_chat detail overrides stale list summary lifecycle state',()=>{
  const lc=new LiveChatClient({accountId:'agent@example.com',pat:'x',base:'https://example.invalid'});
  const fallback={id:'CHAT',last_thread_summary:{id:'OLD',created_at:'2026-09-17T10:00:00Z',active:true}};
  const detail=lc.normalizeChatDetail({id:'CHAT',threads:[{id:'NEW',created_at:'2026-09-17T12:00:00Z',active:false,events:[]}]},fallback);
  assert.equal(lc.chatState(detail).active,false);
});

test('v1.32.3 normalizes provider Chat not active into deterministic 410',async()=>{
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'Chat not active'}}),{status:422,headers:{'content-type':'application/json'}});
  try{
    const lc=new LiveChatClient({accountId:'agent@example.com',requesterUserId:'agent@example.com',pat:'x',base:'https://example.test'});
    await assert.rejects(()=>lc.sendMessage('CHAT1','hello'),e=>e?.code==='LIVECHAT_CHAT_INACTIVE'&&e?.status===410);
  }finally{globalThis.fetch=oldFetch;}
});

test('v1.32.3 deep sync verifies missing chats before closing them',()=>{
  assert.match(poller,/const missing=previous\.filter/);
  assert.match(poller,/await livechat\.getChat\(id,\{id\}\)/);
  assert.match(poller,/DEEP_SYNC_CONFIRMED_INACTIVE/);
  assert.match(poller,/keepVisible\.add/);
  assert.doesNotMatch(poller,/for\(const id of previous\) if\(!active\.has\(id\)\)\{await db\.markConversationEnded/);
});

test('v1.32.3 manual send/image removes provider-confirmed inactive conversation',()=>{
  assert.match(server,/closeConversationFromInactiveProvider/);
  assert.match(server,/MANUAL_SEND_CONFIRMED_INACTIVE/);
  assert.match(server,/MANUAL_IMAGE_CONFIRMED_INACTIVE/);
  assert.match(server,/res\.status\(410\)\.json\(\{ok:false,error:'LIVECHAT_CHAT_INACTIVE',closed:true\}\)/);
  assert.match(ui,/isClosedChatError/);
  assert.match(ui,/removeClosedConversation/);
});

test('v1.32.3 checked-out PostgreSQL clients have an error listener',()=>{
  assert.match(pgResilience,/export function attachClientErrorHandler/);
  assert.match(pgResilience,/target\.on\('connect'/);
  assert.match(pgResilience,/CLIENT_CONNECTION_ERROR/);
});

test('v1.32.3 database transactions use the same dedicated client',()=>{
  assert.doesNotMatch(db,/await pool\.query\('BEGIN'\)/);
  assert.match(db,/const client=await pool\.connect\(\);/);
  assert.match(db,/await client\.query\('BEGIN'\)/);
  assert.match(db,/finally\{client\.release\(\);\}/);
});
