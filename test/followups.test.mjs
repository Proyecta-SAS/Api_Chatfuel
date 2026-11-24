import test from 'node:test';
import assert from 'node:assert/strict';
import {readFollowupConfig,isFollowupButton,isFollowupDecline} from '../src/followups/policy.js';
import {createFollowupService} from '../src/followups/service.js';
import {createFollowupHandler} from '../src/followups/http.js';

const START=Date.parse('2026-11-18T15:00:00Z');
const ENV={FOLLOWUPS_ENABLED:'true',WASAPI_API_KEY:'test-only',FOLLOWUPS_ENROLL_AFTER:new Date(START).toISOString(),
  FOLLOWUPS_CHATFUEL_CONTACT_PREFIX:'wa_11_22_',FOLLOWUPS_TEMPLATES_APPROVED:'true',FOLLOWUPS_SETTER_IDS:'101,202',
  FOLLOWUPS_WEBHOOK_ACCEPT_FIELD:'success',
  FOLLOWUPS_WEBHOOK_BODY_JSON:JSON.stringify({phone:'{{phone}}',from_id:'{{fromId}}',name:'{{name}}',template:'{{template}}'}),
  ...Object.fromEntries([1,24,72].flatMap(h=>[[`FOLLOWUPS_${h}H_WEBHOOK_URL`,`https://automation.example/${h}`],
    [`FOLLOWUPS_${h}H_TEMPLATE_NAME`,`test_followup_${h}`]]))};

function fixture(channel='Chatfuel') {
  const config=readFollowupConfig(ENV),records=new Map(),locks=new Map(),sent=[],handed=[];
  let at=START,setter=0,snapshot={verified:true,id:'33',phone:'573001234567',category:'370',stage:config.channels[channel].stage,
    responsible:'7',incoming:false,human:false,appointment:false,rejected:false};
  const store={
    discoveryCursor:async()=>'0',advanceCursor:async()=>{},
    async withContact(ch,phone,action){
      const key=`${ch}:${phone}`,prior=locks.get(key)||Promise.resolve();
      let unlock;const next=new Promise(resolve=>{unlock=resolve;});locks.set(key,next);await prior;
      try{return await action(structuredClone(records.get(key)||null),async value=>{records.set(key,structuredClone(value));});}
      finally{unlock();}
    },
    async nextSetter(ids){return ids[setter++%ids.length];},
    async pending(now){return [...records.values()].filter(r=>['pending','delivery_pending','handoff_pending'].includes(r.status)&&r.nextDueAt<=now)
      .map(r=>({channel:r.lead.channel,phone:r.lead.phone}));},
  };
  const gateway={inspect:async()=>structuredClone(snapshot),discover:async()=>({leads:[],cursor:'0'}),
    send:async value=>{sent.push(value);return {accepted:true,messageId:'900'};},
    delivery:async()=>({status:'delivered'}),
    handoff:async (...args)=>{handed.push(args);snapshot.stage=config.targetStage;snapshot.responsible=args[2];}};
  const service=createFollowupService({config,store,gateway,now:()=>at});
  const lead={id:'33',phone:'3001234567',channel,name:'Persona de prueba',responsible:'7',initialAt:new Date(START).toISOString()};
  const key={channel,phone:'573001234567'};
  return {service,lead,key,store,records,gateway,config,sent,handed,setHour:h=>{at=START+h*3600000;},
    change:patch=>{Object.assign(snapshot,patch);},get:()=>records.get(`${channel}:${key.phone}`)};
}

test('no permite activar sin aprobación, contrato, hora de inicio o webhooks',()=>{
  for(const name of ['FOLLOWUPS_TEMPLATES_APPROVED','FOLLOWUPS_ENROLL_AFTER','FOLLOWUPS_24H_WEBHOOK_URL',
    'FOLLOWUPS_WEBHOOK_BODY_JSON','FOLLOWUPS_CHATFUEL_CONTACT_PREFIX','FOLLOWUPS_SETTER_IDS']){
    assert.throws(()=>readFollowupConfig({...ENV,[name]:''}),/INCOMPLETE/);
  }
  assert.equal(readFollowupConfig({}).enabled,false);
});

test('reconoce ambos botones de la captura sin confundir sí/no financieros',()=>{
  assert.ok(isFollowupButton('Sí, me interesa'));
  assert.ok(isFollowupDecline('No, gracias'));
  assert.equal(isFollowupButton('Sí'),false);
  assert.equal(isFollowupDecline('No'),false);
});

for(const channel of ['DalIA','Chatfuel'])test(`${channel}: plazos desde contacto inicial y tercero deriva una sola vez`,async()=>{
  const f=fixture(channel);await f.service.enroll(f.lead);
  await f.service.process(f.key);assert.equal(f.sent.length,0);
  for(const hour of [1,24,72]){f.setHour(hour);await f.service.process(f.key);await f.service.process(f.key);}
  assert.equal(f.sent.length,3);assert.equal(new Set(f.sent.map(s=>s.key)).size,3);
  assert.equal(f.sent[0].body.from_id,f.config.channels[channel].fromId);
  assert.equal(f.sent[0].body.phone,'573001234567');
  assert.equal(f.handed.length,1);assert.equal(f.handed[0][2],'101');assert.equal(f.get().status,'completed');
});

