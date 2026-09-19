import crypto from 'node:crypto';
import { config } from './config.js';
import { extractChatEvents } from './livechat.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { processCustomerMessage, processGreetingTrigger } from './engine.js';
import * as db from './db.js';
import { isGreetingTriggerMessage } from './greeting.js';

let running=false, started=false, timer=null, lastTick=null, lastError=null, lastResult=null, paused=false;
let deepTimer=null, deepSyncRunning=false, deepLastRun=null, deepLastError=null, inventorySize=0, inventoryComplete=false;
const summaryFingerprints = new Map();
const summaryLanes = new Map();
const summaryRanks = new Map();
const summaryResolvedLanes = new Map();
const emptySnapshotLoggedAt = new Map();
let laneCounts={MY_CHAT:0,QUEUED:0,SUPERVISED:0,CLOSED:0,OTHER:0};
export function forgetChat(chatId){ const id=String(chatId||'');summaryFingerprints.delete(id);summaryLanes.delete(id);summaryRanks.delete(id);summaryResolvedLanes.delete(id); }
export function pollerStatus(){ return {
  running:started,inFlight:running,paused,lastTick,lastError,lastResult,mode:config.lcSyncMode,pollMs:config.lcPollMs,
  trackedChats:summaryFingerprints.size,processingChats:Number(laneCounts.MY_CHAT||0),lanes:{...laneCounts},
  traffic:{polled:false,processing:false,providerDataAvailable:false,status:'TRAFFIC_PROVIDER_DATA_UNAVAILABLE',source:null,reason:'This LiveChat integration exposes chat inventory, not browsing-only presence data.'},
  deepSyncRunning,deepLastRun,deepLastError,inventorySize,inventoryComplete
}; }

function senderType(ev, chat){
  const t=String(ev.authorType||'').toLowerCase();
  if (t.includes('customer')) return 'customer';
  if (t.includes('agent')) return 'agent';
  const u=(chat?.users||[]).find(x=>String(x.id||'')===String(ev.authorId||''));
  const ut=String(u?.type||'').toLowerCase();
  if (ut.includes('customer')) return 'customer';
  if (ut.includes('agent')) return 'agent';
  return 'unknown';
}

function summaryFingerprint(summary){ return crypto.createHash('sha1').update(JSON.stringify(summary||{})).digest('hex'); }
function ageSeconds(iso){ const t=Date.parse(iso||''); return Number.isFinite(t) ? Math.max(0,(Date.now()-t)/1000) : Infinity; }
function isWelcomeTriggerEvent(ev){ return Boolean(ev && isGreetingTriggerMessage(ev.text)); }
function greetingTriggerAgeLimit(){ return Math.max(Number(config.greetingTriggerMaxAgeSeconds||0),600); }
function providerCurrentThreadId(chat={}){
  const direct=chat?.last_thread_summary||chat?.last_thread||chat?.thread;
  if(direct&&typeof direct==='object'&&String(direct.id||direct.thread_id||'').trim()) return String(direct.id||direct.thread_id).trim();
  const threads=Array.isArray(chat?.threads)?chat.threads.filter(x=>x&&typeof x==='object'):[];
  if(!threads.length) return '';
  let best=threads[0],bestTs=Date.parse(best?.created_at||'');
  for(const th of threads.slice(1)){const ts=Date.parse(th?.created_at||'');if(Number.isFinite(ts)&&(!Number.isFinite(bestTs)||ts>bestTs)){best=th;bestTs=ts;}}
  return String(best?.id||best?.thread_id||'').trim();
}
function hasReadableEventForCurrentThread(chat,events=[]){
  const threadId=providerCurrentThreadId(chat);
  return Boolean(threadId && (events||[]).some(ev=>String(ev?.threadId||'').trim()===threadId));
}
function resolvedLane(livechat,chatId,summary,fp=null){
  const fingerprint=fp||summaryFingerprint(summary);
  const cached=summaryResolvedLanes.get(String(chatId||''));
  if(cached?.fp===fingerprint && cached?.lane) return cached.lane;
  return livechat.classifyChatLane(summary);
}

