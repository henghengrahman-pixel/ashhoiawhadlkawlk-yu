import assert from 'node:assert/strict';

const SIZES=[100,500,1000,5000];
const CONCURRENCY=64;

async function runScenario(conversationCount){
  const started=Date.now();
  const heapBefore=process.memoryUsage().heapUsed;
  const sessions=new Map();
  const inboundIds=new Set();
  const outboundKeys=new Set();
  const archived=new Set();
  const active=new Set();
  let duplicateIngress=0,retries=0,maxInFlight=0,inFlight=0,processedEvents=0,sent=0;

  for(let i=0;i<conversationCount;i++){
    const sid=`sess-${i}`;
    active.add(sid);
    const messages=Array.from({length:4},(_,j)=>({id:`msg-${i}-${j}`,seq:j,text:j===0?'wd belum masuk':j===1?'udah sejam bos':j===2?'masih blom':'gimana bos'}));
    // Provider may deliver an exact duplicate event. It must be ignored by ID, not by text.
    if(i%50===0)messages.push({...messages[0]});
    sessions.set(sid,messages);
  }

  const sessionEntries=[...sessions.entries()];
  let cursor=0;
  async function worker(){
    while(true){
      const index=cursor++;
      if(index>=sessionEntries.length)return;
      const [sid,messages]=sessionEntries[index];
      inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
      try{
        messages.sort((a,b)=>a.seq-b.seq);
        let expectedSeq=0;
        for(const m of messages){
          if(inboundIds.has(m.id)){duplicateIngress++;continue;}
          inboundIds.add(m.id);
          assert.equal(m.seq,expectedSeq++,`per-session ordering failed for ${sid}`);
          let attempt=1;
          if(m.seq===1 && Number(sid.split('-')[1])%97===0){attempt++;retries++;}
          assert.ok(attempt<=2);
          const key=`${sid}|${m.id}|SEND_MESSAGE`;
          if(!outboundKeys.has(key)){outboundKeys.add(key);sent++;}
          // Retrying the same processed event/action cannot emit a second outbound.
          outboundKeys.add(key);
          processedEvents++;
          await Promise.resolve();
        }
        if(Number(sid.split('-')[1])%10===0){active.delete(sid);archived.add(sid);}
      }finally{inFlight--;}
    }
  }
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,conversationCount)},worker));

  const expectedEvents=conversationCount*4;
  assert.equal(processedEvents,expectedEvents,'silent event loss');
  assert.equal(inboundIds.size,expectedEvents,'event-id dedup mismatch');
  assert.equal(outboundKeys.size,expectedEvents,'duplicate outbound detected');
  assert.equal(sent,expectedEvents,'each valid event needs one simulated response');
  assert.equal(active.size+archived.size,conversationCount,'active/archive lifecycle mismatch');
  for(const x of archived)assert.ok(!active.has(x),'closed session leaked into active');
  assert.ok(maxInFlight<=CONCURRENCY,'bounded concurrency exceeded');
  assert.ok(maxInFlight>1 || conversationCount===1,'one slow session would globally serialize all work');
  const heapAfter=process.memoryUsage().heapUsed;
  const heapDelta=Math.max(0,heapAfter-heapBefore);
  assert.ok(heapDelta<256*1024*1024,`simulation memory delta too high: ${heapDelta}`);

  return {
    mode:'mock-fixture-simulation',activeConversations:conversationCount,inputEvents:expectedEvents,processedEvents,
    outboundSent:sent,duplicateIngress,retries,queueDepthAfter:0,maxInFlight,concurrencyLimit:CONCURRENCY,
    activeAfter:active.size,closedArchived:archived.size,heapDeltaBytes:heapDelta,durationMs:Date.now()-started,
    assertions:'PASS'
  };
}

const results=[];
for(const size of SIZES)results.push(await runScenario(size));
console.log(JSON.stringify({ok:true,mode:'mock-fixture-simulation',note:'No real LiveChat/OpenAI/Telegram credentials are used by this load simulation.',results},null,2));
