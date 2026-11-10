export const DEAL_SUMMARY_FIELD = 'UF_CRM_1646852109830';
export const PROFILE_FEEDBACK_VERSION = 'feedback-v3';

export const FEEDBACK_HEADINGS = [
  'RESUMEN Y FEEDBACK DE CHATFUEL', 'DATOS RECOPILADOS', 'INTERESES Y CONSULTAS',
  'CONTEXTO DE ATENCIÓN', 'ANÁLISIS PARA EL ASESOR', 'PRÓXIMOS PASOS', 'DATOS POR CONFIRMAR',
];

// This portal silently truncates CRM text at supplementary Unicode characters
// (for example WhatsApp display-name emoji). Preserve the original in MySQL;
// use a compatible representation for the field, timeline and their fingerprint.
export function bitrixSummaryText(summary) {
  return String(summary).replace(/[\u{10000}-\u{10FFFF}\u200d\ufe0e\ufe0f]/gu, '');
}

// Only our headings carry BBCode. Client text cannot inject links, mentions or tags.
export function timelineSummary(summary) {
  return String(summary).split(/\r?\n/).map(line => {
    const safe = line.replaceAll('[', '［').replaceAll(']', '］').replaceAll('<', '＜').replaceAll('>', '＞');
    return FEEDBACK_HEADINGS.includes(line) || line === 'RESUMEN Y FEEDBACK DE DALIA' ? `[b]${safe}[/b]` : safe;
  }).join('\n');
}