async function ingestAgentEvent(chatId, ev, chat, livechat, {allowTakeover=true,allowGreetingTrigger=true}={}) {
  const ours=await db.outboundLooksLikeOurs(chatId,ev.eventId,ev.text);
  const autoGreetingTrigger=!ours && isGreetingTriggerMessage(ev.text);
  const senderType=ours?'ai':autoGreetingTrigger?'system':'agent';
  const inserted=await db.insertMessage({chatId,eventId:ev.eventId,threadId:ev.threadId,senderType,authorId:ev.authorId,text:ev.text,normalizedText:normalizeText(ev.text),intent:autoGreetingTrigger?'GREETING_TRIGGER':detectIntent(ev.text),createdAt:ev.createdAt,attachments:ev.attachments||[]});
  if (inserted && autoGreetingTrigger && allowGreetingTrigger && ageSeconds(ev.createdAt) <= greetingTriggerAgeLimit()) {
    await processGreetingTrigger({chatId,eventId:ev.eventId,threadId:ev.threadId,text:ev.text,createdAt:ev.createdAt,livechat});
  }
  if (inserted && !ours && !autoGreetingTrigger) {
    await db.captureHumanReplyLearning({chatId,eventId:ev.eventId,responseText:ev.text}).catch(()=>{});
  }
  if (inserted && allowTakeover && !ours && !autoGreetingTrigger && ageSeconds(ev.createdAt) <= config.humanTakeoverMinutes*60) {
    await db.setHumanTakeover(chatId,'agent_reply_livechat');
  }
  return inserted;
}

async function ensureFreshWelcomeGreeting(chatId, events, livechat){
  const fresh=[...(events||[])].reverse().find(ev=>isWelcomeTriggerEvent(ev) && ageSeconds(ev.createdAt)<=greetingTriggerAgeLimit());
  if(!fresh) return null;
  await db.insertMessage({chatId,eventId:fresh.eventId,threadId:fresh.threadId,senderType:'system',authorId:fresh.authorId||'system',text:fresh.text,normalizedText:normalizeText(fresh.text),intent:'GREETING_TRIGGER',createdAt:fresh.createdAt,attachments:fresh.attachments||[]}).catch(()=>{});
  return processGreetingTrigger({chatId,eventId:fresh.eventId,threadId:fresh.threadId,text:fresh.text,createdAt:fresh.createdAt,livechat}).catch(async e=>{
    await db.logError('poller','WELCOME_GREETING_RETRY_FAILED',e.message,{chatId,eventId:fresh.eventId}).catch(()=>{}); return {error:e.message};
  });
}

