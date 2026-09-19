import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { contextualClarification, validateAgentDecision, inferSessionCaseFromHistory } from '../src/ai-agent.js';

test('Return to AI low-confidence answer binds to the last human CS field question',()=>{
  const input={
    state:'BOT_ACTIVE',currentIntent:'GENERAL',previousIntent:'WITHDRAW_PROBLEM',activeCase:'WITHDRAW_PROBLEM',
    rawMessages:['Nama rekening penerima WISATA'],
    recentMessages:[
      {sender_type:'customer',intent:'WITHDRAW_PROBLEM',text:'wd saya belum masuk'},
      {sender_type:'agent',intent:'GENERAL',text:'Nama Rekening nya bosku?'},
      {sender_type:'customer',intent:'GENERAL',text:'Nama rekening penerima WISATA'}
    ]
  };
  const d=validateAgentDecision(
    {intent:'GENERAL',action:'SEND_MESSAGE',confidence:0.45,reply:'jawaban model yang tidak yakin'},
    input,{confidenceThreshold:0.86}
  );
  assert.equal(d.action,'SEND_MESSAGE');
  assert.match(d.reply,/nama rekeningnya sudah kami terima/i);
  assert.doesNotMatch(d.reply,/ada yang bisa kami bantu/i);
});

test('Return to AI "Udah bosku" continues the same WD context after human asked member to wait',()=>{
  const reply=contextualClarification({
    state:'BOT_ACTIVE',currentIntent:'GENERAL',previousIntent:'',activeCase:'',rawMessages:['Udah bosku'],
    recentMessages:[
      {sender_type:'customer',intent:'WITHDRAW_PROBLEM',text:'wd belum masuk dari tadi'},
      {sender_type:'agent',intent:'GENERAL',text:'Silakan di tunggu sebentar ya bosku'},
      {sender_type:'customer',intent:'GENERAL',text:'Udah bosku'}
    ]
  });
  assert.match(reply,/WD|pengecekan/i);
  assert.match(reply,/ditunggu|lanjutkan/i);
  assert.doesNotMatch(reply,/ada yang bisa kami bantu/i);
});

test('angry member inherits DEPOSIT case instead of becoming a generic abuse complaint',()=>{
  const rows=[
    {sender_type:'customer',intent:'DEPOSIT_PROBLEM',text:'depo saya belum masuk'},
    {sender_type:'agent',intent:'GENERAL',text:'Mohon ditunggu sebentar ya bosku'},
    {sender_type:'customer',intent:'ABUSIVE',text:'anjing lama kali'}
  ];
  assert.equal(inferSessionCaseFromHistory(rows,{currentText:'anjing lama kali',currentIntent:'ABUSIVE'}),'DEPOSIT_PROBLEM');
});

test('angry member inherits WITHDRAW case instead of becoming a generic abuse complaint',()=>{
  const rows=[
    {sender_type:'customer',intent:'WITHDRAW_PROBLEM',text:'wd belum masuk'},
    {sender_type:'agent',intent:'GENERAL',text:'Kami cek dulu ya bosku'},
    {sender_type:'customer',intent:'ABUSIVE',text:'bangsat lama kali dari tadi'}
  ];
  assert.equal(inferSessionCaseFromHistory(rows,{currentText:'bangsat lama kali dari tadi',currentIntent:'ABUSIVE'}),'WITHDRAW_PROBLEM');
});

test('explicit loss complaint remains LOSS even if an older WD case exists',()=>{
  const rows=[
    {sender_type:'customer',intent:'WITHDRAW_PROBLEM',text:'wd belum masuk'},
    {sender_type:'agent',intent:'GENERAL',text:'Silakan ditunggu ya'},
    {sender_type:'customer',intent:'LOSS_COMPLAINT',text:'anjing kalah terus situsnya'}
  ];
  assert.equal(inferSessionCaseFromHistory(rows,{currentText:'anjing kalah terus situsnya',currentIntent:'LOSS_COMPLAINT'}),'LOSS_COMPLAINT');
});

test('fresh session still has no inherited case',()=>{
  const rows=[
    {sender_type:'ai',intent:'GREETING',text:'Selamat sore bosku 😊'},
    {sender_type:'customer',intent:'GENERAL',text:'Boskuuuu'}
  ];
  assert.equal(inferSessionCaseFromHistory(rows,{currentText:'Boskuuuu',currentIntent:'GENERAL'}),'');
  assert.match(contextualClarification({state:'BOT_ACTIVE',currentIntent:'GENERAL',rawMessages:['Boskuuuu'],recentMessages:rows}),/ada yang bisa kami bantu/i);
});

test('agent prompt explicitly treats Return to AI as same-session continuation and anger as sentiment',()=>{
  const src=fs.readFileSync(new URL('../src/ai.js',import.meta.url),'utf8');
  assert.match(src,/RETURN TO AI setelah HUMAN takeover BUKAN session baru/);
  assert.match(src,/Marah\/kasar adalah SENTIMENT, bukan otomatis intent/);
});