test('una respuesta después del primer recordatorio cancela 24 y 72 horas',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.setHour(1);await f.service.process(f.key);
  f.change({incoming:true});f.setHour(72);await f.service.process(f.key);
  assert.equal(f.sent.length,1);assert.equal(f.get().status,'cancelled');assert.equal(f.handed.length,0);
});

for(const patch of [{human:true},{appointment:true},{rejected:true},{optOut:true},{stage:'C370:EXECUTING'},
  {category:'8'},{phone:'573009999999'},{responsible:'999'}])test(`respeta cambio protegido ${JSON.stringify(patch)}`,async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.change(patch);f.setHour(1);await f.service.process(f.key);
  assert.equal(f.sent.length,0);assert.equal(f.get().status,'cancelled');
});

test('revalida cuando la respuesta llega entre la primera comprobación y el envío',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.setHour(1);
  const original=f.gateway.inspect;let reads=0;
  f.gateway.inspect=async lead=>({...await original(lead),incoming:++reads===2});
  await f.service.process(f.key);assert.equal(f.sent.length,0);
});

test('reinicios y dos trabajadores concurrentes no repiten un envío',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.setHour(1);
  const other=createFollowupService({config:f.config,store:f.store,gateway:f.gateway,now:()=>START+3600000});
  await Promise.all([f.service.process(f.key),other.process(f.key)]);
  assert.equal(f.sent.length,1);
  await other.enroll({...f.lead,id:'44'});assert.equal(f.get().lead.id,'33');
});

test('respuesta externa incierta requiere revisión y no se reintenta',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.setHour(1);
  f.gateway.send=async()=>{f.sent.push('attempt');throw new Error('timeout');};
  await f.service.process(f.key);await f.service.process(f.key);f.setHour(72);await f.service.tick();
  assert.equal(f.sent.length,1);assert.equal(f.get().status,'review');
});

test('no acumula mensajes de 1 y 24 horas al volver de una interrupción',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.setHour(25);
  await f.service.process(f.key);await f.service.process(f.key);
  assert.equal(f.sent.length,1);assert.ok(f.sent[0].url.endsWith('/24'));
  assert.equal(f.get().steps[1].status,'skipped_expired');
});

test('no vuelve a enviar el tercero cuando Bitrix falla después de aceptarlo',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.setHour(72);await f.service.process(f.key);
  f.gateway.handoff=async()=>{throw new Error('CRM timeout');};
  await assert.rejects(f.service.process(f.key));assert.equal(f.sent.length,1);
  f.gateway.handoff=async()=>{};await f.service.process(f.key);
  assert.equal(f.sent.length,1);assert.equal(f.get().status,'completed');
});

test('espera la bienvenida entregada y cuenta la hora desde ese envío, no desde el ingreso CRM',async()=>{
  const f=fixture();let initial=null;
  f.gateway.initialContact=async()=>initial;
  await f.service.enroll({...f.lead,initialAt:null,createdAt:f.lead.initialAt});
  f.setHour(3);await f.service.process(f.key);assert.equal(f.get().status,'waiting_initial');
  initial=new Date(START+3*3600000).toISOString();await f.service.process(f.key);
  assert.equal(f.get().status,'pending');await f.service.process(f.key);assert.equal(f.sent.length,0);
  f.setHour(4);await f.service.process(f.key);assert.equal(f.sent.length,1);
});

test('un clic tardío conserva una asignación humana posterior',async()=>{
  const f=fixture();await f.service.enroll(f.lead);
  f.change({stage:f.config.targetStage,responsible:'101'});
  assert.equal((await f.service.resumeGuard('Chatfuel',f.key.phone)).protected,true);
});

test('al aceptar la plantilla de 72 horas cambia de etapa sin otra espera',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.setHour(72);await f.service.process(f.key);
  f.gateway.send=async value=>{f.sent.push(value);f.change({incoming:true});return {accepted:true,messageId:'900'};};
  await f.service.process(f.key);
  assert.equal(f.sent.length,1);assert.equal(f.handed.length,1);assert.equal(f.get().status,'completed');
});

test('un rechazo asíncrono 131049 no cambia etapa ni reenvía la plantilla',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.setHour(72);await f.service.process(f.key);
  f.gateway.delivery=async()=>({status:'pending'});
  await f.service.process(f.key);
  assert.equal(f.get().status,'delivery_pending');assert.equal(f.handed.length,0);
  f.gateway.delivery=async()=>({status:'failed',errorCode:'131049'});
  await f.service.process(f.key);await f.service.process(f.key);f.setHour(120);await f.service.tick();
  assert.equal(f.sent.length,1);assert.equal(f.handed.length,0);assert.equal(f.get().status,'review');
  assert.equal(f.get().steps[72].status,'failed');assert.equal(f.get().steps[72].errorCode,'131049');
  assert.ok(Date.parse(f.get().steps[72].retryNotBefore)>=START+96*3600000);
});

