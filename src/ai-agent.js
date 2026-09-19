import { normalizeText, detectIntent } from './normalizer.js';

const ACTION_ALLOWLIST = new Set([
  'SEND_MESSAGE',
  'ASK_MEMBER_ID',
  'ASK_PROOF',
  'SEND_HOLDING_MESSAGE',
  'ESCALATE_HUMAN',
  'UPDATE_CASE',
  'UPDATE_TICKET',
  'NO_REPLY'
]);

const HUMAN_STATES = new Set(['HUMAN_ACTIVE','HUMAN_TAKEOVER']);

function arr(v, max=50){ return Array.isArray(v) ? v.slice(0,max) : []; }
function txt(v,max=4000){ return String(v??'').trim().slice(0,max); }
function bool(v){ return Boolean(v); }
function normState(v=''){ return String(v||'BOT_ACTIVE').trim().toUpperCase().replace(/[^A-Z0-9_]/g,'_') || 'BOT_ACTIVE'; }
const GENERIC_CASES=new Set(['','GENERAL','GREETING','UNKNOWN','NONE','NEW','ACKNOWLEDGEMENT','GRATITUDE','ABUSIVE','COMPLAINT']);
const PROMPT_RECENT_MAX=32;
const PROMPT_RECENT_TAIL=24;
const PROMPT_ANCHOR_RX=/\b(?:user\s*id|userid|id\s*(?:akun|member|user)?|rekening|bank|e[- ]?wallet|bukti|screenshot|wd|withdraw|penarikan|deposit|depo|dp|bonus|reset|password|sandi|login|akses|link|game|kalah|rungkad|pending|proses|tunggu|cek|error|eror|gagal|belum|blm|nama|nomor|jenis)\b|\?/i;
const PROMPT_GENERIC_INTENTS=new Set(['','GENERAL','GREETING','UNKNOWN','NONE','NEW','ACKNOWLEDGEMENT','GRATITUDE']);

export function selectPromptRecentMessages(rows=[], {max=PROMPT_RECENT_MAX,tail=PROMPT_RECENT_TAIL}={}){
  const list=Array.isArray(rows)?rows:[];
  const cap=Math.max(8,Math.min(60,Number(max)||PROMPT_RECENT_MAX));
  const keepTail=Math.max(6,Math.min(cap,Number(tail)||PROMPT_RECENT_TAIL));
  if(list.length<=cap) return list.slice();
  const selected=new Set();
  const tailStart=Math.max(0,list.length-keepTail);
  for(let i=tailStart;i<list.length;i++) selected.add(i);
  // Keep older operational anchors (human questions, explicit business topics, known-field
  // exchanges, non-generic intents) so Return-to-AI and follow-ups stay contextual even
  // though the model does not receive every raw message verbatim.
  for(let i=tailStart-1;i>=0 && selected.size<cap;i--){
    const row=list[i]||{};
    const text=String(row.text||'').trim();
    const sender=String(row.sender||row.sender_type||'').toLowerCase();
    const intent=String(row.intent||'').toUpperCase();
    const importantIntent=!PROMPT_GENERIC_INTENTS.has(intent);
    const humanQuestion=sender==='agent' && (text.includes('?') || PROMPT_ANCHOR_RX.test(text));
    if(importantIntent || humanQuestion || PROMPT_ANCHOR_RX.test(text)) selected.add(i);
  }
  // Fill any remaining slots with the nearest preceding turns to preserve chronology.
  for(let i=tailStart-1;i>=0 && selected.size<cap;i--) selected.add(i);
  return [...selected].sort((a,b)=>a-b).map(i=>list[i]);
}

