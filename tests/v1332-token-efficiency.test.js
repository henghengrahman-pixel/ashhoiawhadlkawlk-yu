import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeAgentInput, selectPromptRecentMessages, runConversationAgent } from '../src/ai-agent.js';
import { OpenAIClient } from '../src/ai.js';

function msg(i,extra={}){
  return {sender_type:i%3===0?'agent':'customer',text:`message-${i} ordinary context`,intent:'GENERAL',event_id:`event-${i}`,created_at:`2026-09-18T00:${String(i%60).padStart(2,'0')}:00Z`,...extra};
}

test('v1.33.2 recent prompt is bounded but preserves latest turns and older operational anchors',()=>{
  const rows=Array.from({length:80},(_,i)=>msg(i));
  rows[7]=msg(7,{sender_type:'customer',text:'wd saya belum masuk dari tadi',intent:'WITHDRAW_PROBLEM'});
  rows[11]=msg(11,{sender_type:'agent',text:'Boleh kirim User ID akun bosku?',intent:'WITHDRAW_PROBLEM'});
  const compact=selectPromptRecentMessages(rows);
  assert.ok(compact.length<=32);
  assert.equal(compact.at(-1).text,'message-79 ordinary context');
  assert.ok(compact.some(x=>x.text.includes('wd saya belum masuk')));
  assert.ok(compact.some(x=>x.text.includes('User ID')));
  for(const x of rows.slice(-24)) assert.ok(compact.includes(x),'latest 24 turns must be preserved');
});

test('v1.33.2 normalizeAgentInput caps token-heavy sections without dropping semantic state',()=>{
  const rows=Array.from({length:80},(_,i)=>msg(i,{text:`message-${i} ${'x'.repeat(3000)}`}));
  const x=normalizeAgentInput({
    state:'WAITING_HUMAN',currentIntent:'WITHDRAW_PROBLEM',previousIntent:'WITHDRAW_PROBLEM',activeCase:'WITHDRAW_PROBLEM',
    memberId:'RUDI22',memberIdKnown:true,proofReceived:true,telegramTicketExists:true,
    recentMessages:rows,conversationSummary:'s'.repeat(20000),knowledge:'k'.repeat(50000),rules:'r'.repeat(50000),responses:'p'.repeat(50000),
    approvedLearningExamples:'l'.repeat(50000),approvedCorrections:'c'.repeat(50000),
    caseBrain:{primary_intent:'WITHDRAW_PROBLEM',known_facts:Array.from({length:50},(_,i)=>`fact-${i}`),noise:'z'.repeat(50000)}
  });
  assert.ok(x.recentMessages.length<=32);
  assert.ok(x.recentMessages.every(m=>m.text.length<=1600));
  assert.ok(x.conversationSummary.length<=7000);
  assert.ok(x.knowledge.length<=18000);
  assert.ok(x.rules.length<=18000);
  assert.ok(x.responses.length<=10000);
  assert.ok(x.approvedLearningExamples.length<=8000);
  assert.ok(x.approvedCorrections.length<=8000);
  assert.equal(x.memberId,'RUDI22');
  assert.equal(x.proofReceived,true);
  assert.equal(x.activeCase,'WITHDRAW_PROBLEM');
  assert.equal(x.caseBrain.primary_intent,'WITHDRAW_PROBLEM');
  assert.equal('noise' in x.caseBrain,false);
});

test('v1.33.2 provider-facing context removes non-semantic IDs while retaining operational context',async()=>{
  const client=new OpenAIClient();
  let capturedSystem='',capturedUser='';
  client.completeVision=async(system,user)=>{
    capturedSystem=system; capturedUser=user;
    return {text:JSON.stringify({intent:'WITHDRAW_PROBLEM',confidence:.99,activeCase:'WITHDRAW_PROBLEM',action:'SEND_MESSAGE',reply:'Masih kami cek ya bosku.',missingFields:[],shouldCreateTicket:false,shouldUpdateTicket:false,shouldEscalate:false,nextState:'WAITING_HUMAN',reason:'context_ok',brain:{primary_intent:'WITHDRAW_PROBLEM'}}),usage:{input_tokens:100,output_tokens:20,total_tokens:120}};
  };
  const recent=Array.from({length:60},(_,i)=>msg(i,{text:i===10?'CS minta User ID akun bosku':`turn-${i} ${'a'.repeat(500)}`}));
  const out=await runConversationAgent({client,input:{
    sessionId:'sess-secret-long-id',conversationId:'conv-secret-long-id',livechatChatId:'chat-secret-long-id',threadId:'thread-secret-long-id',
    messageIds:['event-secret-long-id'],rawMessages:['gimana bos'],normalizedMessages:['gimana bos'],state:'WAITING_HUMAN',currentIntent:'WITHDRAW_PROBLEM',activeCase:'WITHDRAW_PROBLEM',
    memberId:'RUDI22',memberIdKnown:true,telegramTicketExists:true,telegramTicketId:'TICKET-SECRET-ID',telegramTicketStatus:'OPEN',recentMessages:recent,
    rules:'rule '.repeat(10000),knowledge:'knowledge '.repeat(10000),responses:'response '.repeat(10000),approvedLearningExamples:'learn '.repeat(10000),approvedCorrections:'correct '.repeat(10000)
  }});
  assert.equal(out.action,'SEND_MESSAGE');
  assert.match(capturedUser,/WITHDRAW_PROBLEM/);
  assert.match(capturedUser,/RUDI22/);
  assert.doesNotMatch(capturedUser,/sess-secret-long-id|event-secret-long-id|TICKET-SECRET-ID/);
  assert.ok(capturedSystem.length<70000,`system prompt unexpectedly large: ${capturedSystem.length}`);
  assert.ok(capturedUser.length<60000,`structured context unexpectedly large: ${capturedUser.length}`);
});

test('v1.33.2 long-history digest reuses per-session cache instead of re-summarizing from zero',()=>{
  const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  assert.match(engine,/getConversationDigest\(chatId\)/);
  assert.match(engine,/digest_message_count/);
  assert.match(engine,/let cursor=digested/);
  assert.match(engine,/saveConversationDigest\(chatId,digest,digested\)/);
  // Existing session boundary reset remains the protection against old-session digest leakage.
  const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
  assert.match(db,/conversation_digest='',digest_message_count=0/);
});
