import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationActivity, explicitOptOut } from '../src/followups/activity.js';
import {createFollowupService} from '../src/followups/service.js';

const start=Date.parse('2026-11-20T12:00:00Z'),at=h=>new Date(start+h*3600000).toISOString();
function fixture(channel='Chatfuel'){
  let now=start,record=null;
  const config={enabled:true,ready:true,inactivity:true,enrollAfter:at(0),category:'370',
    channels:{Chatfuel:{stage:'C370:NEW',fromId:'24020'},DalIA:{stage:'C370:PREPARATION',fromId:'25152'}},
    templates:{[channel]:{1:'one',24:'day',72:'last'}},webhooks:{[channel]:{1:'https://example.com/1',24:'https://example.com/24',72:'https://example.com/72'}},
    payload:{phone:'{{phone}}',fromId:'{{fromId}}'},setterIds:['101','202']};
  const lead={id:'33',phone:'573001234567',channel,responsible:'7',initialAt:at(0)};
  let snapshot={verified:true,activityVerified:true,id:lead.id,phone:lead.phone,category:'370',
    stage:config.channels[channel].stage,responsible:'7',incoming:false};
  const sent=[],handed=[];
  const store={withContact:async(ch,ph,fn)=>fn(structuredClone(record),async r=>{record=structuredClone(r);}),
    nextSetter:async()=>config.setterIds[0],pending:async()=>[{channel,phone:lead.phone}],
    discoveryCursor:async()=>'0',advanceCursor:async()=>{}};
  const gateway={inspect:async()=>structuredClone(snapshot),discover:async()=>({leads:[],cursor:'0'}),
    send:async req=>{sent.push(req);return {accepted:true,messageId:String(900+sent.length)};},
    delivery:async()=>({status:'delivered'}),handoff:async(...args)=>{handed.push(args);}};
  const service=createFollowupService({config,store,gateway,now:()=>now});
  return {service,lead,sent,handed,gateway,key:{channel,phone:lead.phone},get:()=>record,
    change:p=>{Object.assign(snapshot,p);},hour:h=>{now=start+h*3600000;}};
}

for(const channel of ['DalIA','Chatfuel'])test(`${channel}: responde dos filtros y recibe 1/24/72h desde la última pregunta`,async()=>{
  const f=fixture(channel);f.hour(0.5);f.change({incoming:true,lastIncomingAt:at(0.4),lastPromptAt:at(0.5)});
  await f.service.enroll(f.lead);
  f.hour(1);await f.service.process(f.key);assert.equal(f.sent.length,0);
  for(const hour of [1.5,24.5,72.5]){f.hour(hour);await f.service.process(f.key);await f.service.process(f.key);}
  assert.equal(f.sent.length,3);assert.equal(f.handed.length,1);
  assert.equal(f.get().anchorAt,at(0.5));assert.equal(f.get().status,'completed');
});

test('una respuesta reinicia los tiempos, conserva evidencia y no repite la clave de envío',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.hour(1);await f.service.process(f.key);
  f.hour(2);f.change({incoming:true,lastIncomingAt:at(2),lastPromptAt:at(2)});
  await f.service.process(f.key);assert.equal(f.sent.length,1);assert.equal(f.get().previousCycles.length,1);
  f.hour(3);await f.service.process(f.key);assert.equal(f.sent.length,2);
  assert.notEqual(f.sent[0].key,f.sent[1].key);
  await f.service.process(f.key);assert.equal(f.sent.length,2);
});

test('espera que el bot conteste antes de programar otro ciclo',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.hour(2);
  f.change({incoming:true,lastIncomingAt:at(2)});await f.service.process(f.key);
  f.hour(5);await f.service.process(f.key);assert.equal(f.sent.length,0);assert.equal(f.get().status,'awaiting_activity');
  f.change({lastPromptAt:at(5)});await f.service.process(f.key);
  assert.equal(f.get().nextDueAt,at(6));f.hour(6);await f.service.process(f.key);assert.equal(f.sent.length,1);
});