function compactCaseBrain(value={}){
  const b=value&&typeof value==='object'?value:{};
  const out={};
  for(const k of ['goal','stage','primary_intent','status','expected_reply','resolved','sentiment','risk','next_step','understanding']){
    if(b[k]!==undefined && b[k]!==null && b[k]!=='') out[k]=typeof b[k]==='string'?txt(b[k],900):b[k];
  }
  for(const k of ['known_facts','missing_info','actions_done','contradictions']){
    if(Array.isArray(b[k])) out[k]=b[k].slice(0,20).map(x=>typeof x==='string'?txt(x,500):x);
  }
  return out;
}
function meaningfulCase(v=''){
  const x=String(v||'').trim().toUpperCase();
  return GENERIC_CASES.has(x)?'':x;
}
function latestRawMessage(input={}){
  const xs=Array.isArray(input.rawMessages)?input.rawMessages:[];
  return String(xs.at(-1)||'').trim();
}
function isAngryText(s=''){
  return /\b(?:anjing|bangsat|babi|goblok|bodoh|tolol|kampret|sialan|kesal|kesel|marah|lama\s+kali|parah\s+kali|cape|capek)\b/i.test(String(s||''));
}
function isDoneOrFollowupText(s=''){
  const n=String(s||'').trim().toLowerCase();
  return /^(?:udah|sudah|sdh|done|beres|selesai|gimana|gmna|masih|masih\s+belum|masih\s+blm|kok\s+belum|belum\s+juga|tolong\s+cek|cek\s+lagi)(?:\s+(?:bos|bosku|kak|min|admin))?[.!🙏😊👍]*$/i.test(n);
}
const SESSION_CASE_INTENTS=new Set([
  'DEPOSIT_PROBLEM','DEPOSIT_CANCEL','WITHDRAW_PROBLEM','WITHDRAW_REQUEST','FORGOT_PASSWORD','BONUS_REQUEST','BONUS_DAILY',
  'ACCOUNT_CHANGE_REQUEST','PAYOUT_NOT_RECEIVED','BANK_ACCOUNT_LIMIT','REGISTER_PROBLEM','LINK_PROBLEM','LOGIN_PROBLEM',
  'GAME_PROBLEM','GENERAL_DISTURBANCE','LOSS_COMPLAINT','ACCOUNT_CLOSE_REQUEST','TRANSACTION_AMBIGUOUS'
]);

export function inferSessionCaseFromHistory(rows=[], {currentText='',currentIntent='GENERAL'}={}){
  const current=String(currentIntent||'GENERAL').toUpperCase();
  const n=normalizeText(currentText||'');
  const hasDeposit=/\b(?:deposit|depo|dp|topup|top\s*up|isi\s+saldo|setor)\b/i.test(n);
  const hasWithdraw=/\b(?:wd|withdraw|penarikan|tarik\s+dana|cashout|cairin)\b/i.test(n);
  const hasProblem=/\b(?:belum|blm|belom|lama|pending|gagal|error|eror|masalah|kendala|tidak\s+masuk|ga\s+masuk|gak\s+masuk|cek|proses|tolong|bantu|selesaikan|diselesaikan|lanjutkan|percepat|kepastian|mana|gimana)\b/i.test(n);
  const hasLoss=/\b(?:kalah|rungkad|boncos|rugi|saldo\s+habis)\b/i.test(n);

  if(hasDeposit && hasProblem) return 'DEPOSIT_PROBLEM';
  if(hasWithdraw && hasProblem) return 'WITHDRAW_PROBLEM';
  if(current==='LOSS_COMPLAINT' || (hasLoss && !hasDeposit && !hasWithdraw)) return 'LOSS_COMPLAINT';
  if(SESSION_CASE_INTENTS.has(current)) return current;

  let skippedCurrent=false;
  for(let i=rows.length-1;i>=0;i--){
    const row=rows[i]||{};
    const rowText=String(row.text||'');
    if(!skippedCurrent && String(row.sender_type||row.sender||'').toLowerCase()==='customer'
      && normalizeText(rowText)===n){ skippedCurrent=true; continue; }
    const stored=String(row.intent||'').toUpperCase();
    if(SESSION_CASE_INTENTS.has(stored)) return stored;
    const detected=String(detectIntent(rowText)||'GENERAL').toUpperCase();
    if(SESSION_CASE_INTENTS.has(detected)) return detected;
  }
  return '';
}
function inferCaseFromRecent(input={}){
  return inferSessionCaseFromHistory(Array.isArray(input.recentMessages)?input.recentMessages:[],{
    currentText:latestRawMessage(input),currentIntent:input.currentIntent||'GENERAL'
  });
}
function caseLabel(active=''){
  const a=String(active||'').toUpperCase();
  if(a.includes('WITHDRAW')||a==='WD') return 'WD';
  if(a.includes('DEPOSIT')||a==='DP') return 'deposit';
  if(a.includes('RESET')||a.includes('PASSWORD')) return 'reset akun';
  if(a.includes('BONUS')) return 'bonus';
  if(a.includes('LOSS')) return 'keluhan permainan';
  if(a.includes('ACCOUNT_CLOSE')) return 'permintaan terkait akun';
  return 'kendala';
}

