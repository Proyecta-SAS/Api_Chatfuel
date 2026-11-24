const clock = value => /^\d{2}:\d{2}$/.test(value) && Number(value.slice(0,2))<24 && Number(value.slice(3))<60;
export function readContactWindow(env={}) {
  const start=env.FOLLOWUPS_SEND_FROM || '08:30',end=env.FOLLOWUPS_SEND_UNTIL || '17:00';
  if(!clock(start)||!clock(end)||start>=end)throw new Error('FOLLOWUP_CONTACT_WINDOW_INVALID');
  return {start,end,timeZone:'America/Bogota'};
}
// Colombia has a fixed UTC-5 offset. Keep the dates in UTC while calculating
// the next local opening, so the host machine timezone cannot change it.
export function nextContactTime(now,window) {
  if(!window)return now;
  const shifted=new Date(now-5*3600000),day=shifted.toISOString().slice(0,10),time=shifted.toISOString().slice(11,16);
  if(time>=window.start && time<window.end)return now;
  let opening=Date.parse(day+'T'+window.start+':00-05:00');
  if(time>=window.end)opening+=86400000;
  return opening;
}