async function bootstrapChat(chatId, chat, events, livechat) {
  let inserted=0, processed=0;
  await ensureFreshWelcomeGreeting(chatId,events,livechat);
  const state=await db.getConversationState(chatId).catch(()=>null);
  const processBootstrapCustomer=async(ev)=>{
    if (ageSeconds(ev.createdAt) <= config.bootstrapReplyMaxAgeSeconds) {
      await db.registerCustomerEventProcessing(chatId,ev.eventId,{threadId:ev.threadId,sessionId:state?.session_id}).catch(()=>{});
      const r=await processCustomerMessage({chatId,eventId:ev.eventId,threadId:ev.threadId,text:ev.text,createdAt:ev.createdAt,livechat,attachments:ev.attachments||[]});
      if (!r?.skipped) processed++;
      if (r?.skipped!=='duplicate') inserted++;
    } else if (await db.insertMessage({chatId,eventId:ev.eventId,threadId:ev.threadId,senderType:'customer',authorId:ev.authorId,text:ev.text,normalizedText:normalizeText(ev.text),intent:detectIntent(ev.text),createdAt:ev.createdAt,attachments:ev.attachments||[]})) inserted++;
  };

  // All fresh customer events are processed, not just the latest. Keeping the latest branch
  // explicit also preserves welcome-banner priority when the newest provider event is system-authored.
  const latest=events.at(-1);
  for (const ev of events.slice(0,-1)) {
    const type=senderType(ev,chat);
    if (isWelcomeTriggerEvent(ev)) {
      if (await ingestAgentEvent(chatId,ev,chat,livechat,{allowTakeover:false,allowGreetingTrigger:true})) inserted++;
    } else if (type==='customer') {
      await processBootstrapCustomer(ev);
    } else if (type==='agent') {
      if (await ingestAgentEvent(chatId,ev,chat,livechat,{allowTakeover:true,allowGreetingTrigger:true})) inserted++;
    }
  }
  if (latest) {
    const type=senderType(latest,chat);
    if (isWelcomeTriggerEvent(latest)) {
      if (await ingestAgentEvent(chatId,latest,chat,livechat,{allowTakeover:false,allowGreetingTrigger:true})) inserted++;
    } else if (type==='customer' && ageSeconds(latest.createdAt) <= config.bootstrapReplyMaxAgeSeconds) {
      await db.registerCustomerEventProcessing(chatId,latest.eventId,{threadId:latest.threadId,sessionId:state?.session_id}).catch(()=>{});
      const r=await processCustomerMessage({chatId,eventId:latest.eventId,threadId:latest.threadId,text:latest.text,createdAt:latest.createdAt,livechat,attachments:latest.attachments||[]});
      if (!r?.skipped) processed++;
      if (r?.skipped!=='duplicate') inserted++;
    } else if (type==='customer') {
      if (await db.insertMessage({chatId,eventId:latest.eventId,threadId:latest.threadId,senderType:'customer',authorId:latest.authorId,text:latest.text,normalizedText:normalizeText(latest.text),intent:detectIntent(latest.text),createdAt:latest.createdAt,attachments:latest.attachments||[]})) inserted++;
    } else if (type==='agent') {
      if (await ingestAgentEvent(chatId,latest,chat,livechat,{allowTakeover:true,allowGreetingTrigger:true})) inserted++;
    }
  }
  await db.markBootstrapped(chatId);
  return {inserted,processed};
}