export function isHumanActiveState(state){ return HUMAN_STATES.has(normState(state)); }
export function isAgentAction(action){ return ACTION_ALLOWLIST.has(String(action||'').toUpperCase()); }
export function agentActionAllowlist(){ return [...ACTION_ALLOWLIST]; }

export function contextualClarification(input={}){
  const explicit=meaningfulCase(input.activeCase)||meaningfulCase(input.previousIntent)||meaningfulCase(input.currentIntent);
  const active=explicit||inferCaseFromRecent(input);
  const current=latestRawMessage(input);
  const rows=Array.isArray(input.recentMessages)?input.recentMessages:[];
  const lastHuman=[...rows].reverse().find(m=>String(m?.sender||m?.sender_type||'').toLowerCase()==='agent' && String(m?.text||'').trim());
  const humanText=String(lastHuman?.text||'').trim();

  // Return-to-AI is continuation of the SAME session. If the last human CS turn asked
  // for a field, acknowledge the member's answer instead of restarting the conversation.
  if(humanText && /nama\s+rekening|atas\s+nama/i.test(humanText) && current){
    return 'Baik bosku, informasi nama rekeningnya sudah kami terima ya. Kami lanjutkan pengecekannya 🙏';
  }
  if(humanText && /nomor\s+rekening|no\.?\s*rek/i.test(humanText) && current){
    return 'Baik bosku, nomor rekeningnya sudah kami terima ya. Kami lanjutkan pengecekannya 🙏';
  }
  if(humanText && /jenis\s+rekening|bank|e[- ]?wallet/i.test(humanText) && current){
    return 'Baik bosku, jenis rekeningnya sudah kami terima ya. Kami lanjutkan pengecekannya 🙏';
  }
  if(humanText && /tunggu|ditunggu|cek|pengecekan|proses/i.test(humanText) && isDoneOrFollowupText(current)){
    const label=caseLabel(active);
    return label==='kendala'
      ? 'Baik bosku, masih kami lanjutkan pengecekannya ya. Mohon ditunggu sebentar lagi 🙏'
      : `Baik bosku, ${label} yang tadi masih kami lanjutkan pengecekannya ya. Mohon ditunggu sebentar lagi 🙏`;
  }

  if(active){
    if(isAngryText(current)){
      if(active.includes('WITHDRAW') || active==='WD') return 'Mohon maaf sudah menunggu lama bosku 🙏 Kami masih mengikuti kendala WD yang tadi dan lanjutkan pengecekannya.';
      if(active.includes('DEPOSIT') || active==='DP') return 'Mohon maaf sudah menunggu lama bosku 🙏 Kami masih mengikuti kendala deposit yang tadi dan lanjutkan pengecekannya.';
      if(active.includes('LOSS')) return 'Saya paham bosku, kondisi permainan yang kurang bagus memang bisa bikin kesal. Kalau ada bagian yang ingin dibantu cek, sampaikan ya bosku 🙏';
    }
    if(active.includes('WITHDRAW') || active==='WD') return 'Baik bosku, saya masih mengikuti kendala withdraw yang tadi ya. Bagian mana yang masih belum selesai?';
    if(active.includes('DEPOSIT') || active==='DP') return 'Baik bosku, saya masih mengikuti kendala deposit yang tadi ya. Bagian mana yang masih belum selesai?';
    if(active.includes('RESET') || active.includes('PASSWORD')) return 'Baik bosku, saya masih mengikuti proses reset akun yang tadi ya. Bagian mana yang masih belum selesai?';
    if(active.includes('BONUS')) return 'Baik bosku, saya masih mengikuti bonus yang tadi ya. Boleh jelaskan bagian yang masih belum selesai?';
    if(active.includes('LOSS')) return 'Saya masih mengikuti keluhan permainan yang tadi ya bosku. Bagian mana yang ingin dibantu?';
    return 'Baik bosku, saya masih mengikuti kendala yang tadi ya. Boleh jelaskan bagian yang masih belum selesai?';
  }

  // Human handoff exists but no safe operational case can be inferred: continue the same
  // session without pretending this is a brand-new conversation.
  if(humanText){
    return 'Baik bosku, saya lanjut dari percakapan dengan CS sebelumnya ya. Informasinya sudah kami terima dan akan kami lanjutkan sesuai konteks percakapan 🙏';
  }

  // Truly fresh session: no active case and no human-handoff context.
  return 'Iya bosku 😊 Ada yang bisa kami bantu?';
}

