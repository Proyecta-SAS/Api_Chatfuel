import { durationMonths } from './rchEligibility.js';
const normalize=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

function questionField(text){
  if(!/[?¿]/.test(text))return null;
  // An acknowledgement can mention the original term before asking time paid.
  // Only the question itself identifies the field answered by the customer.
  const t=normalize(text.slice(text.lastIndexOf('¿')+1));
  if(/(?:con que|cual).*banco|(?:banco|entidad).*credito/.test(t))return 'rch_banco';
  if(/reportes? negativos?/.test(t))return 'rch_reportes_negativos';
  if(/aumentar.*cuota/.test(t))return 'rch_puede_aumentar_cuota';
  if(/(?:plazo\s+(?:original|inicial)|anos.*(?:tomaste|adquiriste|originalmente))/.test(t))return 'rch_plazo_inicial';
  if(/(?:cuanto tiempo|hace cuanto|cuantos anos).*pagando/.test(t))return 'rch_tiempo_pagando';
  return null;
}
function answer(text,field){
  if(/[?¿]/.test(text))return null;
  if(field==='rch_banco'){
    const bank=String(text).trim();
    if(!bank||bank.length>180||/\b(?:agend|reserv|asesor|empez|reinici)/.test(normalize(bank)))return null;
    if(/^(?:si+|no+|claro|gracias|ok|dale+|listo|genial)[.!]*$/.test(normalize(bank)))return null;
    return /^(?:no se|no recuerdo|no sabe)$/.test(normalize(bank))?'desconocido':bank;
  }
  if(['rch_reportes_negativos','rch_puede_aumentar_cuota'].includes(field)){
    const t=normalize(text).replace(/[.!¡,;:]/g,' ').replace(/\s+/g,' ').trim();
    if(/^(?:si+|si+ claro|claro|claro que si|si por supuesto|si tengo|si los tengo|si puedo|puedo)$/.test(t))return 'si';
    if(field==='rch_puede_aumentar_cuota' && /^(?:si+\s+)?(?:podria|podemos|puedo)(?:\s+(?:hacerlo|aumentar(?:la)?|un poco|claro|sin problema))?$/.test(t))return 'si';
    if(/^(?:no+|no+ limpio|no tengo|no los tengo|no puedo|no me es posible)$/.test(t))return 'no';
    if(field==='rch_reportes_negativos'&&/^(?:tengo reportes negativos|si tengo reportes negativos|estoy reportado|estoy reportada)$/.test(t))return 'si';
    if(field==='rch_reportes_negativos'&&/^(?:no tengo reportes negativos|estoy limpio|estoy limpia)$/.test(t))return 'no';
    return /^(?:no se|no recuerdo|no estoy segur[oa]|desconocido|estoy en mora|estoy en datacredito)$/.test(t)?'desconocido':null;
  }
  let t=normalize(text).replace(/[.!]+$/,'').trim();
  for(let i=0;i<3;i++)t=t.replace(/^(?:ya\s+)?te\s+(?:dije|habia dicho)\s+que\s+/,'')
    .replace(/^(?:como te dije|para aclarar)\s*[,;:]?\s*/,'')
    .replace(/^(?:a|de|son|fue|es|llevo pagando|llevo|el plazo original es de|el plazo es de|lo tome a)\s+/,'');
  t=t.replace(/\s+(?:ya\s+)?te lo (?:habia dicho|dije|he dicho)$/,'').replace(/[.!]+$/,'').trim();
  const months=durationMonths(t,{bareYears:field==='rch_plazo_inicial'});
  if(months!==null)return months%12===0?`${months/12} años`:`${months} meses`;
  if(/\b(?:aproximadamente|creo|no se|no recuerdo|entre|unos|tal vez)\b/.test(t))return t;
  return null;
}

function explicitProduct(text) {
  const t=normalize(text).replace(/[.!]+$/,'')
    .replace(/^(?:no senorita[.,]?\s*)?mi caso es que\s+/,'');
  if (/[?¿]/.test(t)) return null;
  // Do not reject somebody who has both a housing loan and another product,
  // mentions a past loan, or merely asks about a product.
  if (/\b(?:antes|anterior|tenia|tuve|tambien|ademas|otro|otra)\b/.test(t)) return null;
  if (/^(?:no\s+)?(?:disculpa\s+)?no es (?:un credito )?hipotecario$/.test(t)) return 'no hipotecario';
  if (/hipotec|vivienda|leasing/.test(t)) return null;
  const product=t.match(/^(?:es\s+(?:un\s+credito\s+)?de\s+|(?:yo\s+)?tengo\s+(?:un\s+credito\s+de\s+|una?\s+)|mi credito es\s+(?:de\s+)?)(libranza|libre inversion|consumo|tarjeta de credito)\b/);
  return product?.[1] || (/^(?:libranza|libre inversion|consumo|tarjeta de credito)$/.test(t)?t:null);
}

// Only explicit customer answers to the actual preceding question can replace
// captured values. The latest correction wins; bot examples are never facts.
export function reconcileQuestionnaireTimes(fields,messages=[]){
  const updates={};let question=null;
  for(const message of [...messages].reverse()){
    if(message.__typename==='WhatsAppOutTextMessage'){
      question=questionField(message.text||'');continue;
    }
    if(message.__typename!=='WhatsAppInTextMessage')continue;
    const text=message.text||'',normalized=normalize(text);
    if(/\b(?:quiero empezar de cero|empecemos de cero|reiniciar el perfilamiento)\b/.test(normalized)
      && !/\bno quiero\b/.test(normalized)){
      for(const field of Object.keys(updates))delete updates[field];question=null;continue;
    }
    const product=explicitProduct(text);
    if(product){updates.tipo_obligacion=product;updates.obligacion_vivienda_activa='no';}
    else if(question){const value=answer(text,question);if(value!==null){updates[question]=value;if(question==='rch_banco')updates.banco_entidad=value;}}
    // Campaign greetings can be template nodes without readable question text.
    // Only an unambiguous standalone entity is recovered in that situation.
    if(!question && /^(?:con (?:el )?(?:banco )?)?(?:bbva(?: colombia)?|bancolombia|davivienda|banco de bogota|banco bogota|banco de occidente|banco caja social|banco popular|banco agrario|av villas|fna|fondo nacional del ahorro|itau|credifamilia)[.!]*$/.test(normalized)){
      updates.rch_banco=text.trim();updates.banco_entidad=text.trim();
    }
    // A customer can correct a typo in a second consecutive message before the
    // assistant replies (for example "Ni", then "No"). Keep that question.
  }
  return Object.fromEntries(Object.entries(updates).filter(([field,value])=>String(fields[field]??'')!==value));
}
