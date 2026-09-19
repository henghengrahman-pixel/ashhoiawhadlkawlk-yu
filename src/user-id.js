// Deterministic User ID parser used by claim/operational workflows.
// Current-message extraction must take priority over old conversation history.

const COMMON_BLOCKED = new Set([
  'id','userid','user','member','akun','account','saya','aku','kami','kita','dia','nya','punya',
  'bonus','claim','clim','klaim','deposit','depo','dp','topup','withdraw','wd','penarikan',
  'harian','mingguan','bulanan','slot','slotgames','live','game','games','livegame','livegames',
  'cashback','rollingan','ronda','freebet','freespin','reload','promo','event','new','baru',
  'ya','iya','yah','bos','boss','bosku','boskuh','kak','min','admin','tolong','mohon','dong',
  'mau','ingin','minta','bisa','boleh','cek','check','proses','diproses','status','bantu','dibantu',
  'selesai','selesaikan','diselesaikan','lanjut','lanjutkan','dilanjutkan','percepat','dipercepat',
  'sudah','udah','udh','belum','blm','blom','belom','tidak','tdk','gak','ga','gk','nggak','enggak',
  'masuk','msk','cair','pending','lama','masih','msh','gimana','gmna','mana','kapan','kenapa',
  'ini','itu','yang','dan','atau','dari','untuk','ke','di','pada','dengan','sebagai','tadi','lagi',
  'rekening','rek','bank','dana','bca','bri','bni','mandiri','cimb','jago','seabank','ovo','gopay',
  'linkaja','shopeepay','atas','nama','nomor','no','nominal','bukti','transfer','tf','password','pass',
  'psw','pwd','reset','resset','resett','link','akses','aksess','aksesx','daftar','gangguan','gngguan','gangguanx','macet','limit','limid','kalah','rungkad',
  'rugi','boncos','error','eror','err','errorr','gagal','gagall','masalah','kendala','login','loginn','ligin','lgin','website','situs','halaman','lupa','lpa','lp','lup','gabisa','gbs',
  'anjing','bangsat','babi','goblok','bodoh','tolol','kampret','sialan','anjir','asu','kontol',
  'parah','kesal','kesel','marah','cape','capek','kali','bang','bro','gan','woy','woi','please',
  'setuju','agree','ok','oke','sip','siap','done','beres','makasih','terima','kasih','blumm','msokk','masokk','witdraw','witdrow','widraw','wdraw','widhraw','depsoit','dposit','depsit'
]);

function cleanCandidate(v=''){
  return String(v||'').trim().replace(/^[,.:;=\-]+|[,.:;=\-]+$/g,'');
}
function blockedCandidate(v=''){
  const low=String(v||'').toLowerCase();
  if(!low || COMMON_BLOCKED.has(low)) return true;
  if(/^(?:https?|www|com|net|org|id)$/i.test(v)) return true;
  if(/^\d+$/.test(v)) return true; // phone/account/amount, not member ID
  if(/^[a-z]+\.(?:com|net|org|id)$/i.test(v)) return true;
  return false;
}
function looksStrongId(v=''){
  const token=cleanCandidate(v);
  if(!token || blockedCandidate(token) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,39}$/.test(token)) return false;
  if(/[A-Za-z]/.test(token) && /\d/.test(token)) return true;           // Alwi02 / rudi2199
  if(/^[A-Z][A-Z0-9_.-]{3,39}$/.test(token)) return true;              // JATTT / BASRET
  if(/[A-Z]/.test(token.slice(1)) && /[a-z]/.test(token)) return true;  // camelCase-like IDs
  return false;
}

export function extractUserIdFromText(value=''){
  const raw=String(value||'').trim();
  if(!raw) return '';
  const pats=[
    /\b(?:user\s*id|userid|username)\s*[:=\-]?\s*([a-z0-9][a-z0-9_.-]{2,39})\b/i,
    /\bid(?:\s*(?:saya|akun|nya)|\s+nya)?\s*[,.:=\-]?\s*([a-z0-9][a-z0-9_.-]{2,39})\b/i,
    /\bid([a-z][a-z0-9_.-]{2,39})\b/i,
    /\b([a-z0-9][a-z0-9_.-]{2,39})\s+(?:adalah\s+)?id(?:\s*(?:saya|akun|nya)|\s+nya)?\b/i
  ];
  for(const re of pats){
    const m=raw.match(re);
    const candidate=cleanCandidate(m?.[1]||'');
    if(!candidate || blockedCandidate(candidate)) continue;
    return candidate;
  }
  return '';
}

