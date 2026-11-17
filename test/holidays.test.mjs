import test from 'node:test';
import assert from 'node:assert/strict';
import {colombianHolidays,isHoliday,bitrixHolidays} from '../src/calendar/holidays.js';
import {candidateDates,calculateDateSlots} from '../src/calendar/appointmentAvailability.js';

test('Colombian holidays in 2026 include moved Mondays, Easter and the new July holiday',()=>{
 assert.deepEqual([...colombianHolidays(2026)].sort(),[
  '2026-01-01','2026-01-12','2026-03-23','2026-04-02','2026-04-03','2026-05-01',
  '2026-05-18','2026-06-08','2026-06-15','2026-06-29','2026-07-13','2026-07-20',
  '2026-08-07','2026-08-17','2026-10-12','2026-11-02','2026-11-16','2026-12-08','2026-12-25',
 ]);
 assert.equal(isHoliday('2027-11-15'),true);assert.equal(isHoliday('2027-03-25'),true);
 assert.equal(isHoliday('2026-11-17'),false);
});
test('an empty Bitrix holiday list cannot make a Colombian holiday available',()=>{
 assert.deepEqual(bitrixHolidays({year_holidays:''}),[]);
 assert.deepEqual(calculateDateSlots({date:'2026-11-16',events:[],durationMinutes:30,
  fromTime:'08:30',toTime:'17:00',now:new Date('2026-11-13T12:00:00Z')}),[]);
 assert.deepEqual(candidateDates({from:'2026-11-13',daysAhead:5,
  weekdays:['lunes','martes','miercoles','jueves','viernes']}),['2026-11-13','2026-11-17','2026-11-18']);
});
test('additional company closures are honored; invalid settings fail closed',()=>{
 const closed=bitrixHolidays({year_holidays:'17.11, 31.12'});
 assert.equal(isHoliday('2026-11-17',closed),true);
 for(const settings of [null,{}, {year_holidays:'31.02'},{year_holidays:'LUNES'}])assert.throws(()=>bitrixHolidays(settings));
});
