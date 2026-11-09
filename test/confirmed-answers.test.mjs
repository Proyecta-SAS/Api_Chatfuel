import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileQuestionnaireTimes} from '../src/calendar/confirmedAnswers.js';
const out=text=>({__typename:'WhatsAppOutTextMessage',text});
const incoming=text=>({__typename:'WhatsAppInTextMessage',text});
const original=()=>out('¿A cuántos años tomaste originalmente tu crédito? Por ejemplo: 15, 20 o 30 años.');
const paid=()=>out('Gracias por aclararlo 😊 Entonces tomo como plazo original 30 años. Ahora sí, ¿cuánto tiempo llevas pagando tu crédito?');
test('la última corrección reemplaza los tiempos antiguos sin repetir el perfil',()=>{
  const chronological=[original(),incoming('20 años'),original(),incoming('a 30 años'),paid(),incoming('10 años'),
    original(),incoming('Ya te dije que 30 años'),paid(),incoming('10 años ya te lo habia dicho'),
    out('¿Te gustaría agendar una llamada con un asesor?'),incoming('Que siiiiiii')];
  assert.deepEqual(reconcileQuestionnaireTimes({rch_plazo_inicial:'aproximadamente 28 años',rch_tiempo_pagando:'aproximadamente 6 años'},chronological.reverse()),
    {rch_plazo_inicial:'30 años',rch_tiempo_pagando:'10 años'});
});
test('no convierte ejemplos, respuestas a otra pregunta ni aproximaciones en cifras exactas',()=>{
  assert.deepEqual(reconcileQuestionnaireTimes({},[incoming('sí'),original()]),{});
  assert.deepEqual(reconcileQuestionnaireTimes({},[incoming('aproximadamente 6 años'),paid()]),{rch_tiempo_pagando:'aproximadamente 6 anos'});
  assert.deepEqual(reconcileQuestionnaireTimes({},[incoming('10'),paid()]),{});
});
test('acepta meses y no reutiliza respuestas anteriores a un reinicio explícito',()=>{
  assert.deepEqual(reconcileQuestionnaireTimes({},[incoming('18 meses'),paid()]),{rch_tiempo_pagando:'18 meses'});
  assert.deepEqual(reconcileQuestionnaireTimes({},[incoming('quiero empezar de cero'),incoming('30 años'),original()]),{});
});

test('la respuesta real de BBVA reemplaza el banco anterior y los ejemplos no se guardan',()=>{
  const q=out('¿Con qué banco tienes actualmente tu crédito hipotecario o leasing habitacional?');
  assert.deepEqual(reconcileQuestionnaireTimes({rch_banco:'Bancolombia'},[incoming('BBVA'),q]),{rch_banco:'BBVA',banco_entidad:'BBVA'});
  assert.deepEqual(reconcileQuestionnaireTimes({},[incoming('¿Puede ser BBVA?'),q]),{});
});
test('los filtros binarios usan la pregunta real y no equiparan mora con reporte negativo',()=>{
  const reports=out('¿Actualmente tienes reportes negativos en centrales de riesgo?');
  assert.deepEqual(reconcileQuestionnaireTimes({rch_reportes_negativos:'no'},[incoming('Sí'),reports]),{rch_reportes_negativos:'si'});
  assert.deepEqual(reconcileQuestionnaireTimes({rch_reportes_negativos:'no'},[incoming('Estoy en mora'),reports]),{rch_reportes_negativos:'desconocido'});
  assert.deepEqual(reconcileQuestionnaireTimes({rch_puede_aumentar_cuota:'si'},[incoming('No'),out('¿Tendrías la posibilidad de aumentar un poco el valor de tu cuota mensual?')]),{rch_puede_aumentar_cuota:'no'});
});
