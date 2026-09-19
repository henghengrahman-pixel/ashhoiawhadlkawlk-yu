import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveChatClient } from '../src/livechat.js';

test('my_active keeps followed active chats only',()=>{
 const c=new LiveChatClient({base:'x',accountId:'a',pat:'b',inboxMode:'my_active'});
 const items=[
  {id:'1',is_followed:true,last_thread_summary:{active:true}},
  {id:'2',is_followed:false,last_thread_summary:{active:true}},
  {id:'3',is_followed:true,last_thread_summary:{active:false}},
 ];
 assert.deepEqual(c.filterInbox(items).map(x=>x.id),['1']);
});

test('ambiguous active chat without ownership signal is not guessed as my chat',()=>{
 const c=new LiveChatClient({base:'x',accountId:'a',pat:'b'});
 assert.equal(c.isMyActiveChat({id:'1',last_thread_summary:{active:true}}),false);
 assert.equal(c.classifyChatLane({id:'1',last_thread_summary:{active:true}}),'OTHER');
 assert.equal(c.isMyActiveChat({id:'2',last_thread_summary:{active:false}}),false);
});
