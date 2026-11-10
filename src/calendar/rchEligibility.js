export const RCH_POLICY_VERSION = 'rch-2026-11-06';
export const RCH_QUESTION_FIELDS = ['rch_reportes_negativos', 'rch_puede_aumentar_cuota', 'rch_plazo_inicial', 'rch_tiempo_pagando'];
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const known = value => {
  const text = normalize(value);
  return text && !/^(?:pendiente|desconocido|unknown|no se|no sabe|no recuerdo|sin informacion|otro|otros|null|undefined|n\/a)$/.test(text) ? text : null;
};
const binary = value => /^(?:si|true|1)$/.test(normalize(value)) ? true : /^(?:no|false|0)$/.test(normalize(value)) ? false : null;

export function durationMonths(value, { bareYears = false } = {}) {
  let text = known(value);
  if (!text) return null;
  text = text.replace(/^(?:hace|llevo|desde hace)\s+/, '').replace(/\bun\s+ano\b/g,'1 ano');
  const composite = text.match(/^(\d+)\s*anos?\s*(?:y\s*)?(\d+)\s*mes(?:es)?$/);
  const half = text.match(/^(\d+)\s*anos?\s+y\s+medio$/);
  const simple = text.match(/^(\d+(?:[.,]\d+)?)\s*(anos?|mes(?:es)?)$/);
  let months = composite ? Number(composite[1])*12 + Number(composite[2])
    : half ? Number(half[1])*12+6
    : simple ? Number(simple[1].replace(',','.'))*(simple[2].startsWith('ano')?12:1)
    : bareYears && /^\d+(?:[.,]\d+)?$/.test(text) ? Number(text.replace(',','.'))*12 : null;
  if (months === null || !Number.isInteger(months) || months < 0 || months > 1200) return null;
  if (composite && Number(composite[2]) >= 12) return null;
  return months;
}

export function evaluateRchEligibility(fields = {}, { requireActive = false } = {}) {
  const bank = known(fields.rch_banco) || known(fields.banco_entidad);
  const product = normalize(fields.tipo_obligacion);
  const reports = binary(fields.rch_reportes_negativos);
  const capacity = binary(fields.rch_puede_aumentar_cuota);
  const originalMonths = durationMonths(fields.rch_plazo_inicial,{bareYears:true});
  const paidMonths = durationMonths(fields.rch_tiempo_pagando);
  const remainingMonths = originalMonths !== null && paidMonths !== null && paidMonths <= originalMonths ? originalMonths-paidMonths : null;
  const result = (status,reason,missing=[]) => ({status,reason,missing,originalMonths,paidMonths,remainingMonths,policyVersion:RCH_POLICY_VERSION});
  // A second non-housing product does not disqualify a declared housing loan.
  const nonHousing = /^(?:(?:credito|prestamo)\s+(?:de\s+)?)?(?:libre\s+inversion|libranza|consumo|tarjeta(?:\s+de\s+credito)?|no\s+hipotecario)[.!]*$/;
  if (nonHousing.test(product) || binary(fields.obligacion_vivienda_activa) === false) return result('NO_APLICA','PRODUCT_NOT_ELIGIBLE');
  // Negated or historical bank names are ambiguous, not grounds for rejection.
  const ambiguousBank = bank && /\b(?:no|antes|anterior|pero)\b/.test(bank);
  if (bank && !ambiguousBank && /\bbbva\b|\bitau\b|\bcredi\s?familia\b|\bcajas?\s+de\s+compensacion\b|\bcooperativas?\b/.test(bank)) return result('NO_APLICA','BANK_EXCLUDED');
  if (reports === true) return result('NO_APLICA','NEGATIVE_REPORTS');
  if (capacity === false) return result('NO_APLICA','NO_PAYMENT_CAPACITY');
  if (originalMonths !== null && (originalMonths === 0 || paidMonths !== null && paidMonths > originalMonths)) return result('PENDIENTE','INCONSISTENT_TERM',['rch_plazo_inicial','rch_tiempo_pagando']);
  if (remainingMonths !== null && remainingMonths <= 60) return result('NO_APLICA','SHORT_REMAINING_TERM');
  const missing=[];
  if (!bank || ambiguousBank) missing.push('rch_banco');
  if (reports === null) missing.push('rch_reportes_negativos');
  if (capacity === null) missing.push('rch_puede_aumentar_cuota');
  if (originalMonths === null) missing.push('rch_plazo_inicial');
  if (paidMonths === null) missing.push('rch_tiempo_pagando');
  if (requireActive && binary(fields.obligacion_vivienda_activa) === null) missing.push('obligacion_vivienda_activa');
  return missing.length ? result('PENDIENTE','INCOMPLETE_DATA',missing) : result('APLICA','ELIGIBLE');
}

export function eligibilityMessage(result) {
  const declines = {
    PRODUCT_NOT_ELIGIBLE:'Gracias por tu interés 😊. Esta revisión es únicamente para créditos hipotecarios o leasing habitacional activos. El producto que nos indicas no corresponde a este proceso de reducción de crédito hipotecario.',
    BANK_EXCLUDED:'¡Gracias por la información! En este momento, por las condiciones de nuestro proceso, no podemos realizar la gestión de Reducción de Crédito Hipotecario con esta entidad financiera. Agradecemos tu interés en Avanzar Soluciones Financieras 😊.',
    NEGATIVE_REPORTS:'Gracias por compartirnos esta información. En este momento, debido a los reportes negativos que nos indicas, no es posible avanzar con nuestro proceso de Reducción de Crédito Hipotecario. Agradecemos tu interés y esperamos poder ayudarte más adelante.',
    NO_PAYMENT_CAPACITY:'Gracias por tu respuesta 😊. Para nuestro proceso de Reducción de Crédito Hipotecario es necesario poder realizar un esfuerzo adicional en la cuota mensual. Como actualmente no tienes esa posibilidad, no podemos avanzar con esta solicitud por ahora.',
    SHORT_REMAINING_TERM:'Gracias por la información 😊. Con el plazo inicial y el tiempo que llevas pagando, identificamos que te quedan cinco años o menos. Por las condiciones de nuestro proceso, no podemos avanzar con la reducción de crédito hipotecario en este momento.',
  };
  if (result.status === 'NO_APLICA') return declines[result.reason];
  if (result.reason === 'INCONSISTENT_TERM') return 'Quiero verificar los tiempos para no darte una orientación equivocada 😊. ¿A cuántos años tomaste originalmente tu crédito?';
  return ({
    rch_banco:'Para continuar con la revisión 😊, ¿con qué banco tienes actualmente tu crédito hipotecario o leasing habitacional?',
    rch_reportes_negativos:'Para continuar con la revisión, ¿actualmente tienes reportes negativos en centrales de riesgo?',
    rch_puede_aumentar_cuota:'¿Tendrías la posibilidad de aumentar un poco el valor de tu cuota mensual?',
    rch_plazo_inicial:'¿A cuántos años tomaste originalmente tu crédito? Por ejemplo: 15, 20 o 30 años.',
    rch_tiempo_pagando:'¿Cuánto tiempo llevas pagando tu crédito? Puedes indicarlo en años o meses.',
    obligacion_vivienda_activa:'¿Confirmas que actualmente tienes un crédito hipotecario o leasing habitacional activo?',
  })[result.missing[0]] || 'Necesitamos aclarar los datos de tu crédito antes de consultar la agenda.';
}
