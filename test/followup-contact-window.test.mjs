import test from 'node:test';
import assert from 'node:assert/strict';
import {nextContactTime,readContactWindow} from '../src/followups/contactWindow.js';
const w=readContactWindow();
for(const [at,want] of [
 ['2026-11-24T07:00:00-05:00','2026-11-24T08:30:00-05:00'],
 ['2026-11-24T08:30:00-05:00','2026-11-24T08:30:00-05:00'],
 ['2026-11-24T16:59:59-05:00','2026-11-24T16:59:59-05:00'],
 ['2026-11-24T17:00:00-05:00','2026-11-25T08:30:00-05:00'],
 ['2026-11-30T23:00:00-05:00','2026-12-01T08:30:00-05:00'],
 ['2026-12-31T23:59:59-05:00','2027-01-01T08:30:00-05:00'],
])test('franja Colombia: '+at,()=>assert.equal(nextContactTime(Date.parse(at),w),Date.parse(want)));
test('rechaza una franja inválida en vez de enviar a cualquier hora',()=>{
 for(const env of [{FOLLOWUPS_SEND_FROM:'25:00'},{FOLLOWUPS_SEND_UNTIL:'08:00'},{FOLLOWUPS_SEND_FROM:'8:30'}])
  assert.throws(()=>readContactWindow(env),/WINDOW_INVALID/);
});
