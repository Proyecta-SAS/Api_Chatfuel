import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileQuestionnaireTimes} from '../src/calendar/confirmedAnswers.js';
import {evaluateRchEligibility} from '../src/calendar/rchEligibility.js';
const incoming=text=>({__typename:'WhatsAppInTextMessage',text});
const outgoing=text=>({__typename:'WhatsAppOutTextMessage',text});

test('recovers the last confirmed term and time paid without replacing FNA with the product',()=>{
 const old={rch_banco:'Crédito hipotecario',banco_entidad:'Crédito hipotecario',
   rch_plazo_inicial:'creo que 20',rch_tiempo_pagando:'creo que 5 meses',
   obligacion_vivienda_activa:'sí',rch_reportes_negativos:'no',rch_puede_aumentar_cuota:'si'};
 const messages=[outgoing('¿Con qué banco tienes actualmente tu crédito hipotecario o leasing habitacional?'),
  incoming('Fondo nacional del ahorro'),incoming('Crédito hipotecario'),
  outgoing('¿A cuántos años tomaste originalmente tu crédito?'),incoming('Creo que 20'),
  outgoing('Gracias. ¿Tu crédito fue tomado a 20 años exactos o a cuántos años fue?'),incoming('20'),
  outgoing('¿Cuánto tiempo llevas pagando tu crédito?'),incoming('Creo que 5 meses'),
  outgoing('¿Llevas 5 meses exactos pagando tu crédito?'),incoming('9 meses')].reverse();
 const updates=reconcileQuestionnaireTimes(old,messages),result={...old,...updates};
 assert.equal(result.rch_banco,'Fondo nacional del ahorro');
 assert.equal(result.banco_entidad,'Fondo nacional del ahorro');
 assert.equal(result.rch_plazo_inicial,'20 años');
 assert.equal(result.rch_tiempo_pagando,'9 meses');
 assert.equal(evaluateRchEligibility(result).status,'APLICA');
});

test('preserves real bank corrections and uncertainty until a numeric answer exists',()=>{
 const q=outgoing('¿Con qué banco tienes actualmente tu crédito hipotecario?');
 assert.equal(reconcileQuestionnaireTimes({},[incoming('Davivienda'),incoming('Fondo nacional del ahorro'),q]).rch_banco,'Davivienda');
 for(const product of ['Crédito hipotecario','Leasing habitacional','Préstamo de libranza']){
  const updates=reconcileQuestionnaireTimes({rch_banco:'FNA'},[incoming(product),q]);
  assert.equal(updates.rch_banco,undefined);
 }
 const updates=reconcileQuestionnaireTimes({},[
  incoming('Creo que 20'),outgoing('¿Tu crédito fue tomado a 20 años exactos o a cuántos años fue?')]);
 assert.equal(evaluateRchEligibility({...updates,rch_banco:'FNA',rch_reportes_negativos:'no',rch_puede_aumentar_cuota:'si'}).status,'PENDIENTE');
});