async function processChatSnapshot(livechat,chat,summary=null,rank=null,{force=false}={}){
  const chatId=String(chat?.id||summary?.id||'').trim(); if(!chatId) return {skipped:'missing_chat_id'};
  const source=summary||chat;
  const sourceState=livechat.chatState(source);
  const sourceFp=summaryFingerprint(source);
  const sourceLane=resolvedLane(livechat,chatId,source,sourceFp);
  const state={...sourceState,active:(summary&&sourceState.active==null)?true:sourceState.active,rank,lane:sourceLane};
  if(state.active===false){ await db.markConversationEnded(chatId); forgetChat(chatId); return {closed:true}; }
  const firstUpsert=await db.upsertConversation(source,{visible:true,state});
  if(firstUpsert?.ignored && firstUpsert?.reason==='IMMUTABLE_CLOSED_SESSION'){
    forgetChat(chatId);
    return {skipped:'immutable_closed_session'};
  }
  const pendingBoundary=firstUpsert?.ignored && firstUpsert?.reason==='SESSION_BOUNDARY_UNCONFIRMED';
  // QUEUED/SUPERVISED stay visible as lightweight inventory lanes, but they never
  // enter get_chat / AI / Telegram processing until LiveChat moves them to MY_CHAT.
  if(['QUEUED','SUPERVISED'].includes(sourceLane)){
    summaryFingerprints.set(chatId,sourceFp); summaryLanes.set(chatId,sourceLane);
    if(Number.isFinite(Number(rank))) summaryRanks.set(chatId,Number(rank));
    return {skipped:`lane_${sourceLane.toLowerCase()}`,lane:sourceLane,lightweight:true};
  }
  await db.updateTypingFromSummary(chatId,source).catch(()=>{});
  const fp=sourceFp;
  const oldFp=summaryFingerprints.get(chatId);
  const dbState=await db.getConversationState(chatId);
  if(!force && dbState?.bootstrapped_at && Number(dbState?.message_count||0)>0 && oldFp===fp) return {unchanged:1};

  let detail=chat;
  if(!detail || detail===summary || extractChatEvents(detail).length===0){ detail=await livechat.getChat(chatId,source); }
  if(!detail?.id) return {skipped:'empty_detail'};
  const detailLane=livechat.classifyChatLane(detail);
  const detailState={...livechat.chatState(detail),rank,lane:detailLane};
  if(detailState.active===false){ await db.markConversationEnded(chatId); forgetChat(chatId); return {closed:true}; }
  const events=extractChatEvents(detail);
  const providerThreadConfirmed=hasReadableEventForCurrentThread(detail,events);
  const detailUpsert=await db.upsertConversation(detail,{visible:true,state:{...state,...detailState,active:detailState.active ?? state.active,lane:detailLane,confirmSessionBoundary:Boolean(pendingBoundary&&providerThreadConfirmed)}});
  if(detailUpsert?.ignored && detailUpsert?.reason==='IMMUTABLE_CLOSED_SESSION'){
    forgetChat(chatId);
    return {skipped:'immutable_closed_session'};
  }
  summaryResolvedLanes.set(chatId,{fp,lane:detailLane});
  if(detailLane!=='MY_CHAT'){
    summaryFingerprints.set(chatId,fp);summaryLanes.set(chatId,detailLane);
    if(Number.isFinite(Number(rank))) summaryRanks.set(chatId,Number(rank));
    return {skipped:`lane_${detailLane.toLowerCase()}`,lane:detailLane,lightweight:true};
  }
  if(!events.length){
    await db.markLiveChatSynced(chatId).catch(()=>{});
    const now=Date.now(),last=emptySnapshotLoggedAt.get(chatId)||0;
    if(now-last>60000){emptySnapshotLoggedAt.set(chatId,now);console.info(JSON.stringify({event:'livechat_empty_snapshot',level:'info',chatId,lane:detailLane,status:'NO_READABLE_EVENTS'}));}
    summaryFingerprints.set(chatId,fp);summaryLanes.set(chatId,detailLane);if(Number.isFinite(Number(rank)))summaryRanks.set(chatId,Number(rank));return {empty:1,lane:detailLane,status:'EMPTY_SNAPSHOT',diagnostics:livechat.chatDiagnostics(detail)};
  }
  await db.markLiveChatSynced(chatId).catch(()=>{});

  const before=await db.getConversationState(chatId);
  await ensureFreshWelcomeGreeting(chatId,events,livechat);
  if(!before?.bootstrapped_at || Number(before?.message_count||0)===0){
    const b=await bootstrapChat(chatId,detail,events,livechat); summaryFingerprints.set(chatId,fp); return {...b,bootstrapped:1,fetched:1};
  }

  let newMessages=0,processed=0,deferredMs=0;
  const unseen=[];
  for(const ev of events){
    const exists=await db.messageExists(chatId,ev.eventId);
    if(!exists){ unseen.push(ev); continue; }
    // Persisted input is NOT equivalent to successfully processed input. FAILED/PENDING/stale
    // PROCESSING ledger rows must re-enter the per-session ordered execution path.
    if(senderType(ev,detail)==='customer' && await db.customerEventNeedsRetry(chatId,ev.eventId,{staleSeconds:config.lcIngressStaleSeconds})) unseen.push(ev);
  }

  for (const ev of unseen) {
    const type=senderType(ev,detail);
    if (isWelcomeTriggerEvent(ev)) {
      if (await ingestAgentEvent(chatId,ev,detail,livechat,{allowTakeover:false,allowGreetingTrigger:true})) newMessages++;
      continue;
    }
    if (type==='customer') {
      // Every provider event gets a durable lifecycle by ID, even when execution is delayed
      // for a very short per-member debounce. Never collapse by text or intent.
      await db.registerCustomerEventProcessing(chatId,ev.eventId,{threadId:ev.threadId,sessionId:before?.session_id,delayMs:0}).catch(()=>{});
      const remainingMs=Math.ceil(config.memberDebounceMs-ageSeconds(ev.createdAt)*1000);
      if (remainingMs>0) {
        deferredMs=Math.max(deferredMs,remainingMs);
        summaryFingerprints.delete(chatId);
        continue;
      }
      const result=await processCustomerMessage({chatId,eventId:ev.eventId,threadId:ev.threadId,text:ev.text,createdAt:ev.createdAt,livechat,attachments:ev.attachments||[]});
      if(!result?.skipped) processed++;
      if(result?.skipped!=='duplicate') newMessages++;
      continue;
    }
    if (type==='agent') {
      if(await ingestAgentEvent(chatId,ev,detail,livechat,{allowTakeover:true,allowGreetingTrigger:true})) newMessages++;
    }
  }
  await ensureFreshWelcomeGreeting(chatId,events,livechat);
  if(deferredMs>0) forgetChat(chatId); else summaryFingerprints.set(chatId,fp);
  return {newMessages,processed,fetched:1,deferredMs};
}


