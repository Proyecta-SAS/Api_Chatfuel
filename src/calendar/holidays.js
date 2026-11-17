// Colombia: Ley 51/1983 and Ley 2578/2026 (Art. 6). Dates use civil Bogota days.
const key = value => value.toISOString().slice(0,10);
const day = (year,month,date) => new Date(Date.UTC(year,month-1,date,12));
const add = (value,count) => new Date(value.getTime()+count*86400000);
const monday = value => add(value,(8-value.getUTCDay())%7);
const cache = new Map();
export function colombianHolidays(year) {
  if(cache.has(year))return new Set(cache.get(year));
  // Gregorian Easter (Meeus/Jones/Butcher).
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4;
  const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30;
  const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
  const value=h+l-7*m+114,easter=day(year,Math.floor(value/31),value%31+1);
  const holidays=new Set([
    ...[[1,1],[5,1],[7,20],[8,7],[12,8],[12,25]].map(([mo,da])=>key(day(year,mo,da))),
    ...[[1,6],[3,19],[6,29],[8,15],[10,12],[11,1],[11,11]].map(([mo,da])=>key(monday(day(year,mo,da)))),
    ...[-3,-2,43,64,71].map(offset=>key(add(easter,offset))),
  ]);
  if(year>=2026)holidays.add(key(monday(day(year,7,9))));
  if(cache.size>=10)cache.clear();
  cache.set(year,holidays);
  return new Set(holidays);
}
export function isHoliday(date, additional=[]) {
  return colombianHolidays(Number(date.slice(0,4))).has(date)
    || additional.includes(date) || additional.includes(`${date.slice(8,10)}.${date.slice(5,7)}`);
}
export function bitrixHolidays(settings) {
  if(!settings || typeof settings!=='object' || typeof settings.year_holidays!=='string')throw new Error('INVALID_CALENDAR_HOLIDAYS');
  return settings.year_holidays.split(',').map(s=>s.trim()).filter(Boolean).map(value=>{
    const match=/^(\d{1,2})\.(\d{1,2})$/.exec(value);
    if(!match)throw new Error('INVALID_CALENDAR_HOLIDAYS');
    const date=day(2000,Number(match[2]),Number(match[1]));
    if(date.getUTCDate()!==Number(match[1])||date.getUTCMonth()+1!==Number(match[2]))throw new Error('INVALID_CALENDAR_HOLIDAYS');
    return `${match[1].padStart(2,'0')}.${match[2].padStart(2,'0')}`;
  });
}