export function normalizeAgentInput(input={}){
  const state=normState(input.state);
  return {
    sessionId:txt(input.sessionId,240),
    conversationId:txt(input.conversationId,240),
    livechatChatId:txt(input.livechatChatId,240),
    threadId:txt(input.threadId,240),
    messageIds:arr(input.messageIds,100).map(x=>txt(x,240)).filter(Boolean),
    rawMessages:arr(input.rawMessages,100).map(x=>txt(x,4000)),
    normalizedMessages:arr(input.normalizedMessages,100).map(x=>txt(x,4000)),
    state,
    currentIntent:txt(input.currentIntent||'GENERAL',120).toUpperCase(),
    previousIntent:txt(input.previousIntent||'',120).toUpperCase(),
    activeCase:txt(input.activeCase||'',160).toUpperCase(),
    memberId:txt(input.memberId||'',240),
    memberIdKnown:bool(input.memberIdKnown || input.memberId),
    proofReceived:bool(input.proofReceived),
    telegramTicketExists:bool(input.telegramTicketExists),
    telegramTicketId:txt(input.telegramTicketId||'',240),
    telegramTicketStatus:txt(input.telegramTicketStatus||'',80).toUpperCase(),
    recentMessages:selectPromptRecentMessages(arr(input.recentMessages,80)).map(m=>({
      sender:txt(m?.sender||m?.sender_type||'',40),
      text:txt(m?.text||'',1600),
      intent:txt(m?.intent||'',120).toUpperCase(),
      eventId:txt(m?.eventId||m?.event_id||'',240),
      createdAt:txt(m?.createdAt||m?.created_at||'',80)
    })),
    conversationSummary:txt(input.conversationSummary||'',7000),
    knowledge:txt(input.knowledge||'',18000),
    rules:txt(input.rules||'',18000),
    responses:txt(input.responses||'',10000),
    approvedLearningExamples:txt(input.approvedLearningExamples||'',8000),
    approvedCorrections:txt(input.approvedCorrections||'',8000),
    websiteProfile:input.websiteProfile && typeof input.websiteProfile==='object' ? input.websiteProfile : {},
    hasKnowledge:bool(input.hasKnowledge),
    attachments:arr(input.attachments,8),
    caseBrain:compactCaseBrain(input.caseBrain)
  };
}

function legacyToAgentAction(decision={}){
  const a=String(decision.action||'').toUpperCase();
  const reply=txt(decision.reply,1200);
  if(a==='AUTO_REPLY') return 'SEND_MESSAGE';
  if(a==='ASK_INFO'){
    if(/(?:user\s*id|userid|id\s*(?:akun|member|user)|username)/i.test(reply)) return 'ASK_MEMBER_ID';
    if(/(?:bukti|screenshot|screen\s*shot|struk)/i.test(reply)) return 'ASK_PROOF';
    return 'SEND_MESSAGE';
  }
  if(a==='ASK_HUMAN' || a==='HANDOFF') return 'ESCALATE_HUMAN';
  return isAgentAction(a) ? a : 'ESCALATE_HUMAN';
}