test('respuesta que llega justo antes del envío invalida la intención anterior',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.hour(1);
  const inspect=f.gateway.inspect;let reads=0;
  f.gateway.inspect=async()=>({...await inspect(),...(++reads===2?{incoming:true,lastIncomingAt:at(1),lastPromptAt:at(1)}:{})});
  await f.service.process(f.key);assert.equal(f.sent.length,0);assert.equal(f.get().nextDueAt,at(2));
});

for(const patch of [{optOut:true},{human:true},{appointment:true},{rejected:true},{stage:'C370:EXECUTING'},{responsible:'999'}])
test(`inactividad mantiene protección ${JSON.stringify(patch)}`,async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.hour(1);f.change(patch);await f.service.process(f.key);
  assert.equal(f.sent.length,0);assert.equal(f.get().status,'cancelled');
});

test('consulta incompleta no envía ni modifica la etapa',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.hour(1);f.change({activityVerified:false});
  await assert.rejects(f.service.process(f.key),/ACTIVITY_UNVERIFIED/);assert.equal(f.sent.length,0);
});

test('el clic cancela pendientes y permite continuar únicamente cuando el bot responde',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.hour(1);await f.service.process(f.key);
  await f.service.cancel('Chatfuel',f.lead.phone);assert.equal(f.get().status,'awaiting_activity');
  f.hour(2);f.change({incoming:true,lastIncomingAt:at(2),lastPromptAt:at(2)});await f.service.process(f.key);
  assert.equal(f.get().nextDueAt,at(3));assert.equal(f.sent.length,1);
});

test('cancelar mientras se propaga el clic nunca dispara el siguiente paso anterior',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.hour(24);
  await f.service.cancel('Chatfuel',f.lead.phone);await f.service.process(f.key);
  assert.equal(f.sent.length,0);assert.equal(f.get().status,'awaiting_activity');
});

test('actividad nativa cubre respuestas que Wasapi no refleja y las plantillas no reinician el reloj',()=>{
  const a=conversationActivity([{type:'out',message_type:'template',created_at:at(5),status:'read'}],
    {lastIncomingAt:at(1),lastPromptAt:at(2),lastIncomingText:'No tengo reportes negativos'},at(0));
  assert.equal(a.lastIncomingAt,at(1));assert.equal(a.lastPromptAt,at(2));assert.equal(a.optOut,false);
  assert.equal(explicitOptOut('No me interesa, gracias'),true);
  assert.equal(explicitOptOut('No me interesa aumentar mi cuota'),false);
});

for(const text of ['Eres una IA. No quiero continuar','No, gracias','No gracias',
  'Gracias, no quiero seguir con el proceso','No quiero continuar con esto, gracias'])
test(`reconoce la baja completa dentro del mensaje: ${text}`,()=>{
  assert.equal(explicitOptOut(text),true);
});

for(const text of ['No','No tengo reportes negativos','No tengo crédito de vivienda',
  'No me interesa aumentar mi cuota','No quiero continuar con ese horario',
  'No gracias al banco, sigo interesado'])
test(`no confunde una respuesta financiera ni un cambio de horario con una baja: ${text}`,()=>{
  assert.equal(explicitOptOut(text),false);
});

test('la baja de Sandra cancela el ciclo aunque el bot haya respondido después',async()=>{
  const f=fixture('DalIA');await f.service.enroll(f.lead);f.hour(2);
  const activity=conversationActivity([
    {type:'in',message:'Eres una IA. No quiero continuar',created_at:at(0.5)},
    {type:'out',message_type:'text',status:'delivered',created_at:at(0.6)},
    {type:'in',message:'Gracias',created_at:at(0.7)},
    {type:'out',message_type:'text',status:'read',created_at:at(0.8)},
  ],{},at(0));
  f.change({...activity,incoming:true});await f.service.process(f.key);
  assert.equal(f.sent.length,0);assert.equal(f.handed.length,0);
  assert.equal(f.get().status,'cancelled');
});

test('una baja anterior al ingreso actual no se atribuye al nuevo ciclo',()=>{
  const activity=conversationActivity([
    {type:'in',message:'No quiero continuar',created_at:at(-1)},
    {type:'in',message:'Sí, me interesa',created_at:at(1)},
  ],{},at(0));
  assert.equal(activity.optOut,false);
});
