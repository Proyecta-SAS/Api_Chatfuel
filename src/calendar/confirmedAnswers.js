import { durationMonths } from './rchEligibility.js';
const normalize=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

function questionField(text){
  const t=normalize(text);
  if(!/[?¿]/.test(text))return null;
  if(/(?:plazo\s+(?:original|inicial)|anos.*(?:tomaste|adquiriste|originalmente))/.test(t))return 'rch_plazo_inicial';
  if(/(?:cuanto tiempo|hace cuanto|cuantos anos).*pagando/.test(t))return 'rch_tiempo_pagando';
  return null;
}
function answer(text,field){
  if(/[?¿]/.test(text))return null;
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
    if(question){const value=answer(text,question);if(value!==null)updates[question]=value;}
    question=null;
  }
  return Object.fromEntries(Object.entries(updates).filter(([field,value])=>String(fields[field]??'')!==value));
}