function deriveNextState(input, decision, action){
  if(isHumanActiveState(input.state)) return 'HUMAN_ACTIVE';
  if(action==='ASK_MEMBER_ID') return 'WAITING_MEMBER_ID';
  if(action==='ASK_PROOF') return 'WAITING_PROOF';
  if(action==='ESCALATE_HUMAN' || action==='UPDATE_TICKET') return 'WAITING_HUMAN';
  const s=normState(decision?.brain?.status||decision?.status||'');
  if(s==='WAITING_MEMBER') return 'WAITING_MEMBER';
  if(s==='WAITING_HUMAN') return 'WAITING_HUMAN';
  return normState(input.state)==='NEW' ? 'BOT_ACTIVE' : normState(input.state);
}

export function validateAgentDecision(rawDecision={}, rawInput={}, {confidenceThreshold=0.86}={}){
  const input=normalizeAgentInput(rawInput);
  if(isHumanActiveState(input.state)){
    return {
      intent:txt(rawDecision?.brain?.primary_intent||rawDecision?.primary_intent||input.currentIntent||'GENERAL',120).toUpperCase(),
      subIntent:txt(rawDecision?.subIntent||'',120).toUpperCase(),
      confidence:Math.max(0,Math.min(1,Number(rawDecision?.confidence||0))),
      activeCase:input.activeCase||null,
      action:'NO_REPLY',reply:'',missingFields:[],shouldCreateTicket:false,shouldUpdateTicket:false,shouldEscalate:false,nextState:'HUMAN_ACTIVE',
      reason:'human_active_priority',brain:rawDecision?.brain||input.caseBrain,legacyDecision:rawDecision
    };
  }

  let action=legacyToAgentAction(rawDecision);
  let confidence=Math.max(0,Math.min(1,Number(rawDecision?.confidence||0)));
  let reply=txt(rawDecision?.reply,1200);
  const missing=arr(rawDecision?.brain?.missing_info||rawDecision?.brain?.missingInfo||rawDecision?.missingFields,30).map(x=>txt(x,160)).filter(Boolean);
  const intent=txt(rawDecision?.intent||rawDecision?.brain?.primary_intent||rawDecision?.primary_intent||input.currentIntent||'GENERAL',120).toUpperCase();
  const activeCandidate=txt(rawDecision?.activeCase||rawDecision?.active_case||input.activeCase||'',160).toUpperCase();
  const activeCase=activeCandidate && !['GENERAL','GREETING','UNKNOWN','NONE','NEW'].includes(activeCandidate) ? activeCandidate : null;
  let reason=txt(rawDecision?.reason||'',600);

  if(!isAgentAction(action)) { action='SEND_MESSAGE'; reply=contextualClarification(input); reason=`invalid_action_fallback|${reason}`; }
  if(action==='NO_REPLY') { action='SEND_MESSAGE'; reply=contextualClarification(input); reason=`no_reply_forbidden_outside_human|${reason}`; }

  if(confidence < Number(confidenceThreshold||0.86)){
    action='SEND_MESSAGE';
    reply=contextualClarification(input);
    reason=`low_confidence_contextual_clarification:${confidence.toFixed(2)}|${reason}`;
  }

  if(['SEND_MESSAGE','ASK_MEMBER_ID','ASK_PROOF','SEND_HOLDING_MESSAGE'].includes(action) && !reply){
    reply=contextualClarification(input);
    action='SEND_MESSAGE';
    reason=`empty_reply_safe_fallback|${reason}`;
  }

  if(action==='ASK_MEMBER_ID' && input.memberIdKnown){
    action='SEND_MESSAGE';
    reply=contextualClarification(input);
    reason=`member_id_already_known|${reason}`;
  }
  if(action==='ASK_PROOF' && input.proofReceived){
    action='SEND_MESSAGE';
    reply=contextualClarification(input);
    reason=`proof_already_received|${reason}`;
  }

  const shouldEscalate=action==='ESCALATE_HUMAN';
  const derivedNext=deriveNextState(input,rawDecision,action);
  const requestedNext=normState(rawDecision?.nextState||rawDecision?.next_state||'');
  const validNext=new Set(['NEW','BOT_ACTIVE','WAITING_MEMBER','WAITING_MEMBER_ID','WAITING_PROOF','WAITING_HUMAN','HUMAN_ACTIVE','RESOLVED','CLOSED']);
  const nextState=validNext.has(requestedNext) && requestedNext!=='HUMAN_ACTIVE' ? requestedNext : derivedNext;
  return {
    intent,
    subIntent:txt(rawDecision?.subIntent||'',120).toUpperCase(),
    confidence,
    activeCase,
    action,
    reply,
    missingFields:missing,
    shouldCreateTicket:shouldEscalate && !input.telegramTicketExists,
    shouldUpdateTicket:(shouldEscalate || action==='UPDATE_TICKET') && input.telegramTicketExists,
    shouldEscalate,
    nextState,
    reason,
    brain:rawDecision?.brain||input.caseBrain,
    legacyDecision:rawDecision
  };
}

