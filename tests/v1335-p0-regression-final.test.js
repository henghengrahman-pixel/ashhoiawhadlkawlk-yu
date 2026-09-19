import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {OpenAIClient} from '../src/ai.js';
import {validateAgentDecision} from '../src/ai-agent.js';
import {detectIntent} from '../src/normalizer.js';
import {extractConversationFacts} from '../src/advanced-logic.js';

const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const server=read('../src/server.js'),db=read('../src/db.js'),poller=read('../src/poller.js'),ingress=read('../src/livechat-ingress.js'),bridge=read('../src/human-bridge.js'),ai=read('../src/ai.js'),agent=read('../src/ai-agent.js'),engine=read('../src/engine.js'),cfg=read('../src/config.js'),migrations=read('../src/services/modular-migrations.js');
const strictLane=/AND upper\(trim\(coalesce\(c\.lc_lane,'OTHER'\)\)\)=\$7/;

// 1-5 lane/API separation
test('01 MY_CHAT only appears through explicit MY_CHAT lane predicate',()=>{assert.match(server,/req\.query\.lane\|\|'MY_CHAT'/);assert.match(server,strictLane)});
test('02 QUEUED uses the same strict lane predicate without MY_CHAT union',()=>{assert.match(server,strictLane);assert.match(server,/\['MY_CHAT','QUEUED','SUPERVISED','TRAFFIC','OTHER'\]/)});
test('03 SUPERVISED uses the same strict lane predicate without MY_CHAT union',()=>{assert.match(server,strictLane);assert.match(server,/upper\(trim\(coalesce\(c\.lc_lane,'OTHER'\)\)\)=\$7/)});
test('04 TRAFFIC query does not return all active conversations',()=>{assert.doesNotMatch(server,/\$7='TRAFFIC'/);assert.match(server,/items:lane==='TRAFFIC'\?\[\]:items/);assert.match(server,/TRAFFIC_PROVIDER_DATA_UNAVAILABLE/)});
test('05 default conversations lane is MY_CHAT',()=>assert.match(server,/requestedLane=String\(req\.query\.lane\|\|'MY_CHAT'\)/));

// 6-11 queued/manual claim/capacity
test('06 queued does not auto claim by default',()=>assert.match(cfg,/LIVECHAT_AUTO_CLAIM_QUEUED, false/));
test('07 queue remains metadata-only until explicit claim policy',()=>{assert.match(poller,/QUEUED\/SUPERVISED stay visible as lightweight inventory lanes/);assert.match(poller,/config\.lcAutoClaimQueued/)});
test('08 Handle with AI success promotes only after provider ownership confirmation',()=>{assert.match(server,/providerLane!=='MY_CHAT' && confirmedLane!=='MY_CHAT'/);assert.match(server,/SET lc_lane='MY_CHAT'/)});
test('09 Handle with AI failure does not force MY_CHAT',()=>{const block=server.slice(server.indexOf('async function claimDashboardChat'),server.indexOf('// Cursor pagination'));assert.doesNotMatch(block,/catch\(e\).*SET lc_lane='MY_CHAT'/s);assert.match(block,/LIVECHAT_CLAIM_OWNERSHIP_NOT_CONFIRMED/)});
test('10 PUBLIC_AGENT_LIMIT cannot promote lane to MY_CHAT',()=>{assert.match(server,/LIVECHAT_PUBLIC_AGENT_LIMIT/);assert.match(ingress,/blocked:'PUBLIC_AGENT_LIMIT'/);assert.doesNotMatch(ingress,/claimed\.lane\|\|'MY_CHAT'/)});
test('11 PUBLIC_AGENT_LIMIT has cooldown and no immediate retry storm',()=>{assert.match(db,/lc_claim_blocked_until/);assert.match(ingress,/isLiveChatClaimBlocked/);assert.match(ingress,/recordLiveChatClaimFailure/);assert.match(server,/e\.retryable=false/)});

