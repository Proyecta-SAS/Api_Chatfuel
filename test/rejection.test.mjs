import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeRejection, REJECTION_STAGE } from '../src/calendar/rejection.js';

function fixture(patch={}) {
  const deal={ID:'777',CATEGORY_ID:'370',STAGE_ID:'C370:NEW',CLOSED:'N',UF_CRM_1584616588730:'+573001234567',UF_CRM_1726241234:'',...patch};
  const writes=[];
  let booking=false,fail=false;
  const profile={clientCode:'CF-TEST',phone:'573001234567',data:{answers:{rch_banco:'BBVA'}}};
  const store={withLock:async(key,fn)=>fn(store),hasActiveAppointment:async()=>booking};
  const bitrix={call:async(method,params)=>{
    if(method==='crm.deal.get')return {...deal};
    assert.equal(method,'crm.deal.update');writes.push(params);
    if(fail)throw new Error('Synthetic outage');
    Object.assign(deal,params.fields);return true;
  }};
  return {profile,deal,writes,run:()=>synchronizeRejection({profile,registered:{id_negociacion:'777'},store,bitrix}),
    set booking(v){booking=v;},set fail(v){fail=v;}};
}

test('Chatfuel moves an excluded bank before completing the other questions, then deduplicates',async()=>{
  const f=fixture();assert.equal((await f.run()).status,'completed');assert.equal(f.deal.STAGE_ID,REJECTION_STAGE);
  assert.deepEqual(f.writes,[{id:'777',fields:{STAGE_ID:REJECTION_STAGE}}]);
  assert.equal((await f.run()).status,'completed');assert.equal(f.writes.length,1);
});

test('partial or ambiguous data never request a rejection',async()=>{
  for(const answers of [{},{rch_banco:'Bancolombia'},{rch_banco:'no es BBVA, es otro'},
    {rch_reportes_negativos:'no se'},{rch_tiempo_pagando:'entre 4 y 6 años'}]){
    const f=fixture();f.profile.data.answers=answers;
    assert.equal((await f.run()).status,'skipped');assert.equal(f.writes.length,0);
  }
});

test('each explicit disqualifier uses the same Chatfuel destination',async()=>{
  for(const answers of [{obligacion_vivienda_activa:'no'}, {rch_reportes_negativos:'si'},
    {rch_puede_aumentar_cuota:'no'},{rch_plazo_inicial:'20 años',rch_tiempo_pagando:'15 años'}]){
    const f=fixture();f.profile.data.answers=answers;
    assert.equal((await f.run()).status,'completed');assert.equal(f.deal.STAGE_ID,REJECTION_STAGE);
  }
});

test('appointments, foreign channels, changed stages and mismatched phone numbers are protected',async()=>{
  for(const patch of [{STAGE_ID:'C370:PREPARATION'},{STAGE_ID:'C370:EXECUTING'},
    {STAGE_ID:'C370:WON'},{CLOSED:'Y'},{UF_CRM_1726241234:'2026-11-10T10:00:00-05:00'},
    {UF_CRM_1584616588730:'573009999999'},{UF_CRM_1584616588730:''}]){
    const f=fixture(patch);assert.equal((await f.run()).status,'skipped');assert.equal(f.writes.length,0);
  }
  const booked=fixture();booked.booking=true;assert.equal((await booked.run()).reason,'BOOKING_EXISTS');
  const wrong=fixture({CATEGORY_ID:'8'});await assert.rejects(wrong.run(),/INVALID_REJECTION_DEAL/);assert.equal(wrong.writes.length,0);
});

test('a failed stage write can be retried without any booking or message operation',async()=>{
  const f=fixture();f.fail=true;await assert.rejects(f.run(),/Synthetic outage/);
  assert.equal(f.deal.STAGE_ID,'C370:NEW');f.fail=false;assert.equal((await f.run()).status,'completed');
});
