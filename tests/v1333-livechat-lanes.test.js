import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LiveChatClient} from '../src/livechat.js';

const make=()=>new LiveChatClient({base:'https://example.test',accountId:'acct',pat:'pat',requesterUserId:'bot@example.com',inboxMode:'all_active'});

test('v1.33.3 lane classifier separates MY_CHAT QUEUED SUPERVISED and CLOSED',()=>{
  const lc=make();
  assert.equal(lc.classifyChatLane({id:'mine',is_followed:true,users:[{id:'bot@example.com',type:'agent'}],last_thread_summary:{active:true}}),'MY_CHAT');
  assert.equal(lc.classifyChatLane({id:'queue',is_followed:false,last_thread_summary:{active:true}}),'QUEUED');
  assert.equal(lc.classifyChatLane({id:'queue2',routing_status:'queued',last_thread_summary:{active:true}}),'QUEUED');
  assert.equal(lc.classifyChatLane({id:'sup',is_supervised:true,is_followed:true,last_thread_summary:{active:true}}),'SUPERVISED');
  assert.equal(lc.classifyChatLane({id:'closed',routing_status:'closed'}),'CLOSED');
});

test('v1.33.3 followed chat without requester membership becomes supervised when provider exposes users',()=>{
  const lc=make();
  const chat={id:'s1',is_followed:true,users:[{id:'human@example.com',type:'agent'},{id:'customer-1',type:'customer'}],last_thread_summary:{active:true}};
  assert.equal(lc.classifyChatLane(chat),'SUPERVISED');
});

test('v1.33.4 ambiguous provider response is OTHER until get_chat resolves ownership',()=>{
  const lc=make();
  assert.equal(lc.classifyChatLane({id:'legacy',last_thread_summary:{active:true}}),'OTHER');
  assert.equal(lc.classifyChatLane({id:'followed-no-users',is_followed:true,last_thread_summary:{active:true}}),'OTHER');
});

test('v1.33.4 hot poll isolates lanes and queued auto-claim is explicit opt-in only',()=>{
  const src=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
  const cfg=fs.readFileSync(new URL('../src/config.js',import.meta.url),'utf8');
  assert.match(src,/lane==='MY_CHAT' \|\| lane==='OTHER'/);
  assert.match(src,/jobType:'CLAIM_CHAT'/);
  assert.match(src,/lcAutoClaimQueuedBatch/);
  assert.match(src,/\['QUEUED','SUPERVISED'\]\.includes\(sourceLane\)/);
  assert.match(cfg,/LIVECHAT_AUTO_CLAIM_QUEUED, false/);
});

test('v1.33.4 traffic does not fake browsing presence from active chat inventory',()=>{
  const src=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
  assert.match(src,/TRAFFIC_PROVIDER_DATA_UNAVAILABLE/);
  assert.match(src,/providerDataAvailable:false/);
  assert.doesNotMatch(src,/source:'active_chat_inventory'/);
});

test('v1.33.3 migration stores indexed LiveChat lane without dropping existing schema',()=>{
  const src=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
  assert.match(src,/ADD COLUMN IF NOT EXISTS lc_lane TEXT NOT NULL DEFAULT 'OTHER'/);
  assert.match(src,/idx_conversations_lane_order/);
  assert.match(src,/lc_lane=EXCLUDED\.lc_lane/);
});

test('v1.33.4 conversations API defaults to MY_CHAT and Traffic never aliases all active chats',()=>{
  const src=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  assert.match(src,/req\.query\.lane\|\|'MY_CHAT'/);
  assert.match(src,/\['MY_CHAT','QUEUED','SUPERVISED','TRAFFIC','OTHER'\]/);
  assert.match(src,/upper\(trim\(coalesce\(c\.lc_lane,'OTHER'\)\)\)=\$7/);
  assert.doesNotMatch(src,/\$7='TRAFFIC'/);
  assert.match(src,/TRAFFIC_PROVIDER_DATA_UNAVAILABLE/);
  assert.match(src,/laneCounts=\{MY_CHAT:0,QUEUED:0,SUPERVISED:0,OTHER:0,TRAFFIC:0\}/);
});

test('v1.33.4 dashboard exposes MY/QUEUED/SUPERVISED/TRAFFIC internally and claim actions',()=>{
  const html=fs.readFileSync(new URL('../public/pages/conversations.html',import.meta.url),'utf8');
  const js=fs.readFileSync(new URL('../public/assets/js/pages/conversations.js',import.meta.url),'utf8');
  assert.match(html,/data-lane="MY_CHAT"/);
  assert.match(html,/data-lane="QUEUED"/);
  assert.match(html,/data-lane="SUPERVISED"/);
  assert.match(html,/data-lane="TRAFFIC"/);
  assert.doesNotMatch(html,/my\.livechatinc\.com\/engage\/traffic/);
  assert.match(html,/id="claimAiBtn"/);
  assert.match(js,/\/claim`/);
});

test('v1.33.3 5000-chat lane simulation keeps only MY_CHAT eligible for heavy processing',()=>{
  const lc=make();
  const chats=[];
  for(let i=0;i<5000;i++){
    if(i%10<2) chats.push({id:`m${i}`,is_followed:true,users:[{id:'bot@example.com',type:'agent'}],last_thread_summary:{active:true}});
    else if(i%10<7) chats.push({id:`q${i}`,is_followed:false,last_thread_summary:{active:true}});
    else chats.push({id:`s${i}`,is_followed:true,is_supervised:true,last_thread_summary:{active:true}});
  }
  const counts={MY_CHAT:0,QUEUED:0,SUPERVISED:0};
  for(const c of chats) counts[lc.classifyChatLane(c)]++;
  assert.deepEqual(counts,{MY_CHAT:1000,QUEUED:2500,SUPERVISED:1500});
  assert.equal(counts.MY_CHAT,1000);
});