export function agentDecisionToLegacy(agentDecision={}){
  const a=String(agentDecision.action||'SEND_MESSAGE').toUpperCase();
  const legacyAction = a==='ESCALATE_HUMAN' ? 'ASK_HUMAN'
    : (a==='ASK_MEMBER_ID'||a==='ASK_PROOF') ? 'ASK_INFO'
    : a==='NO_REPLY' ? 'NO_REPLY'
    : 'AUTO_REPLY';
  return {
    ...(agentDecision.legacyDecision||{}),
    action:legacyAction,
    confidence:Number(agentDecision.confidence||0),
    reply:String(agentDecision.reply||''),
    reason:String(agentDecision.reason||''),
    brain:agentDecision.brain||agentDecision.legacyDecision?.brain||{}
  };
}

export async function runConversationAgent({client,input,style={},confidenceThreshold=0.86}={}){
  const ctx=normalizeAgentInput(input);
  if(!client || typeof client.classifyAndReply!=='function') throw new Error('AI_AGENT_CLIENT_REQUIRED');
  const contextJson=JSON.stringify({
    sessionId:ctx.sessionId,conversationId:ctx.conversationId,livechatChatId:ctx.livechatChatId,threadId:ctx.threadId,
    messageIds:ctx.messageIds,rawMessages:ctx.rawMessages,normalizedMessages:ctx.normalizedMessages,
    state:ctx.state,currentIntent:ctx.currentIntent,previousIntent:ctx.previousIntent,activeCase:ctx.activeCase,
    memberId:ctx.memberId,memberIdKnown:ctx.memberIdKnown,proofReceived:ctx.proofReceived,
    telegramTicketExists:ctx.telegramTicketExists,telegramTicketId:ctx.telegramTicketId,telegramTicketStatus:ctx.telegramTicketStatus,
    recentMessages:ctx.recentMessages,conversationSummary:ctx.conversationSummary,websiteProfile:ctx.websiteProfile,caseBrain:ctx.caseBrain
  },null,2);
  let raw;
  if(typeof client.decideAgent==='function'){
    raw=await client.decideAgent({input:ctx,style});
  }else{
    // Backward-compatible adapter for tests/older client implementations. Production OpenAIClient
    // implements decideAgent() and returns the final action allowlist directly.
    raw=await client.classifyAndReply({
      normalized:ctx.normalizedMessages.join('\n') || ctx.rawMessages.join('\n'),
      intent:ctx.currentIntent,
      context:`AI_AGENT_STRUCTURED_CONTEXT:\n${contextJson}`,
      rules:ctx.rules,
      knowledge:[ctx.knowledge,ctx.responses,ctx.approvedCorrections].filter(Boolean).join('\n'),
      attachments:ctx.attachments,
      style,
      conversationDigest:ctx.conversationSummary,
      csStyleExamples:ctx.approvedLearningExamples,
      historyLearning:ctx.approvedLearningExamples,
      caseBrain:ctx.caseBrain
    });
  }
  return validateAgentDecision(raw,ctx,{confidenceThreshold});
}
