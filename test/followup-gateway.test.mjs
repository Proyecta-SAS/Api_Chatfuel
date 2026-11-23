import test from 'node:test';
import assert from 'node:assert/strict';
import {createFollowupGateway} from '../src/followups/gateway.js';
import {createHandler} from '../src/connector.mjs';

test('el contexto nativo conserva la baja aunque luego el cliente agradezca',async()=>{
  const id='wa_11_22_573001234567';
  const handler=createHandler({env:{CHATFUEL_BOT_ID:'test',CHATFUEL_API_TOKEN:'test',CHATFUEL_BOOKING_SECRET:'s'.repeat(32)},
    scheduling:{request:async()=>assert.fail('No reservar')},fetchImpl:async()=>Response.json({data:{bot:{
      contact:{id,phone:'573001234567',attributes:[]},
      conversation:{status:'automated',messages:{edges:[
        {node:{id:'stop',__typename:'WhatsAppInTextMessage',text:'Eres una IA. No quiero continuar',sentTime:'2026-11-22T20:13:00Z'}},
        {node:{id:'thanks',__typename:'WhatsAppInTextMessage',text:'Gracias',sentTime:'2026-11-22T20:14:00Z'}},
      ]}},
    }}})});
  const context=await handler.followupContext(id);
  assert.equal(context.lastIncomingText,'Gracias');assert.equal(context.optOut,true);
});

test('un HTTP 200 con error o sin aceptación explícita no confirma el envío',async()=>{
  for(const body of [{success:false},{error:'invalid_template'},{message:'unknown'}]){
    const gateway=createFollowupGateway({config:{acceptField:'success'},fetchImpl:async()=>Response.json(body)});
    await assert.rejects(gateway.send({url:'https://automation.example',body:{},key:'test'}));
  }
  const gateway=createFollowupGateway({config:{acceptField:'data.accepted'},fetchImpl:async()=>Response.json({data:{accepted:true}})});
  assert.deepEqual(await gateway.send({url:'https://automation.example',body:{},key:'test'}),{accepted:true});
});

test('responder el botón conserva filtros y reservas; No gracias solo cambia control de seguimiento',async()=>{
  const fields={rch_banco:'Bancolombia',rch_reportes_negativos:'no',rch_puede_aumentar_cuota:'',
    rch_plazo_inicial:'20 años',rch_tiempo_pagando:'5 años'};
  const contactId='wa_11_22_573001234567',updates=[];
  const handler=createHandler({env:{CHATFUEL_BOT_ID:'test',CHATFUEL_API_TOKEN:'test',CHATFUEL_BOOKING_SECRET:'s'.repeat(32)},
    scheduling:{request:async()=>{assert.fail('Un botón no debe reservar ni modificar CRM');}},
    fetchImpl:async(url,init)=>{
      const body=JSON.parse(init.body);
      if(body.query.includes('query FollowupContext'))return Response.json({data:{bot:{contact:{id:contactId,phone:'573001234567',
        attributes:Object.entries(fields).map(([name,value])=>({attr:{name},value:{stringValue:value}}))},
        conversation:{status:'automated',messages:{edges:[{node:{id:'button',__typename:'WhatsAppInTextMessage'}}]}}}}});
      for(const match of body.query.matchAll(/attrName:("(?:\\.|[^"\\])*"),attrValue:\$v(\d+)/g)){
        const name=JSON.parse(match[1]);updates.push(name);fields[name]=body.variables[`v${match[2]}`];
      }
      return Response.json({data:{ok:{id:contactId}}});
    }});
  const resumed=await handler.resumeFollowup(contactId);
  assert.match(resumed.message,/aumentando mínimamente/);
  assert.equal(fields.rch_puede_aumentar_cuota,'');
  await handler.stopFollowup(contactId);
  assert.equal(fields.seguimiento_detener,'si');
  const paused=await handler.resumeFollowup(contactId);assert.match(paused.message,/permanece detenido/);
  assert.ok(updates.every(name=>name.startsWith('seguimiento_')));
});

