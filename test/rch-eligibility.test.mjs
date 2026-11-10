import test from 'node:test';
import assert from 'node:assert/strict';
import {durationMonths,evaluateRchEligibility} from '../src/calendar/rchEligibility.js';
const profile={rch_banco:'Bancolombia',rch_reportes_negativos:'no',rch_puede_aumentar_cuota:'si',
  rch_plazo_inicial:'20 años',rch_tiempo_pagando:'10 años',obligacion_vivienda_activa:'si'};
test('la guía clasifica sin asignar puntaje y calcula meses restantes',()=>{
  const result=evaluateRchEligibility(profile);assert.equal(result.status,'APLICA');assert.equal(result.remainingMonths,120);
  assert.equal(result.score,undefined);
});
test('la guía mide tiempo restante y no impone antigüedad mínima ni confunde mora con reportes',()=>{
  assert.equal(evaluateRchEligibility({...profile,rch_tiempo_pagando:'1 año'}).status,'APLICA');
  assert.equal(evaluateRchEligibility({...profile,rch_tiempo_pagando:'19 años'}).status,'NO_APLICA');
  assert.equal(evaluateRchEligibility({...profile,estado_pago:'en mora',rch_reportes_negativos:'desconocido'}).status,'PENDIENTE');
});
for(const bank of ['BBVA Colombia','Itaú','Credifamilia','Caja de compensación','Cooperativa']){
  test(`descarta la entidad excluida: ${bank}`,()=>assert.equal(evaluateRchEligibility({...profile,rch_banco:bank}).reason,'BANK_EXCLUDED'));
}
for(const [patch,reason] of [[{rch_reportes_negativos:'si'},'NEGATIVE_REPORTS'],[{rch_puede_aumentar_cuota:'no'},'NO_PAYMENT_CAPACITY'],
  [{tipo_obligacion:'crédito de libre inversión'},'PRODUCT_NOT_ELIGIBLE'],[{rch_plazo_inicial:'20 años',rch_tiempo_pagando:'15 años'},'SHORT_REMAINING_TERM']]){
  test(`no aplica: ${reason}`,()=>assert.equal(evaluateRchEligibility({...profile,...patch}).reason,reason));
}
test('el límite de cinco años usa meses exactos',()=>{
  assert.equal(evaluateRchEligibility({...profile,rch_tiempo_pagando:'14 años y 11 meses'}).remainingMonths,61);
  assert.equal(evaluateRchEligibility({...profile,rch_tiempo_pagando:'14 años y 11 meses'}).status,'APLICA');
  assert.equal(evaluateRchEligibility({...profile,rch_tiempo_pagando:'15 años'}).status,'NO_APLICA');
  assert.equal(evaluateRchEligibility({...profile,rch_tiempo_pagando:'181 meses'}).status,'NO_APLICA');
});
test('datos desconocidos, rangos y tiempos inconsistentes quedan pendientes',()=>{
  for(const patch of [{rch_reportes_negativos:'no sé'},{rch_puede_aumentar_cuota:'tal vez'},
    {rch_tiempo_pagando:'entre 4 y 6 años'},{rch_tiempo_pagando:'10'},{rch_tiempo_pagando:'21 años'},
    {rch_banco:'no es BBVA, es otro'}])assert.equal(evaluateRchEligibility({...profile,...patch}).status,'PENDIENTE');
});
test('no reutiliza la capacidad mayor al diez por ciento del formulario anterior',()=>{
  assert.equal(evaluateRchEligibility({...profile,rch_puede_aumentar_cuota:'',puede_aumentar_cuota_mas_10:'si'}).status,'PENDIENTE');
});
test('interpreta unidades, meses y medios años sin convertir rangos ni aproximaciones',()=>{
  assert.equal(durationMonths('1 año y 6 meses'),18);assert.equal(durationMonths('un año y medio'),18);
  assert.equal(durationMonths('20',{bareYears:true}),240);assert.equal(durationMonths('20'),null);
  assert.equal(durationMonths('aproximadamente 5 años'),null);assert.equal(durationMonths('3 a 5 años'),null);
});

test('los productos explícitos fuera de vivienda no habilitan agenda; una mezcla requiere aclarar',()=>{
  for(const tipo_obligacion of ['libranza','crédito de libranza','consumo','tarjeta de crédito','no hipotecario']){
    assert.equal(evaluateRchEligibility({...profile,tipo_obligacion}).reason,'PRODUCT_NOT_ELIGIBLE');
  }
  for(const tipo_obligacion of ['hipotecario','leasing habitacional','hipotecario y libranza']){
    assert.equal(evaluateRchEligibility({...profile,tipo_obligacion}).status,'APLICA');
  }
});
