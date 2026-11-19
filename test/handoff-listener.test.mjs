import test from 'node:test';
import assert from 'node:assert/strict';
import {startHandoffListener} from '../src/connector.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const timers=new Map(),sockets=[];let id=0,calls=0;
  class Socket{
    readyState=1;
    constructor(){sockets.push(this);}
    send(){}
    close(){this.readyState=3;this.onclose?.();}
  }
  const handler={handoffStatus:{},async synchronizeHandoffs(){
    calls++;handler.handoffStatus.bookingRetryAfterMs=calls===1?10_000:null;
  }};
  const stop=startHandoffListener(handler,{env:{CHATFUEL_API_TOKEN:'mock',CHATFUEL_BOT_ID:'mock'},
    WebSocketImpl:Socket,delay:(fn,ms)=>{const key=++id;timers.set(key,{fn,ms});return key;},
    cancelDelay:key=>timers.delete(key)});
  const ack=()=>sockets[0].onmessage({data:JSON.stringify({type:'connection_ack'})});
  return {stop,ack,timers,get calls(){return calls;},run(key){const {fn}=timers.get(key);timers.delete(key);fn();}};
}

test('el observador vuelve a comprobar una aceptación sin esperar otro mensaje',async()=>{
  const f=fixture();f.ack();await flush();
  assert.equal(f.calls,1);assert.equal(f.timers.size,2);
  const retry=[...f.timers.keys()].at(-1);
  assert.equal(f.timers.get(retry).ms,10_000);
  f.run(retry);await flush();
  assert.equal(f.calls,2);assert.equal(f.timers.size,1);
  f.stop();assert.equal(f.timers.size,0);
});

test('detener el observador cancela también el reintento de agenda',async()=>{
  const f=fixture();f.ack();await flush();
  assert.equal(f.calls,1);assert.equal(f.timers.size,2);
  f.stop();await flush();
  assert.equal(f.timers.size,0);assert.equal(f.calls,1);
});
