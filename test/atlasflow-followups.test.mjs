import test from 'node:test';
import assert from 'node:assert/strict';
import {atlasflowRequest,atlasflowAccepted} from '../src/followups/atlasflow.js';
import {createFollowupGateway} from '../src/followups/gateway.js';

const query=new URLSearchParams({deal_id:'{{ID}}',uuid:'00000000-0000-0000-0000-000000000001',
  from_id:'25152',numero_cel:'{{TELÉFONO CLIENTE (DEF)}}',etapa:'CAMPAÑAS CHATFUEL',variables:JSON.stringify({'1':'{{TITLE}}'})});
const url=`https://atlasflow.proyectasolutions.co/app-whatsapp-automation/bitrix?${query}`;
const context={dealId:'123',phone:'573001234567',fromId:'25152',name:'Nombre & apellido',channel:'DalIA'};

test('resuelve macros conservando la etapa de Atlas y la línea de DalIA',()=>{
  const request=atlasflowRequest(url,context);
  assert.equal(request.url,'https://atlasflow.proyectasolutions.co/app-whatsapp-automation/bitrix');
  assert.equal(request.body.etapa,'CAMPAÑAS CHATFUEL');assert.equal(request.body.from_id,'25152');
  assert.equal(request.body.deal_id,'123');assert.equal(request.body.numero_cel,context.phone);
  assert.equal(request.body.variables['1'],'Nombre & apellido');
  assert.equal(JSON.stringify(request).includes('{{'),false);
  assert.throws(()=>atlasflowRequest(url,{...context,fromId:'24020'}),/MISMATCH/);
});

test('recibido por Atlas, dry run o fallo Wasapi no confirman un recordatorio',()=>{
  assert.equal(atlasflowAccepted({accepted:true,status:'accepted'}),false);
  assert.equal(atlasflowAccepted({accepted:true,legacy_status:'error'}),false);
  const result={accepted:true,actions_result:{primary_action:{artifacts:{delivery_result:{mode:'wasapi',
    status:'submitted_wasapi',can_dispatch:true,http_status:200,response_payload:{sent:1,not_sent:0,logs:[{success:true}]}}}}}};
  assert.equal(atlasflowAccepted(result),true);
  result.actions_result.primary_action.artifacts.delivery_result.mode='dry_run';
  assert.equal(atlasflowAccepted(result),false);
  assert.equal(atlasflowAccepted({status:'ok',respuesta:{sent:0,not_sent:1}}),false);
});

test('el adaptador hace un solo POST con datos reales; no ejecuta la URL como GET',async()=>{
  let count=0;
  const gateway=createFollowupGateway({config:{},fetchImpl:async(target,request)=>{
    count++;assert.equal(target,'https://atlasflow.proyectasolutions.co/app-whatsapp-automation/bitrix');
    assert.equal(request.method,'POST');assert.equal(JSON.parse(request.body).from_id,'25152');
    return Response.json({status:'ok',respuesta:{sent:1,not_sent:0}});
  }});
  assert.deepEqual(await gateway.send({url,body:{},key:'test-key',context}),{accepted:true});
  assert.equal(count,1);
});