// Context-aware parser used when the workflow has explicitly asked the member for an account/member ID.
export function extractRequestedUserIdFromText(value=''){
  const raw=String(value||'').trim();
  if(!raw) return '';
  const explicit=extractUserIdFromText(raw);
  if(explicit) return explicit;

  const tokens=raw.match(/[A-Za-z0-9][A-Za-z0-9_.-]{2,39}/g)||[];
  const candidates=tokens.filter(token=>!blockedCandidate(token));

  if(candidates.length===1) return candidates[0];
  if(!candidates.length) return '';

  const scored=candidates.map((token,index)=>{
    let score=0;
    if(/[A-Za-z]/.test(token) && /\d/.test(token)) score+=8;
    if(/^[A-Z0-9_.-]{4,40}$/.test(token) && /[A-Z]/.test(token)) score+=6;
    if(/[A-Z]/.test(token.slice(1)) && /[a-z]/.test(token)) score+=3;
    if(token.length>=4 && token.length<=20) score+=1;
    return {token,score,index};
  }).sort((a,b)=>b.score-a.score || b.index-a.index);
  if(scored[0].score>=6 && scored[0].score>scored[1].score) return scored[0].token;
  return '';
}

// Strict inline parser for the FIRST business message, before the workflow has asked for ID.
// Only a strongly ID-looking token is accepted.
export function extractInlineBusinessUserIdFromText(value='', {intent=''}={}){
  const raw=String(value||'').trim();
  if(!raw) return '';
  const explicit=extractUserIdFromText(raw);
  if(explicit) return explicit;

  const upperIntent=String(intent||'').toUpperCase();
  const hasBusinessContext =
    /(?:\bbonus\b|\bclaim\b|\bklaim\b|\bfree\s*bet\b|\bfreebet\b|\bcashback\b|\brollingan\b|\bronda\b|\bnew\s*member\b|\bmember\s*baru\b|\bdeposit\b|\bdepo\b|\bdp\b|\bwithdraw\b|\bwd\b|\bpenarikan\b|\bgame\b|\blogin\b|\breset\b)/i.test(raw)
    || /(?:BONUS|WITHDRAW|DEPOSIT|GAME|LOGIN|RESET|PASSWORD)/.test(upperIntent);
  if(!hasBusinessContext) return '';

  const tokens=raw.match(/[A-Za-z0-9][A-Za-z0-9_.-]{2,39}/g)||[];
  const strong=tokens.filter(looksStrongId);
  if(strong.length===1) return strong[0];
  if(!strong.length) return '';
  return strong.at(-1)||'';
}

export function asksForUserId(text=''){
  const s=String(text||'');
  return /(?:\buser\s*id\b|\buserid\b|\busername\b|\bid\s*(?:akun|member|user)\b|\bid[- ]?nya\b|\bkirim(?:kan)?\s+(?:user\s*)?id\b|\bboleh\s+kirim\s+(?:user\s*)?id\b)/i.test(s);
}

// Resolve a known member ID across the CURRENT SESSION.
export function extractKnownUserIdFromMessages(rows=[]){
  let known='';
  let waitingForId=false;
  for(const row of Array.isArray(rows)?rows:[]){
    const sender=String(row?.sender_type||row?.sender||'').toLowerCase();
    const text=String(row?.text||'').trim();
    if(!text) continue;

    if(sender==='customer' || sender==='member'){
      let found=extractUserIdFromText(text);
      if(!found) found=extractInlineBusinessUserIdFromText(text,{intent:row?.intent||''});
      if(!found && waitingForId) found=extractRequestedUserIdFromText(text);
      if(found){
        known=found;
        waitingForId=false;
      }
      continue;
    }

    if(sender==='ai' || sender==='agent' || sender==='bot' || sender==='human'){
      waitingForId=asksForUserId(text);
    }
  }
  return known;
}