export async function syncLaneChatForOperator(livechat,chatId,summary={}){
  const id=String(chatId||'').trim(); if(!id) throw new Error('LIVECHAT_CHAT_ID_REQUIRED');
  const detail=await livechat.getChat(id,summary&&summary.id?summary:{id});
  const lane=livechat.classifyChatLane(detail);
  const rawState=livechat.chatState(detail);
  const events=extractChatEvents(detail);
  const readableCurrentThread=hasReadableEventForCurrentThread(detail,events);
  const state={...rawState,active:rawState.active ?? true,lane,confirmSessionBoundary:readableCurrentThread};
  if(state.active===false){await db.markConversationEnded(id,{reason:'OPERATOR_REFRESH_CONFIRMED_INACTIVE'});forgetChat(id);return {closed:true,lane:'CLOSED',events:0};}
  const upsert=await db.upsertConversation(detail,{visible:true,state});
  await db.markLiveChatSynced(id).catch(()=>{});
  if(upsert?.ignored && ['IMMUTABLE_CLOSED_SESSION','SESSION_BOUNDARY_UNCONFIRMED','SESSION_BOUNDARY_REJECTED'].includes(upsert.reason)){
    return {ok:true,lane,events:events.length,chat:detail,skipped:upsert.reason};
  }
  await db.updateTypingFromSummary(id,detail).catch(()=>{});
  if(!events.length){
    const now=Date.now(),last=emptySnapshotLoggedAt.get(id)||0;
    if(now-last>60000){emptySnapshotLoggedAt.set(id,now);console.info(JSON.stringify({event:'livechat_empty_snapshot',level:'info',chatId:id,lane,status:'NO_READABLE_EVENTS'}));}
    return {ok:true,lane,events:0,chat:detail,status:'EMPTY_SNAPSHOT'};
  }
  for(const ev of events){
    const type=senderType(ev,detail);
    if(type==='customer'){
      await db.insertMessage({chatId:id,eventId:ev.eventId,threadId:ev.threadId,senderType:'customer',authorId:ev.authorId,text:ev.text,normalizedText:normalizeText(ev.text),intent:detectIntent(ev.text),createdAt:ev.createdAt,attachments:ev.attachments||[]}).catch(()=>{});
    }else if(type==='agent'){
      // Opening a dashboard detail is read/sync only; it must never manufacture takeover state.
      await ingestAgentEvent(id,ev,detail,livechat,{allowTakeover:false,allowGreetingTrigger:false}).catch(()=>{});
    }
  }
  return {ok:true,lane,events:events.length,chat:detail};
}