test('traslada inmediatamente al confirmar entrega de 72h, sin otra espera ni duplicados',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.setHour(72);await f.service.process(f.key);
  f.gateway.delivery=async()=>({status:'pending'});await f.service.process(f.key);
  assert.equal(f.sent.length,1);assert.equal(f.handed.length,0);
  f.gateway.delivery=async()=>({status:'delivered'});await f.service.process(f.key);await f.service.process(f.key);
  assert.equal(f.sent.length,1);assert.equal(f.handed.length,1);assert.equal(f.get().status,'completed');
});

test('un identificador ausente o una entrega no confirmada quedan en revisión',async()=>{
  for(const absent of [true,false]){
    const f=fixture();await f.service.enroll(f.lead);f.setHour(1);
    if(absent)f.gateway.send=async v=>{f.sent.push(v);return {accepted:true};};
    else f.gateway.delivery=async()=>({status:'pending'});
    await f.service.process(f.key);f.setHour(2);await f.service.process(f.key);
    assert.equal(f.sent.length,1);assert.equal(f.handed.length,0);assert.equal(f.get().status,'review');
  }
});

test('pospone envíos nocturnos y retoma al abrir la franja de Colombia',async()=>{
  const f=fixture();await f.service.enroll(f.lead);
  f.setHour(17);await f.service.process(f.key);
  assert.equal(f.sent.length,0);
  assert.equal(f.get().nextDueAt,'2026-11-19T13:30:00.000Z');
  f.setHour(22.5);await f.service.process(f.key);
  assert.equal(f.sent.length,1);
});

test('un recibo tardío de 72h completa el traslado sin repetir el mensaje',async()=>{
  const f=fixture();await f.service.enroll(f.lead);f.setHour(72);
  await f.service.process(f.key);
  f.gateway.delivery=async()=>({status:'pending'});
  await f.service.process(f.key);f.setHour(73);await f.service.process(f.key);
  assert.equal(f.get().reason,'delivery_unconfirmed');
  assert.equal(f.get().status,'review');
  f.gateway.delivery=async()=>({status:'delivered'});
  await f.service.process(f.key);await f.service.process(f.key);
  assert.equal(f.sent.length,1);assert.equal(f.handed.length,1);
  assert.equal(f.get().status,'completed');assert.equal(f.get().reason,undefined);
});

test('permite nombres de plantilla distintos para cada linea',()=>{
  const config=readFollowupConfig({...ENV,FOLLOWUPS_CHATFUEL_1H_TEMPLATE_NAME:'seguimiento_1h_chatfuel'});
  assert.equal(config.templates.Chatfuel[1],'seguimiento_1h_chatfuel');
  assert.equal(config.templates.DalIA[1],'test_followup_1');
});

test('el webhook de un botón valida autenticación e identidad y cancela antes de responder',async()=>{
  const f=fixture();await f.service.enroll(f.lead);let resumed=0,stopped=0;
  const bookingHandler={followupContext:async()=>({phone:f.key.phone}),
    resumeFollowup:async()=>{resumed++;assert.equal(f.get().status,'cancelled');return {message:'¿Con qué banco?',done:'si'};},
    stopFollowup:async()=>{stopped++;return {message:'Detendremos los recordatorios',done:'si'};}};
  const secret='x'.repeat(32),handler=createFollowupHandler({service:f.service,bookingHandler,secret,contactPrefix:'wa_11_22_'});
  const req=(message,token=secret,id='wa_11_22_573001234567')=>new Request('https://test/followups/resume',{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({contactId:id,message})});
  assert.equal((await handler(req('Sí, me interesa','wrong'))).status,401);
  assert.equal((await handler(req('Sí, me interesa',secret,'wa_99_22_573001234567'))).status,422);
  assert.equal((await handler(req('Sí'))).status,422);
  assert.equal((await handler(req('Sí, me interesa'))).status,200);
  assert.equal((await handler(req('No, gracias'))).status,200);
  assert.equal(resumed,1);assert.equal(stopped,1);
});

test('solo el numero de prueba autorizado puede probar un boton sin cola de envio',async()=>{
  const f=fixture();let resumed=0;
  const bookingHandler={followupContext:async id=>({phone:id.split('_').at(-1)}),
    resumeFollowup:async()=>{resumed++;return {message:'¿Con qué banco?',human:'no',done:'si'};}};
  const secret='x'.repeat(32),handler=createFollowupHandler({service:f.service,bookingHandler,secret,
    contactPrefix:'wa_11_22_',testPhones:['573001234567']});
  const req=phone=>new Request('https://test/followups/resume',{method:'POST',headers:{Authorization:`Bearer ${secret}`},
    body:JSON.stringify({contactId:'wa_11_22_'+phone,message:'Sí, me interesa'})});
  assert.equal((await (await handler(req('573001234567'))).json()).human,'no');
  assert.equal((await (await handler(req('573009999999'))).json()).human,'si');
  assert.equal(resumed,1);
});
