import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LiveChatClient } from '../src/livechat.js';

const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
const migrations=fs.readFileSync(new URL('../src/services/modular-migrations.js',import.meta.url),'utf8');
const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');

function lcError(status,message){const e=new Error(`LIVECHAT_${status}: ${message}`);e.status=status;return e;}

test('v1.32.4 same-thread session resolver is serialized with a PostgreSQL advisory lock',()=>{
  const start=db.indexOf('export async function beginNewConversationSession');
  const block=db.slice(start,start+7000);
  assert.match(block,/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(block,/FOR UPDATE/);
  assert.match(block,/sameThread \|\| sameSessionKey/);
  assert.ok(block.indexOf('sameThread || sameSessionKey') < block.indexOf('archiveConversationSessionResilient(chatId'));
});

test('v1.32.4 session identity is idempotent on chat_id + session_key',()=>{
  const start=db.indexOf('export async function beginNewConversationSession');
  const block=db.slice(start,start+7000);
  assert.match(block,/stableSessionId\(id,sessionKey\)/);
  assert.match(block,/ON CONFLICT\(chat_id,session_key\) DO UPDATE SET/);
  assert.doesNotMatch(block,/stableSessionId\(chatId,`\$\{sessionKey\}\|g\$\{generation\}`\)/);
  assert.match(migrations,/ON CONFLICT\(chat_id,session_key\) DO UPDATE SET/);
});

test('v1.32.4 closed session only reopens for a confirmed different provider thread; synthetic fallback is rejected',()=>{
  const start=db.indexOf('export async function beginNewConversationSession');
  const block=db.slice(start,start+7000);
  assert.match(block,/confirmedDifferentThread/);
  assert.match(block,/if\(!normalizedThread\).*return false/);
  assert.doesNotMatch(block,/authoritativeFallback/);
  assert.match(block,/\['closed','closing'\]\.includes\(priorStatus\)/);
});

test('v1.32.4 confirmed close is serialized and removes inbox visibility before commit',()=>{
  const start=db.indexOf('export async function markConversationEnded');
  const block=db.slice(start,start+5000);
  assert.match(block,/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(block,/status='closing',handling_state='CLOSED',visible_in_inbox=false,lc_active=false/);
  assert.match(block,/status='closed',handling_state='CLOSED',visible_in_inbox=false,lc_active=false/);
  assert.match(block,/conversation_sessions SET status='CLOSED',lc_active=false,visible_in_inbox=false/);
});

test('v1.32.4 stale thread deactivation cannot close a newer thread',()=>{
  const start=db.indexOf('export async function markConversationEnded');
  const block=db.slice(start,start+5000);
  assert.match(block,/STALE_THREAD_DEACTIVATION/);
  assert.match(block,/current && current!==tid/);
});

test('v1.32.4 routing_status closed is provider-confirmed inactive even without active boolean',()=>{
  const lc=new LiveChatClient({base:'http://local',accountId:'agent@example.com',pat:'p'});
  assert.equal(lc.chatState({routing_status:'closed'}).active,false);
  assert.equal(lc.chatState({last_thread_summary:{routing_status:'archived'}}).active,false);
  assert.equal(lc.chatState({status:'inactive'}).active,false);
});

test('v1.32.4 public-agent capacity is classified as deterministic non-retryable provider limit',async()=>{
  const lc=new LiveChatClient({base:'http://local',accountId:'agent@example.com',requesterUserId:'agent@example.com',pat:'p'});
  lc.call=async(action)=>{
    if(action==='add_user_to_chat') throw lcError(422,'Public agents in chat limit reached');
    throw lcError(403,'Requester is not user of the chat');
  };
  await assert.rejects(async()=>{
    try{await lc.sendMessage('c1','halo');}
    catch(e){assert.equal(e.code,'LIVECHAT_PUBLIC_AGENT_LIMIT');assert.equal(e.retryable,false);throw e;}
  },/LIVECHAT_PUBLIC_AGENT_LIMIT/);
});

test('v1.32.4 engine does not overwrite explicit non-retryable LiveChat errors',()=>{
  assert.match(engine,/else if\(err\?\.retryable!==false\) err\.retryable=true/);
});

test('v1.32.4 conversation/session sync resolves unique conflict on provider session key',()=>{
  const start=db.indexOf('async function syncConversationSessionRecord');
  const block=db.slice(start,start+6000);
  assert.match(block,/ON CONFLICT\(chat_id,session_key\) DO UPDATE SET/);
  assert.match(block,/UPDATE conversations SET conversation_id=\$2,session_id=\$3,session_key=\$4/);
});

test('v1.32.4 archive remains session-scoped and invisible alone is not treated as closed',()=>{
  const start=db.indexOf('export async function backfillLegacyArchiveSessions');
  const block=db.slice(start,start+1600);
  assert.match(block,/c\.status='closed' AND c\.lc_active=false AND c\.visible_in_inbox=false/);
  const ended=db.slice(db.indexOf('export async function markConversationEnded'),db.indexOf('export async function listPromoRules'));
  assert.match(ended,/sessionKeyOverride:String\(cur\.session_key\|\|''\)\|\|null/);
});

test('v1.32.4 confirmed close can archive zero-message session metadata',()=>{
  const start=db.indexOf('async function archiveCurrentConversationSessionWithClient');
  const block=db.slice(start,start+6500);
  assert.doesNotMatch(block,/if\(!messages\.length\)return null/);
  assert.match(block,/messageCount:archive\._archiveMessageCount\|\|archive\.message_count\|\|0/);
});