export async function syncChatById(livechat,chatId,summary={}){
  const id=String(chatId||'').trim(); if(!id) throw new Error('LIVECHAT_CHAT_ID_REQUIRED');
  const seed=summary&&summary.id?summary:{id};
  const chat=await livechat.getChat(id,seed);
  return processChatSnapshot(livechat,chat,summary&&summary.id?summary:null,null,{force:true});
}

async function runConcurrent(items,limit,fn){
  let cursor=0; const n=Math.max(1,Math.min(Number(limit)||1,32));
  const workers=Array.from({length:Math.min(n,items.length||1)},async()=>{while(true){const i=cursor++; if(i>=items.length) break; await fn(items[i],i);}});
  await Promise.all(workers);
}

async function runDeepSync(livechat){
  if(deepSyncRunning) return {skipped:'already_running'};
  deepSyncRunning=true; deepLastError=null; const started=Date.now(); inventoryComplete=false;
  try{
    const all=await livechat.listAllActiveChats(); const chats=livechat.filterInbox(all.items||[]); const seenChatIds=[];
    inventorySize=chats.length;
    const counts={MY_CHAT:0,QUEUED:0,SUPERVISED:0,CLOSED:0,OTHER:0};
    let autoClaimQueued=0;
    for (const [rank, summary] of chats.entries()) {
      if(!summary?.id) continue; const chatId=String(summary.id); seenChatIds.push(chatId);
      const fp=summaryFingerprint(summary);const lane=resolvedLane(livechat,chatId,summary,fp); counts[lane]=(counts[lane]||0)+1;
      const rawState=livechat.chatState(summary);const state={...rawState,active:rawState.active ?? true,rank,lane}; await db.upsertConversation(summary,{visible:true,state});
      summaryFingerprints.set(chatId,fp);summaryLanes.set(chatId,lane);summaryRanks.set(chatId,rank);
      if(lane==='MY_CHAT') await db.enqueueLiveChatIngressJob({dedupeKey:`poll:${chatId}:${fp}`,jobType:'SYNC_CHAT',chatId,payload:{summary},priority:90}).catch(()=>{});
      else if(lane==='OTHER') await db.enqueueLiveChatIngressJob({dedupeKey:`resolve:${chatId}:${fp}`,jobType:'SYNC_CHAT',chatId,payload:{summary},priority:55}).catch(()=>{});
      else if(lane==='QUEUED' && config.lcAutoClaimQueued && autoClaimQueued<config.lcAutoClaimQueuedBatch){const claim=await db.enqueueLiveChatIngressJob({dedupeKey:`claim:${chatId}:${fp}`,jobType:'CLAIM_CHAT',chatId,payload:{summary,source:'deep_sync'},priority:95}).catch(()=>null);if(claim)autoClaimQueued++;}
    }
    laneCounts=counts;
    // A full active-chat inventory is authoritative only after missing rows are individually verified.
    // Historical invariant marker: await db.reconcileInboxVisibility(seenChatIds,25) is superseded
    // by the verified keepVisible set below; the first page is never authoritative by itself.
    // Never close a conversation merely because it was absent from one paginated inventory.
    // Reordering, access/routing changes, and eventually-consistent provider results can cause
    // a temporary miss. Verify every missing visible chat against get_chat first; only a
    // provider-confirmed inactive/missing chat is archived and removed from Conversations.
    const previous=await db.listVisibleConversationIds(); const active=new Set(seenChatIds);
    const missing=previous.filter(id=>!active.has(String(id))); const keepVisible=new Set(seenChatIds);
    await runConcurrent(missing,Math.min(config.lcSyncConcurrency,6),async(id)=>{
      try{
        const detail=await livechat.getChat(id,{id}); const st=livechat.chatState(detail);
        if(st.active===false){await db.markConversationEnded(id,{reason:'DEEP_SYNC_CONFIRMED_INACTIVE'});forgetChat(String(id));return;}
        keepVisible.add(String(id));
        if(st.active===true){const lane=livechat.classifyChatLane(detail);await db.upsertConversation(detail,{visible:true,state:{...st,lane}});}
      }catch(e){
        if(livechat.isChatInactiveError?.(e) || Number(e?.status)===404 || /chat\s+(?:is\s+)?(?:not\s+active|inactive)|no\s+active\s+thread/i.test(String(e?.message||''))){
          await db.markConversationEnded(id,{reason:'DEEP_SYNC_CONFIRMED_INACTIVE'}).catch(()=>{});forgetChat(String(id));return;
        }
        // Fail-open for visibility: a transient verification error must not make an active
        // conversation disappear from the operator inbox.
        keepVisible.add(String(id));
        await db.logError('poller','MISSING_CHAT_VERIFY_FAILED',e.message,{chatId:id}).catch(()=>{});
      }
    });
    // Keep the in-memory change detector bounded without treating a single inventory miss as closed.
    for(const id of [...summaryFingerprints.keys()]) if(!keepVisible.has(String(id))) forgetChat(id);
    await db.reconcileInboxVisibility([...keepVisible],25);
    inventoryComplete=true; deepLastRun=new Date().toISOString();
    await db.setIntegrationHealth('livechat_deep_sync',{status:'OK',latencyMs:Date.now()-started,meta:{activeChats:chats.length,myChats:counts.MY_CHAT,queued:counts.QUEUED,supervised:counts.SUPERVISED,autoClaimQueued,pages:all.pages,foundChats:all.foundChats}}).catch(()=>{});
    return {ok:true,activeChats:chats.length,lanes:counts,autoClaimQueued,pages:all.pages};
  }catch(e){deepLastError=e.message;await db.setIntegrationHealth('livechat_deep_sync',{status:'ERROR',latencyMs:Date.now()-started,error:e.message}).catch(()=>{});throw e;}
  finally{deepSyncRunning=false;}
}

