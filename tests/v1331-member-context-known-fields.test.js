import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectIntent, normalizeText } from '../src/normalizer.js';
import {
  extractRequestedUserIdFromText,
  extractInlineBusinessUserIdFromText,
  extractKnownUserIdFromMessages
} from '../src/user-id.js';
import { inferSessionCaseFromHistory, validateAgentDecision } from '../src/ai-agent.js';

test('v1.33.1 natural WD and deposit requests do not fall back to GENERAL',()=>{
  const wd=[
    'Tolong bos wd nya di selesaikan',
    'bantu wd saya bos',
    'witdrow sy blm msokk bos',
    'widhdraw lama kali anjing',
    'wd tolong dipercepat'
  ];
  for(const x of wd) assert.equal(detectIntent(x),'WITHDRAW_PROBLEM',x);
  const dp=[
    'depsoitt blm msokk',
    'deposit lama bangsat belum masuk',
    'tolong depo saya diselesaikan',
    'depsit saya gagal masuk'
  ];
  for(const x of dp) assert.equal(detectIntent(x),'DEPOSIT_PROBLEM',x);
});

test('v1.33.1 access game reset and loss typos remain distinct intents',()=>{
  assert.equal(detectIntent('gngguan link eror'),'LINK_PROBLEM');
  assert.equal(detectIntent('gabisa akses bos'),'LINK_PROBLEM');
  assert.equal(detectIntent('game macet keluar sendiri'),'GAME_PROBLEM');
  assert.equal(detectIntent('lupa paswrd bos'),'FORGOT_PASSWORD');
  assert.equal(detectIntent('lupapsw ga bisa masuk'),'FORGOT_PASSWORD');
  assert.equal(detectIntent('kalah terus anjir rungkad mulu'),'LOSS_COMPLAINT');
});

test('v1.33.1 account-close language is not misclassified as forgot password',()=>{
  assert.equal(detectIntent('tutup akun saya bos'),'ACCOUNT_CLOSE_REQUEST');
  assert.equal(detectIntent('hapus akun saya'),'ACCOUNT_CLOSE_REQUEST');
  assert.equal(detectIntent('Udah ganti sandi akun saya biar saya GK tau dan saya GK bakal login lagi'),'ACCOUNT_CLOSE_REQUEST');
});

test('v1.33.1 first bonus/WD message can carry member ID inline',()=>{
  assert.equal(extractInlineBusinessUserIdFromText('Bonus deposit boskuh Alwi02',{intent:'BONUS_REQUEST'}),'Alwi02');
  assert.equal(extractInlineBusinessUserIdFromText('claim bonus new member Rudi22',{intent:'BONUS_REQUEST'}),'Rudi22');
  assert.equal(extractInlineBusinessUserIdFromText('claim bonus harian BASRET',{intent:'BONUS_DAILY'}),'BASRET');
  assert.equal(extractInlineBusinessUserIdFromText('wd JATTT tolong cek',{intent:'WITHDRAW_PROBLEM'}),'JATTT');
});

test('v1.33.1 ordinary words profanity and workflow text are never user IDs',()=>{
  const xs=[
    'Tolong bos wd nya di selesaikan',
    'Depo rungkad depo rungkad babi',
    'deposit lama bangsat belum masuk',
    'gngguan link eror',
    'gabisa akses bos',
    'lupa psw bos',
    'bonus deposit harian ya bos'
  ];
  for(const x of xs){
    assert.equal(extractRequestedUserIdFromText(x),'',x);
    assert.equal(extractInlineBusinessUserIdFromText(x,{intent:detectIntent(x)}),'',x);
  }
});

test('v1.33.1 known member ID persists through the whole current session and is not asked again',()=>{
  const rows=[
    {sender_type:'customer',text:'wd belum masuk',intent:'WITHDRAW_PROBLEM'},
    {sender_type:'ai',text:'Boleh kirim ID akunnya ya bosku'},
    {sender_type:'customer',text:'JATTT',intent:'GENERAL'},
    {sender_type:'customer',text:'udah sejam bos',intent:'GENERAL'},
    {sender_type:'agent',text:'Mohon ditunggu ya bosku'},
    {sender_type:'customer',text:'gimana bos',intent:'GENERAL'}
  ];
  assert.equal(extractKnownUserIdFromMessages(rows),'JATTT');
  const decision=validateAgentDecision({intent:'WITHDRAW_PROBLEM',action:'ASK_MEMBER_ID',confidence:.99,reply:'Boleh kirim ID?'},{
    state:'BOT_ACTIVE',currentIntent:'WITHDRAW_PROBLEM',activeCase:'WITHDRAW_PROBLEM',memberId:'JATTT',memberIdKnown:true,recentMessages:rows
  });
  assert.notEqual(decision.action,'ASK_MEMBER_ID');
});

test('v1.33.1 bonus ID supplied in the claim remains known on later turns',()=>{
  const rows=[
    {sender_type:'customer',text:'claim bonus new member Rudi22',intent:'BONUS_REQUEST'},
    {sender_type:'ai',text:'Silakan baca syarat bonus new member ya bosku'},
    {sender_type:'customer',text:'oke setuju',intent:'GENERAL'},
    {sender_type:'customer',text:'gimana bos',intent:'GENERAL'}
  ];
  assert.equal(extractKnownUserIdFromMessages(rows),'Rudi22');
});

test('v1.33.1 anger is sentiment: active DP/WD context wins, explicit loss stays loss',()=>{
  const dpRows=[
    {sender_type:'customer',text:'deposit belum masuk',intent:'DEPOSIT_PROBLEM'},
    {sender_type:'ai',text:'kami cek depositnya'},
    {sender_type:'customer',text:'lama kali anjing',intent:'ABUSIVE'}
  ];
  const wdRows=[
    {sender_type:'customer',text:'wd belum masuk',intent:'WITHDRAW_PROBLEM'},
    {sender_type:'ai',text:'kami cek wd nya'},
    {sender_type:'customer',text:'parah kali bos',intent:'COMPLAINT'}
  ];
  assert.equal(inferSessionCaseFromHistory(dpRows,{currentText:'lama kali anjing',currentIntent:'ABUSIVE'}),'DEPOSIT_PROBLEM');
  assert.equal(inferSessionCaseFromHistory(wdRows,{currentText:'parah kali bos',currentIntent:'COMPLAINT'}),'WITHDRAW_PROBLEM');
  assert.equal(inferSessionCaseFromHistory(dpRows,{currentText:'kalah terus rungkad',currentIntent:'LOSS_COMPLAINT'}),'LOSS_COMPLAINT');
});

test('v1.33.1 AI prompt enforces full current-session known-field memory',()=>{
  const src=fs.readFileSync(new URL('../src/ai.js',import.meta.url),'utf8');
  assert.match(src,/seluruh current-session history/i);
  assert.match(src,/jangan minta ulang/i);
  assert.match(src,/kata kerja, kata kasar, sapaan, nama bank\/e-wallet, nominal/i);
  const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  assert.match(engine,/getCurrentSessionContext\(chatId,10000\)/);
  assert.match(engine,/extractKnownUserIdFromMessages\(rows\)/);
});

test('v1.33.1 typo normalizer covers the requested high-frequency variants',()=>{
  assert.match(normalizeText('widhdraw sy blm msokk'),/withdraw.*belum.*masuk/);
  assert.match(normalizeText('depsoitt blumm masokk'),/deposit.*belum.*masuk/);
  assert.match(normalizeText('resset paswrd'),/reset password/);
  assert.match(normalizeText('aksess eror'),/akses error/);
});
