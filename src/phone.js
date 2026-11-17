// Colombia mobile numbers may arrive locally or with the international prefix.
export function phoneVariants(value) {
  const text = String(value ?? '').trim();
  if (!/^[+\d() .-]+$/.test(text)) return [];
  let digits = text.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^3\d{9}$/.test(digits)) digits = `57${digits}`;
  if (digits.startsWith('57') && !/^57\d{10}$/.test(digits)) return [];
  if (!/^[1-9]\d{7,14}$/.test(digits)) return [];
  return [...new Set([digits, `00${digits}`, ...(/^573\d{9}$/.test(digits) ? [digits.slice(2)] : [])])];
}
