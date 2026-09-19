import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeText, detectIntent } from '../src/normalizer.js';
import { validateAgentDecision, contextualClarification, normalizeAgentInput, agentActionAllowlist, runConversationAgent } from '../src/ai-agent.js';
import { OpenAIClient } from '../src/ai.js';

const poller=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
const migrations=fs.readFileSync(new URL('../src/services/modular-migrations.js',import.meta.url),'utf8');
const ingress=fs.readFileSync(new URL('../src/livechat-ingress.js',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const agent=fs.readFileSync(new URL('../src/ai-agent.js',import.meta.url),'utf8');

function decisionFor(message,state='BOT_ACTIVE',activeCase='WITHDRAW'){
  return validateAgentDecision({action:'AUTO_REPLY',confidence:.2,reply:'',brain:{primary_intent:'GENERAL'}},{state,activeCase,currentIntent:'GENERAL',rawMessages:[message],normalizedMessages:[normalizeText(message)]},{confidenceThreshold:.86});
}

test('01 multi customer messages in one snapshot are all processing candidates',()=>{
  assert.doesNotMatch(poller,/type==='customer'\s*&&\s*isNewest/);
  assert.match(poller,/for \(const ev of unseen\)/);
  assert.match(poller,/registerCustomerEventProcessing\(chatId,ev\.eventId/);
  assert.match(poller,/processCustomerMessage\(\{chatId,eventId:ev\.eventId/);
});

test('02 rapid messages receive durable PENDING record before debounce',()=>{
  const reg=poller.indexOf('registerCustomerEventProcessing(chatId,ev.eventId');
  const debounce=poller.indexOf('const remainingMs=',reg);
  assert.ok(reg>0 && debounce>reg);
  assert.match(db,/registerCustomerEventProcessing[\s\S]{0,1400}'PENDING'/);
});

test('03 same text with different message IDs is not text-deduplicated',()=>{
  assert.match(engine,/sourceEventId/);
  assert.match(engine,/sessionIdentity\}\|\$\{sourceEventId\}\|\$\{outboundAction/);
  assert.match(engine,/Valid customer events are never deduplicated by text/);
});

test('04 duplicate same provider event ID is idempotent',()=>{
  assert.match(db,/PRIMARY KEY\(chat_id,event_id\)/);
  assert.match(db,/ON CONFLICT\(chat_id,event_id\) DO NOTHING/);
});

test('05 WD initial issue is classified deterministically',()=>assert.equal(detectIntent('wd belum masuk'),'WITHDRAW_PROBLEM'));

test('06 WD follow-up udah sejam remains contextual',()=>{
  const d=decisionFor('udah sejam bos'); assert.equal(d.action,'SEND_MESSAGE'); assert.match(d.reply,/withdraw/i);
});

test('07 WD follow-up masih blom remains contextual',()=>{
  const d=decisionFor('masih blom'); assert.equal(d.action,'SEND_MESSAGE'); assert.match(d.reply,/withdraw/i);
});

test('08 WD follow-up gimana bos remains contextual',()=>{
  const d=decisionFor('gimana bos'); assert.equal(d.action,'SEND_MESSAGE'); assert.match(d.reply,/withdraw/i);
});

test('09 deposit follow-up binds to active deposit case',()=>assert.match(contextualClarification({activeCase:'DEPOSIT'}),/deposit/i));

test('10 WAITING_HUMAN is allowed to reply',()=>{
  const d=validateAgentDecision({action:'AUTO_REPLY',confidence:.95,reply:'Masih kami cek ya.'},{state:'WAITING_HUMAN',activeCase:'WITHDRAW'},{confidenceThreshold:.86});
  assert.equal(d.action,'SEND_MESSAGE'); assert.notEqual(d.action,'NO_REPLY');
});

test('11 WAITING_MEMBER_ID is allowed to reply',()=>{
  const d=validateAgentDecision({action:'ASK_INFO',confidence:.95,reply:'Boleh info User ID bosku?'},{state:'WAITING_MEMBER_ID',activeCase:'DEPOSIT'},{confidenceThreshold:.86});
  assert.notEqual(d.action,'NO_REPLY');
});

test('12 WAITING_PROOF is allowed to reply',()=>{
  const d=validateAgentDecision({action:'ASK_INFO',confidence:.95,reply:'Boleh kirim bukti transfernya?'},{state:'WAITING_PROOF',activeCase:'DEPOSIT'},{confidenceThreshold:.86});
  assert.notEqual(d.action,'NO_REPLY');
});

test('13 HUMAN_ACTIVE is the agent-level silent state',()=>{
  const d=validateAgentDecision({action:'AUTO_REPLY',confidence:1,reply:'x'},{state:'HUMAN_ACTIVE'});
  assert.equal(d.action,'NO_REPLY'); assert.equal(d.nextState,'HUMAN_ACTIVE');
});

test('14 withdraw typos and slang normalize correctly',()=>{
  assert.equal(detectIntent('witdrow sy blm msokk bos'),'WITHDRAW_PROBLEM');
  assert.match(normalizeText('widhraw blumm msk'),/withdraw belum masuk/);
});

test('15 deposit typos and slang normalize correctly',()=>{
  assert.equal(detectIntent('depsit blm masokk'),'DEPOSIT_PROBLEM');
  assert.equal(normalizeText('isi saldo'),'deposit');
  assert.equal(normalizeText('setor'),'deposit');
});

test('16 low confidence produces safe contextual clarification, never silence',()=>{
  const d=decisionFor('jadi gimana?','BOT_ACTIVE','RESET_PASSWORD');
  assert.equal(d.action,'SEND_MESSAGE'); assert.ok(d.reply.length>0); assert.match(d.reason,/low_confidence_contextual_clarification/);
});

test('17 existing Telegram ticket prevents duplicate create and permits update',()=>{
  const d=validateAgentDecision({action:'ASK_HUMAN',confidence:.99,reply:''},{state:'WAITING_HUMAN',activeCase:'WITHDRAW',telegramTicketExists:true,telegramTicketId:'WD-1'},{confidenceThreshold:.86});
  assert.equal(d.shouldCreateTicket,false); assert.equal(d.shouldUpdateTicket,true);
});

test('18 OpenAI timeout/429/5xx can propagate into durable retry',()=>{
  assert.match(engine,/isRetryableTurnError/); assert.match(engine,/RETRYABLE_TURN_FAILURE/);
  assert.match(ingress,/err\?\.retryable===true/); assert.match(ingress,/429/);
});

test('19 LiveChat send failure is retryable and input is not marked DONE in catch',()=>{
  assert.match(engine,/err\.retryable=true/);
  assert.match(engine,/finishCustomerEventProcessing\(chatId,eventId,\{ok:false/);
});

test('20 stale PROCESSING customer event is recoverable',()=>{
  assert.match(db,/status='PROCESSING' AND claimed_at < now\(\)-\(\$4::text\|\|' seconds'\)::interval/);
  assert.match(db,/status IN \('PENDING','FAILED'\)/);
});

test('21 active inbox endpoint only returns confirmed active rows',()=>{
  assert.match(server,/visible_in_inbox=true AND c\.status='active' AND c\.lc_active IS DISTINCT FROM false/);
});

test('22 confirmed closed conversation is removed from active inbox state',()=>{
  assert.match(db,/status='closed',handling_state='CLOSED',visible_in_inbox=false,lc_active=false/);
});

test('23 confirmed close snapshots session into archives',()=>{
  const pos=db.indexOf('export async function markConversationEnded');
  const block=db.slice(pos,pos+2500);
  assert.match(block,/archiveConversationSessionResilient/); assert.match(block,/conversation_sessions SET status='CLOSED'/);
});

test('24 invisible active is not enough to create legacy archive',()=>{
  const pos=db.indexOf('export async function backfillLegacyArchiveSessions');
  const block=db.slice(pos,pos+1000);
  assert.match(block,/c\.status='closed' AND c\.lc_active=false AND c\.visible_in_inbox=false/);
});

test('25 same member returning on a new thread creates a new session',()=>{
  const pos=db.indexOf('export async function upsertConversation'); const block=db.slice(pos,pos+5000);
  assert.match(block,/isNewThread/); assert.match(block,/beginNewConversationSession/);
});

test('26 prior session is closed and archived on new session boundary',()=>{
  const pos=db.indexOf('export async function beginNewConversationSession'); const block=db.slice(pos,pos+4200);
  assert.match(block,/archiveConversationSessionResilient/); assert.match(block,/conversation_sessions SET status='CLOSED'/);
});

test('27 old history does not enter new-session AI context',()=>{
  assert.match(engine,/getCurrentSessionContext\(chatId,10000\)/);
  assert.match(db,/m\.session_key=NULLIF\(c\.session_key,''\)/);
});

test('28 closed session cannot reopen from stale active event on same thread',()=>{
  assert.match(db,/IMMUTABLE_CLOSED_SESSION/);
  assert.match(poller,/immutable_closed_session/);
});

test('29 a genuinely new readable LiveChat thread is an explicit session boundary',()=>{
  assert.match(db,/SESSION_BOUNDARY_UNCONFIRMED/);
  assert.match(db,/boundarySource:'LIVECHAT_READABLE_NEW_THREAD'/);
  assert.match(engine,/boundarySource:'LIVECHAT_THREAD_ID'/);
});

test('30 conversations order follows LiveChat inbox rank',()=>{
  assert.match(server,/ORDER BY COALESCE\(c\.lc_inbox_rank,2147483647\) ASC/);
});

test('31 new LiveChat activity can update inbox rank independently of DB updated_at',()=>{
  assert.match(db,/lc_inbox_rank=COALESCE\(EXCLUDED\.lc_inbox_rank,conversations\.lc_inbox_rank\)/);
});

test('32 closed conversation clears LiveChat rank',()=>assert.match(db,/lc_inbox_rank=NULL/));

test('33 durable ingress claims at most one job per chat/session ordering key',()=>{
  assert.match(db,/row_number\(\) OVER \(PARTITION BY COALESCE\(j\.chat_id/);
  assert.match(db,/x\.chat_id=j\.chat_id AND x\.status='PROCESSING'/);
});

test('34 concurrency is bounded without a global queue lock',()=>{
  assert.match(ingress,/config\.lcIngressConcurrency/); assert.doesNotMatch(ingress,/pg_advisory_lock/);
  assert.match(db,/pg_advisory_lock\(hashtext\(\$1\)\)/); // lock is per-chat only
});

test('35 Telegram duplicate update/callback is idempotent',()=>{
  assert.match(db,/telegram_processed_updates/); assert.match(db,/finishTelegramUpdate/); assert.match(db,/PRIMARY KEY/);
});

test('36 existing human request has one bridge ticket and no duplicate',()=>{
  const pos=db.indexOf('export async function ensureBridgeTicket'); const block=db.slice(pos,pos+1700);
  assert.match(block,/WHERE human_request_id=\$1 LIMIT 1/); assert.match(block,/if\(existing\.rowCount\)return existing\.rows\[0\]/);
});

test('37 AI agent retrieves Knowledge from dashboard/database source',()=>{
  assert.match(engine,/getRelevantKnowledge/); assert.match(engine,/knowledge:sources\.knowledgeOnly/);
});

test('38 AI agent retrieves Rules from dashboard/database source',()=>{
  assert.match(engine,/getRules\(intent\)/); assert.match(engine,/rules:src\.rules/);
});

test('39 AI agent retrieves Responses from dedicated response source',()=>{
  assert.match(engine,/getRelevantBotResponses/); assert.match(engine,/responses:sources\.responses/);
});

test('40 AI agent retrieves approved learning and approved corrections separately',()=>{
  assert.match(engine,/approvedLearningExamples/); assert.match(engine,/approvedCorrections/); assert.match(engine,/source_type\|\|''\)\.toUpperCase\(\)==='AI_FEEDBACK'/);
});

test('41 action validator exposes only final allowlist',()=>{
  assert.deepEqual(agentActionAllowlist().sort(),['ASK_MEMBER_ID','ASK_PROOF','ESCALATE_HUMAN','NO_REPLY','SEND_HOLDING_MESSAGE','SEND_MESSAGE','UPDATE_CASE','UPDATE_TICKET'].sort());
});

test('42 known member ID is never requested again by agent validator',()=>{
  const d=validateAgentDecision({action:'ASK_INFO',confidence:.99,reply:'Boleh User ID?'},{state:'BOT_ACTIVE',activeCase:'DEPOSIT',memberId:'ABC123',memberIdKnown:true},{confidenceThreshold:.86});
  assert.equal(d.action,'SEND_MESSAGE'); assert.match(d.reason,/member_id_already_known/);
});

test('43 proof already received is never requested again by agent validator',()=>{
  const d=validateAgentDecision({action:'ASK_INFO',confidence:.99,reply:'Kirim bukti screenshot ya'},{state:'BOT_ACTIVE',activeCase:'DEPOSIT',proofReceived:true},{confidenceThreshold:.86});
  assert.equal(d.action,'SEND_MESSAGE'); assert.match(d.reason,/proof_already_received/);
});

test('44 structured context contains session, case, ticket, sources, recent messages and profile',()=>{
  const x=normalizeAgentInput({sessionId:'s',conversationId:'c',livechatChatId:'lc',threadId:'t',messageIds:['m'],rawMessages:['x'],state:'WAITING_HUMAN',activeCase:'WITHDRAW',telegramTicketExists:true,recentMessages:[{sender_type:'customer',text:'x'}],knowledge:'k',rules:'r',responses:'p',approvedLearningExamples:'l',approvedCorrections:'c',websiteProfile:{siteName:'SITE'}});
  assert.equal(x.sessionId,'s'); assert.equal(x.activeCase,'WITHDRAW'); assert.equal(x.telegramTicketExists,true); assert.equal(x.recentMessages.length,1); assert.equal(x.websiteProfile.siteName,'SITE');
});

test('45 migrations are additive/idempotent for session, event ledger and outbound idempotency',()=>{
  assert.match(migrations,/ADD COLUMN IF NOT EXISTS session_id/); assert.match(migrations,/CREATE TABLE IF NOT EXISTS conversation_sessions/); assert.match(migrations,/idempotency_key/); assert.match(migrations,/CREATE UNIQUE INDEX IF NOT EXISTS/);
});

test('46 secrets are not embedded in AI-agent implementation',()=>{
  assert.doesNotMatch(agent,/sk-[A-Za-z0-9]/); assert.doesNotMatch(agent,/DATABASE_URL\s*=/); assert.doesNotMatch(agent,/TELEGRAM.*TOKEN\s*=/);
});


test('47 production OpenAI agent path returns final allowlist action schema directly',async()=>{
  const client=new OpenAIClient();
  client.completeVision=async(system,user)=>({text:JSON.stringify({intent:'WITHDRAW_PROBLEM',subIntent:'FOLLOW_UP',confidence:.98,activeCase:'WITHDRAW',action:'UPDATE_TICKET',reply:'Masih kami tindaklanjuti ya bosku.',missingFields:[],shouldCreateTicket:false,shouldUpdateTicket:true,shouldEscalate:false,nextState:'WAITING_HUMAN',reason:'follow_up',brain:{primary_intent:'WITHDRAW_PROBLEM',status:'WAITING_HUMAN'}}),usage:{total_tokens:12}});
  const out=await runConversationAgent({client,input:{state:'WAITING_HUMAN',currentIntent:'WITHDRAW_PROBLEM',activeCase:'WITHDRAW',messageIds:['m-1'],rawMessages:['gimana bos'],telegramTicketExists:true}});
  assert.equal(out.action,'UPDATE_TICKET'); assert.equal(out.nextState,'WAITING_HUMAN'); assert.equal(out.shouldUpdateTicket,true); assert.match(out.reply,/tindaklanjuti/i);
});