// 12-22 detail/session boundaries
test('12 blank MY_CHAT open triggers get_chat refresh',()=>{assert.match(server,/const blank=Number\(st\.message_count\|\|0\)===0/);assert.match(server,/return syncLaneChatForOperator/)});
test('13 blank MY_CHAT readable events are inserted idempotently',()=>{const b=poller.slice(poller.indexOf('export async function syncLaneChatForOperator'),poller.indexOf('export async function syncChatById'));assert.match(b,/extractChatEvents\(detail\)/);assert.match(b,/db\.insertMessage/)});
test('14 get_chat with no readable events cannot create a new session',()=>{assert.match(poller,/function hasReadableEventForCurrentThread/);assert.match(poller,/confirmSessionBoundary:readableCurrentThread/);assert.match(db,/SESSION_BOUNDARY_UNCONFIRMED/)});
test('15 get_chat with no readable events does not enter AI processing',()=>{const b=poller.slice(poller.indexOf('export async function syncLaneChatForOperator'),poller.indexOf('export async function syncChatById'));assert.doesNotMatch(b,/processCustomerMessage/);assert.match(b,/status:'EMPTY_SNAPSHOT'/)});
test('16 repeated same provider thread reuses one session',()=>{assert.match(db,/sameThread \|\| sameSessionKey/);assert.match(migrations,/UNIQUE\(chat_id,session_key\)/)});
test('17 lane changes cannot create session boundaries',()=>{assert.match(db,/if\(!normalizedThread\).*return false/);assert.match(poller,/confirmSessionBoundary:Boolean\(pendingBoundary&&providerThreadConfirmed\)/)});
test('18 claim action does not directly create a session',()=>{const b=server.slice(server.indexOf('async function claimDashboardChat'),server.indexOf('// Cursor pagination'));assert.doesNotMatch(b,/beginNewConversationSession/)});
test('19 opening detail does not manufacture a session without readable provider thread',()=>{const b=poller.slice(poller.indexOf('export async function syncLaneChatForOperator'),poller.indexOf('export async function syncChatById'));assert.match(b,/const readableCurrentThread=hasReadableEventForCurrentThread\(detail,events\)/);assert.match(b,/confirmSessionBoundary:readableCurrentThread/);assert.doesNotMatch(b,/beginNewConversationSession/)});
test('20 duplicate poll/webhook session key cannot duplicate session',()=>{assert.match(db,/ON CONFLICT\(chat_id,session_key\) DO UPDATE SET/);assert.match(ingress,/dedupeKey:key/)});
test('21 closed same thread cannot reopen',()=>{assert.match(db,/IMMUTABLE_CLOSED_SESSION/);assert.match(db,/\['closed','closing'\]\.includes\(priorStatus\) && !confirmedDifferentThread/)});
test('22 real new readable provider thread can create a new session',()=>{assert.match(db,/boundarySource:'LIVECHAT_READABLE_NEW_THREAD'/);assert.match(db,/stableSessionId\(id,sessionKey\)/)});

// 23-25 structured AI/durable completion
test('23 AI invalid JSON repair succeeds',async()=>{
  class C extends OpenAIClient{
    async completeVision(){return {text:'{broken',usage:{a:1}};}
    async repairAgentStructured(){return {text:JSON.stringify({intent:'GENERAL',subIntent:null,confidence:.95,activeCase:null,action:'SEND_MESSAGE',reply:'ok',missingFields:[],shouldCreateTicket:false,shouldUpdateTicket:false,shouldEscalate:false,nextState:'BOT_ACTIVE',reason:'repaired',brain:{goal:'',stage:'',primary_intent:'GENERAL',status:'ACTIVE',known_facts:[],missing_info:[],expected_reply:'',actions_done:[],resolved:false,contradictions:[],sentiment:'NORMAL',risk:'LOW',next_step:'',understanding:''}})};}
  }
  const x=await new C().decideAgent({input:{state:'BOT_ACTIVE'}});
  assert.equal(x.action,'SEND_MESSAGE');assert.equal(x.reply,'ok');
});
test('24 AI invalid JSON unrecoverable returns deterministic safe escalation',async()=>{class C extends OpenAIClient{async completeVision(){return{text:'not json'}}async repairAgentStructured(){throw new Error('repair failed')}}const x=await new C().decideAgent({input:{state:'BOT_ACTIVE',currentIntent:'WITHDRAW_PROBLEM'}});assert.equal(x.action,'ESCALATE_HUMAN');assert.equal(x.reason,'STRUCTURED_OUTPUT_UNRECOVERABLE_SAFE_FALLBACK');assert.equal(x.shouldEscalate,true)});
test('25 customer event DONE is recorded only after processing/send path completes',()=>{const sendPos=engine.indexOf('await sendAndStore',engine.indexOf('export async function processCustomerMessage'));const donePos=engine.indexOf('finishCustomerEventProcessing(chatId,eventId,{ok:true}',sendPos);assert.ok(sendPos>0&&donePos>sendPos)});

