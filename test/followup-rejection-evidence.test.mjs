import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileQuestionnaireTimes,conversationScopeClosed} from '../src/calendar/confirmedAnswers.js';
import {evaluateRchEligibility} from '../src/calendar/rchEligibility.js';
import {createHandler} from '../src/connector.mjs';
for(const text of ['Ah... yo le tengo de libre inversion','Es un préstamo de libranza','Quiero realizar un crédito',
 'No he hecho préstamo con banco nunca','Yo tengo un préstamo de libranza'])test('cancela por evidencia del producto: '+text,()=>{
 const updates=reconcileQuestionnaireTimes({},[{__typename:'WhatsAppInTextMessage',text}]);
 assert.equal(evaluateRchEligibility(updates).status,'NO_APLICA');
});
for(const text of ['¿Puedo pedir un crédito de libranza?','También tengo un préstamo de libranza',
 'Tengo un crédito hipotecario y otro de libranza','No tengo reportes negativos'])test('no descarta otra obligación: '+text,()=>{
 assert.notEqual(evaluateRchEligibility(reconcileQuestionnaireTimes({},[{__typename:'WhatsAppInTextMessage',text}])).status,'NO_APLICA');
});
test('el seguimiento utiliza la libranza declarada aunque Fuely no guarde atributos',async()=>{
 const id='wa_11_22_573001234567';let writes=0;
 const handle=createHandler({env:{CHATFUEL_BOT_ID:'test',CHATFUEL_API_TOKEN:'test',CHATFUEL_BOOKING_SECRET:'s'.repeat(32)},scheduling:{request:async()=>assert.fail('No reservar')},fetchImpl:async(url,init)=>{
  const q=JSON.parse(init.body).query;if(q.includes('mutation'))writes++;
  return Response.json({data:{bot:{contact:{id,phone:'573001234567',attributes:[]},conversation:{status:'automated',messages:{edges:[
   {node:{__typename:'WhatsAppOutTextMessage',text:'Con gusto',sentTime:'2026-11-23T23:00:01Z'}},
   {node:{__typename:'WhatsAppInTextMessage',text:'Ah... yo le tengo de libre inversion',sentTime:'2026-11-23T23:00:00Z'}},
  ]}}}}});
 }});
 assert.equal((await handle.followupContext(id)).rejected,true);assert.equal(writes,0);
});

test('un cierre comunicado por el bot detiene seguimientos sin inferir datos financieros',()=>{
 const bot=text=>({__typename:'WhatsAppOutTextMessage',sender:{__typename:'AutomationMessageSender'},text});
 const closed=bot('Según lo que me contaste, tu caso no corresponde a crédito de vivienda ni leasing habitacional activo. Este canal no puede continuar ese perfilamiento.');
 assert.equal(conversationScopeClosed([bot('La tasa debes consultarla con tu banco.'),closed]),true);
 assert.equal(conversationScopeClosed([bot('¿Con qué banco tienes el crédito?'),closed]),false);
 assert.equal(conversationScopeClosed([{...closed,__typename:'WhatsAppInTextMessage'}]),false);
 assert.equal(conversationScopeClosed([{...closed,sender:{__typename:'ExternalAppSender'}}]),false);
});