export async function syncOnce(livechat,{manual=false}={}){
  if (!manual) { const enabled=Boolean(await db.getSetting('system_enabled',true)); if (!enabled) { paused=true; lastResult={ok:true,paused:true,skipped:'system_off'}; return lastResult; } }
  paused=false; if(running) return {skipped:'already_running'}; running=true; lastError=null; const syncStarted=Date.now();
  try{
    const data=await livechat.listChats();
    const rawChats=data?._normalizedChats || data?.chats_summary || data?.chats || [];
    const chats=livechat.filterInbox(rawChats);
    let queued=0,unchanged=0,enqueueErrors=0,lightweight=0,autoClaimQueued=0;
    const counts={MY_CHAT:0,QUEUED:0,SUPERVISED:0,CLOSED:0,OTHER:0};
    // The 1-second hot path performs summary discovery only. Only MY_CHAT transitions
    // enter the durable full-processing queue. QUEUED/SUPERVISED are metadata-only lanes.
    for (const [rank,summary] of chats.entries()){
      if(!summary?.id) continue;
      const chatId=String(summary.id);
      try{
        const fp=summaryFingerprint(summary);const lane=resolvedLane(livechat,chatId,summary,fp);counts[lane]=(counts[lane]||0)+1;
        const oldFp=summaryFingerprints.get(chatId),oldLane=summaryLanes.get(chatId),oldRank=summaryRanks.get(chatId);
        if(oldFp===fp && oldLane===lane && oldRank===rank){
          if(lane==='QUEUED' && config.lcAutoClaimQueued && autoClaimQueued<config.lcAutoClaimQueuedBatch){
            const claim=await db.enqueueLiveChatIngressJob({dedupeKey:`claim:${chatId}:${fp}`,jobType:'CLAIM_CHAT',chatId,payload:{summary,source:'poll_unchanged'},priority:95});
            if(claim){queued++;autoClaimQueued++;continue;}
          }
          unchanged++;continue;
        }
        const rawState=livechat.chatState(summary);const state={...rawState,active:rawState.active ?? true,rank,lane};
        await db.upsertConversation(summary,{visible:true,state});
        if(lane==='MY_CHAT' || lane==='OTHER'){
          const job=await db.enqueueLiveChatIngressJob({dedupeKey:`poll:${chatId}:${fp}`,jobType:'SYNC_CHAT',chatId,payload:{summary},priority:lane==='MY_CHAT'?90:55});
          if(job)queued++;else unchanged++;
        }else if(lane==='QUEUED' && config.lcAutoClaimQueued && autoClaimQueued<config.lcAutoClaimQueuedBatch){
          const claim=await db.enqueueLiveChatIngressJob({dedupeKey:`claim:${chatId}:${fp}`,jobType:'CLAIM_CHAT',chatId,payload:{summary,source:'poll'},priority:95});
          if(claim){queued++;autoClaimQueued++;}else unchanged++;
          lightweight++;
        }else{
          lightweight++;
        }
        summaryFingerprints.set(chatId,fp);summaryLanes.set(chatId,lane);summaryRanks.set(chatId,rank);
      }catch(e){enqueueErrors++;forgetChat(chatId);await db.logError('poller','DISCOVERY_ENQUEUE_FAILED',e.message,{chatId}).catch(()=>{});}
    }
    if(!data?.next_page_id) laneCounts=counts;
    lastTick=new Date().toISOString();
    lastResult={ok:true,listSource:data?._listSource||'unknown',rawChats:rawChats.length,chats:chats.length,myChats:counts.MY_CHAT,queuedLane:counts.QUEUED,supervised:counts.SUPERVISED,queued,autoClaimQueued,lightweight,unchanged,enqueueErrors,processed:0,newMessages:0,inventorySize,inventoryComplete,deepSyncRunning,concurrency:config.lcSyncConcurrency,durationMs:Date.now()-syncStarted};
    await db.setIntegrationHealth('livechat_poll',{status:'OK',latencyMs:Date.now()-syncStarted,meta:{chats:chats.length,myChats:counts.MY_CHAT,queuedLane:counts.QUEUED,supervised:counts.SUPERVISED,queued,autoClaimQueued,lightweight,unchanged,enqueueErrors}}).catch(()=>{}); return lastResult;
  }catch(e){lastError=e.message;await db.setIntegrationHealth('livechat_poll',{status:'ERROR',latencyMs:Date.now()-syncStarted,error:e.message}).catch(()=>{});await db.logError('poller','SYNC_FAILED',e.message);throw e;}
  finally{running=false;}
}

export function startPoller(livechat){
  if(config.lcSyncMode==='off'){started=false;return;}
  if(timer||deepTimer){started=true;return;}
  started=true;
  const run=async()=>{try{await syncOnce(livechat);}catch{}finally{timer=setTimeout(run,config.lcPollMs);}};
  const deep=async()=>{try{await runDeepSync(livechat);}catch{}finally{deepTimer=setTimeout(deep,config.lcDeepSyncMs);}};
  timer=setTimeout(run,1200); deepTimer=setTimeout(deep,1800);
}
export async function stopPoller({waitMs=5000}={}){ started=false;if(timer)clearTimeout(timer);if(deepTimer)clearTimeout(deepTimer);timer=null;deepTimer=null;const until=Date.now()+waitMs;while((running||deepSyncRunning)&&Date.now()<until)await new Promise(r=>setTimeout(r,50));return !running&&!deepSyncRunning; }