test('el traspaso verifica etapa y responsable sin exigir permisos del directorio de usuarios',async()=>{
  const config={category:'370',channels:{Chatfuel:{stage:'C370:NEW'}},setterIds:['101','202']};
  const lead={id:'33',phone:'573001234567',channel:'Chatfuel',responsible:'7'};
  let deal={ID:'33',UF_CRM_1584616588730:lead.phone,CATEGORY_ID:'370',STAGE_ID:'C370:NEW',ASSIGNED_BY_ID:'7'};
  const updates=[];
  const gateway=createFollowupGateway({config,bitrix:{call:async(method,body)=>{
    if(method==='crm.deal.get')return {...deal};
    if(method==='crm.status.list')return [{STATUS_ID:'C370:TARGET',NAME:'SIN RESPUESTA 3 DÍAS'}];
    if(method==='crm.deal.update'){updates.push(body.fields);deal={...deal,...body.fields};return true;}
    assert.fail('No debe consultar el directorio ni crear actividades: '+method);
  }}});
  await gateway.handoff(lead,'C370:TARGET','101');
  assert.deepEqual(updates,[{STAGE_ID:'C370:TARGET',ASSIGNED_BY_ID:'101'}]);
  await gateway.handoff(lead,'C370:TARGET','101');assert.equal(updates.length,1);
  deal={...deal,STAGE_ID:'C370:NEW',ASSIGNED_BY_ID:'999'};
  await assert.rejects(gateway.handoff(lead,'C370:TARGET','101'),/CRM_CHANGED/);
  assert.equal(updates.length,1);
});

test('consulta el recibo exacto y distingue leído, aceptado y error 131049',async()=>{
  const lead={channel:'Chatfuel',phone:'573001234567'};
  for(const [status,error,expected] of [['sent',null,'pending'],['read',null,'delivered'],['failed','131049','failed']]){
    const gateway=createFollowupGateway({config:{apiKey:'test',channels:{Chatfuel:{fromId:'24020'}}},
      fetchImpl:async()=>Response.json({data:[{id:900,from_id:24020,wa_id:lead.phone,type:'out',message_type:'template',status,error_code:error}],last_page:1})});
    assert.equal((await gateway.delivery(lead,'900')).status,expected);
    assert.equal((await gateway.delivery(lead,'901')).status,'pending');
  }
});

test('sin bienvenida entregada espera sin exigir un chat nativo todavía inexistente',async()=>{
  const phone='573001234567';
  const gateway=createFollowupGateway({config:{inactivity:true,enrollAfter:'2026-11-20T00:00:00Z',channels:{Chatfuel:{fromId:'24020'}}},
    bitrix:{call:async()=>({ID:'33',UF_CRM_1584616588730:phone,CATEGORY_ID:'370',STAGE_ID:'C370:NEW',ASSIGNED_BY_ID:'7'})},
    bookingHandler:{followupContext:async()=>assert.fail('La bienvenida falló; aún no hay conversación nativa')},
    fetchImpl:async()=>Response.json({data:[],last_page:1})});
  assert.equal((await gateway.inspect({id:'33',phone,channel:'Chatfuel',createdAt:'2026-11-20T00:00:00Z'})).activityVerified,true);
});

test('la asignación externa automática permite seguimiento y un humano lo protege',async()=>{
  for(const [assignee,human] of [[{__typename:'ExternalAppAssignee'},false],[{__typename:'FuelyAIAssignee'},false],
    [{__typename:'PublicUserAccount',accountType:'Virtual'},false],[{__typename:'PublicUserAccount',accountType:'Human'},true]]){
    const id='wa_11_22_573001234567';
    const handler=createHandler({env:{CHATFUEL_BOT_ID:'test',CHATFUEL_API_TOKEN:'test',CHATFUEL_BOOKING_SECRET:'s'.repeat(32)},
      scheduling:{request:async()=>assert.fail('No reservar')},fetchImpl:async()=>Response.json({data:{bot:{
        contact:{id,phone:'573001234567',assignee,attributes:[]},conversation:{status:'automated',messages:{edges:[]}}}}})});
    assert.equal((await handler.followupContext(id)).human,human);
  }
});