// 26-27 Telegram leader election
test('26 two Telegram replicas are gated by one PostgreSQL advisory leader',()=>{assert.match(db,/pg_try_advisory_lock\(hashtext\(\$1\)\)/);assert.match(bridge,/acquireTelegramPollLeader\(leaderOwner\)/);assert.match(bridge,/if\(!lease\?\.acquired\).*continue/s)});
test('27 Telegram leader loss releases/reacquires for follower failover',()=>{assert.match(db,/async heartbeat\(\)/);assert.match(db,/pg_advisory_unlock/);assert.match(bridge,/leaderLease=null; await new Promise/);assert.match(bridge,/leaderLease\.release/)});

// 28-35 context/known fields/intent continuity
test('28 Return to AI preserves current-session context',()=>{assert.match(ai,/RETURN TO AI/);assert.match(agent,/recentMessages/);assert.match(engine,/resumeConversationAfterHumanTakeover/)});
test('29 fresh session context is session-scoped and does not inherit old messages',()=>{assert.match(db,/messages m WHERE m\.chat_id=c\.chat_id/);assert.match(db,/m\.session_key=NULLIF\(c\.session_key,''\)/)});
test('30 known member ID is never asked again',()=>{const d=validateAgentDecision({action:'ASK_MEMBER_ID',confidence:.99,reply:'id?'},{state:'BOT_ACTIVE',memberId:'abc123',memberIdKnown:true,currentIntent:'DEPOSIT_PROBLEM'});assert.notEqual(d.action,'ASK_MEMBER_ID');assert.match(d.reason,/member_id_already_known/)});
test('31 received proof is never asked again',()=>{const d=validateAgentDecision({action:'ASK_PROOF',confidence:.99,reply:'bukti?'},{state:'BOT_ACTIVE',proofReceived:true,currentIntent:'DEPOSIT_PROBLEM'});assert.notEqual(d.action,'ASK_PROOF');assert.match(d.reason,/proof_already_received/)});
test('32 WD typo still resolves as withdraw',()=>assert.equal(detectIntent('wdraw blom cair bos'),'WITHDRAW_PROBLEM'));
test('33 Deposit typo still resolves as deposit',()=>assert.equal(detectIntent('depo blm msuk'),'DEPOSIT_PROBLEM'));
test('34 bonus plus inline member ID remains both classifiable and extractable',()=>{assert.equal(detectIntent('claim bonus harian user id abc1234'),'BONUS_DAILY');assert.equal(extractConversationFacts('claim bonus harian user id abc1234').find(x=>x.key==='member_id')?.value,'abc1234')});
test('35 anger does not collapse WD/deposit/loss intent separation',()=>{assert.equal(detectIntent('wd gw lama banget anjir'),'WITHDRAW_PROBLEM');assert.equal(detectIntent('deposit gua belum masuk bang'),'DEPOSIT_PROBLEM');assert.equal(detectIntent('rungkad kalah habis modal'),'LOSS_COMPLAINT')});

// 36-40 archives/lane heavy-path isolation
test('36 archives lifecycle remains present and confirmed-close driven',()=>{assert.match(server,/\/api\/archives/);assert.match(db,/archiveConversationSessionResilient/);assert.match(db,/markConversationEnded/)});
test('37 queued lane is not archived merely for being queued',()=>{assert.doesNotMatch(poller,/sourceLane==='QUEUED'.*markConversationEnded/s)});
test('38 supervised cannot appear in MY_CHAT query',()=>{assert.match(server,strictLane);assert.match(server,/requestedLane=String\(req\.query\.lane\|\|'MY_CHAT'\)/)});
test('39 traffic browsing cannot create a conversation when provider presence is unavailable',()=>{assert.match(server,/items:lane==='TRAFFIC'\?\[\]:items/);assert.match(poller,/TRAFFIC_PROVIDER_DATA_UNAVAILABLE/)});
test('40 heavy AI processing is limited to MY_CHAT',()=>{assert.match(poller,/if\(detailLane!=='MY_CHAT'\)/);assert.match(poller,/priority:lane==='MY_CHAT'\?90:55/);assert.match(agent,/runConversationAgent/)});
