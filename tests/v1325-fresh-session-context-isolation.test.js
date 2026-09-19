import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { contextualClarification, validateAgentDecision } from '../src/ai-agent.js';

test('fresh session generic clarification never claims an old problem exists',()=>{
  const reply=contextualClarification({state:'BOT_ACTIVE',currentIntent:'GENERAL',previousIntent:'',activeCase:''});
  assert.match(reply,/ada yang bisa kami bantu/i);
  assert.doesNotMatch(reply,/kendala yang tadi|masih mengikuti/i);
});

test('active operational case still gets contextual follow-up clarification',()=>{
  const reply=contextualClarification({state:'WAITING_HUMAN',currentIntent:'GENERAL',previousIntent:'WITHDRAW_PROBLEM',activeCase:'WITHDRAW_PROBLEM'});
  assert.match(reply,/withdraw/i);
  assert.match(reply,/tadi/i);
});

test('low confidence greeting/general in fresh session returns neutral reply and no active case',()=>{
  const d=validateAgentDecision(
    {intent:'GENERAL',action:'SEND_MESSAGE',confidence:0.2,reply:'',activeCase:'GENERAL'},
    {state:'BOT_ACTIVE',currentIntent:'GENERAL',previousIntent:'',activeCase:'',recentMessages:[{sender_type:'customer',text:'Boskuuuu'}]},
    {confidenceThreshold:0.86}
  );
  assert.equal(d.action,'SEND_MESSAGE');
  assert.equal(d.activeCase,null);
  assert.match(d.reply,/ada yang bisa kami bantu/i);
  assert.doesNotMatch(d.reply,/kendala yang tadi|masih mengikuti/i);
});

test('AI Agent previous intent uses post-boundary state and session-scoped ticket',()=>{
  const src=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  const pos=src.indexOf('async function executeConversationAgentTurn');
  const block=src.slice(pos,pos+6200);
  assert.match(block,/getOpenBridgeTicketByChat\(chatId,stateForAgent\?\.session_id\|\|null\)/);
  assert.match(block,/stateForAgent\?\.last_topic/);
  assert.doesNotMatch(block,/sources\.caseBrain\?\.primary_intent\|\|workflowIntent\|\|beforeState\?\.last_topic/);
  assert.match(block,/activeCase:activeCaseForAgent/);
});

test('current-session AI context and bridge-ticket lookup are session scoped',()=>{
  const src=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
  const ctxPos=src.indexOf('export async function getCurrentSessionContext');
  const ctxBlock=src.slice(ctxPos,ctxPos+1800);
  assert.match(ctxBlock,/m\.session_id=c\.session_id/);
  assert.match(ctxBlock,/NULLIF\(c\.session_id,''\) IS NOT NULL/);
  const ticketPos=src.indexOf('export async function getOpenBridgeTicketByChat');
  const ticketBlock=src.slice(ticketPos,ticketPos+850);
  assert.match(ticketBlock,/session_id=\$2/);
});
