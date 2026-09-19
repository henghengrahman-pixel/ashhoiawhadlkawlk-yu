import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LiveChatClient} from '../src/livechat.js';

const src=(p)=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const make=()=>new LiveChatClient({base:'https://example.test',accountId:'acct',pat:'pat',requesterUserId:'bot@example.com',inboxMode:'all_active'});

function err(status,message){const e=new Error(message);e.status=status;return e;}

test('v1.33.4 strict classifier never guesses MY_CHAT without ownership signal',()=>{
  const lc=make();
  assert.equal(lc.classifyChatLane({id:'x',last_thread_summary:{active:true}}),'OTHER');
  assert.equal(lc.classifyChatLane({id:'x',is_followed:true,last_thread_summary:{active:true}}),'OTHER');
  assert.equal(lc.classifyChatLane({id:'x',is_followed:true,users:[{id:'bot@example.com'}],last_thread_summary:{active:true}}),'MY_CHAT');
});

test('v1.33.4 queued claim uses follow + membership + detail and becomes claimable',async()=>{
  const lc=make(); const calls=[];
  lc.call=async(action,body)=>{calls.push({action,body});if(action==='follow_chat')return{};if(action==='add_user_to_chat')return{};if(action==='get_chat')return{chat:{id:'q1',is_followed:true,users:[{id:'bot@example.com'}],threads:[{active:true,events:[]}]}};throw new Error(action)};
  const out=await lc.claimChat('q1');
  assert.equal(out.ok,true);assert.equal(out.lane,'MY_CHAT');
  assert.deepEqual(calls.map(x=>x.action),['follow_chat','add_user_to_chat','get_chat']);
});

test('v1.33.4 public-agent-limit rolls back follow so chat cannot masquerade as MY_CHAT',async()=>{
  const lc=make();const calls=[];
  lc.call=async(action)=>{calls.push(action);if(action==='follow_chat'||action==='unfollow_chat')return{};if(action==='add_user_to_chat')throw err(422,'Public agents in chat limit reached');throw new Error(action)};
  await assert.rejects(()=>lc.claimChat('q2'),/LIVECHAT_PUBLIC_AGENT_LIMIT/);
  assert.deepEqual(calls,['follow_chat','add_user_to_chat','unfollow_chat']);
});

test('v1.33.4 durable ingress has CLAIM_CHAT and provider-limit is nonfatal',()=>{
  const s=src('../src/livechat-ingress.js');
  assert.match(s,/type==='CLAIM_CHAT'/);
  assert.match(s,/livechat\.claimChat/);
  assert.match(s,/blocked:'PUBLIC_AGENT_LIMIT'/);
});

test('v1.33.4 AI final send gate requires MY_CHAT',()=>{
  const db=src('../src/db.js'),engine=src('../src/engine.js');
  assert.match(db,/requireMyChat=false/);
  assert.match(db,/String\(x\.lc_lane\|\|''\)\.toUpperCase\(\)==='MY_CHAT'/);
  assert.match(engine,/conversationCanReply\(chatId,\{requireMyChat:senderType==='ai'\}\)/);
});

test('v1.33.4 queued/supervised detail refresh is operator-only and does not invoke AI',()=>{
  const poller=src('../src/poller.js');
  assert.match(poller,/export async function syncLaneChatForOperator/);
  const block=poller.slice(poller.indexOf('export async function syncLaneChatForOperator'),poller.indexOf('export async function syncChatById'));
  assert.doesNotMatch(block,/processCustomerMessage/);
  assert.match(block,/insertMessage/);
});

test('v1.33.4 dashboard can claim queue/supervised for AI or HUMAN without external traffic redirect',()=>{
  const server=src('../src/server.js'),html=src('../public/pages/conversations.html'),js=src('../public/assets/js/pages/conversations.js');
  assert.match(server,/claimDashboardChat/);
  assert.match(server,/\/api\/conversations\/:id\/claim/);
  assert.match(server,/claimDashboardChat\(chatId\)/);
  assert.match(html,/data-lane="TRAFFIC"/);
  assert.doesNotMatch(html,/my\.livechatinc\.com\/engage\/traffic/);
  assert.match(js,/Handle with AI/);
  assert.match(js,/body:JSON\.stringify\(\{mode:'AI'\}\)/);
});

test('v1.33.4 API defaults /conversations to MY_CHAT so lane lists cannot mix accidentally',()=>{
  const server=src('../src/server.js');
  assert.match(server,/req\.query\.lane\|\|'MY_CHAT'/);
  assert.match(server,/upper\(trim\(coalesce\(c\.lc_lane,'OTHER'\)\)\)=\$7/);
  assert.doesNotMatch(server,/\$7='TRAFFIC'/);
  assert.match(server,/TRAFFIC_PROVIDER_DATA_UNAVAILABLE/);
});

test('v1.33.4 lane counts are normalized and Traffic is unavailable instead of aggregated',()=>{
  const server=src('../src/server.js');
  assert.match(server,/upper\(trim\(coalesce\(lc_lane,'OTHER'\)\)\) AS lc_lane/);
  assert.match(server,/laneCounts\.TRAFFIC=0/);
  assert.doesNotMatch(server,/laneCounts\.TRAFFIC\+=Number\(row\.count\|\|0\)/);
  assert.match(server,/providerDataAvailable:false,status:'TRAFFIC_PROVIDER_DATA_UNAVAILABLE'/);
});

test('v1.33.4 loose AI JSON parser repairs common model formatting defects without another API call',async()=>{
  const {parseJsonLoose}=await import('../src/ai.js');
  assert.deepEqual(parseJsonLoose('```json\n{"intent":"RTP_INFO", "reply":"ok",}\n```'),{intent:'RTP_INFO',reply:'ok'});
  assert.deepEqual(parseJsonLoose('{intent:"GENERAL", reply:"line1\nline2"}'),{intent:'GENERAL',reply:'line1\nline2'});
});
