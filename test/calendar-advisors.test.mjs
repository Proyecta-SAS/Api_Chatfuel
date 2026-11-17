import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateAdvisorDateSlots, nextAdvisorOptions } from "../src/calendar/appointmentAdvisorAvailability.js";

const base = {
  date: "2026-11-03", durationMinutes: 10, fromTime: "09:00", toTime: "10:00",
  now: new Date("2026-10-30T12:00:00-05:00")
};
const busy = (from, to) => [{
  DATE_FROM: `03/11/2026 ${from}:00`, DATE_TO: `03/11/2026 ${to}:00`, ACCESSIBILITY: "busy"
}];

test("un compañero ocupado no impide usar el horario libre del otro", () => {
  const slots = calculateAdvisorDateSlots({ ...base, calendars: [
    { advisorId: "first", bitrixUserId: "10", events: busy("09:00", "09:30") },
    { advisorId: "second", bitrixUserId: "20", events: busy("09:30", "10:00") }
  ] });
  assert.equal(slots.length, 6);
  assert.equal(slots[0].advisorId, "second");
  assert.equal(slots[3].advisorId, "first");
});

test("si ambos están ocupados no se ofrece ese intervalo", () => {
  const slots = calculateAdvisorDateSlots({ ...base, calendars: [
    { advisorId: "first", bitrixUserId: "10", events: busy("09:00", "09:30") },
    { advisorId: "second", bitrixUserId: "20", events: busy("09:20", "10:00") }
  ] });
  assert.ok(!slots.some((slot) => slot.start === "09:20"));
});

test("no se inventan horas libres si no se pudo leer un calendario", () => {
  assert.deepEqual(calculateAdvisorDateSlots({ ...base, calendars: [
    { advisorId: "first", bitrixUserId: "10", events: null },
    { advisorId: "second", bitrixUserId: "20", events: busy("09:00", "10:00") }
  ] }), []);
});

test("un evento ocupado ilegible bloquea las ofertas de ese compañero", () => {
  assert.deepEqual(calculateAdvisorDateSlots({ ...base, calendars: [
    { advisorId: "first", bitrixUserId: "10", events: [{ DATE_FROM: "invalid", DATE_TO: "invalid" }] }
  ] }), []);
});

test("un horario compartido se ofrece una sola vez y conserva el asesor", () => {
  const slots = calculateAdvisorDateSlots({ ...base, calendars: [
    { advisorId: "first", bitrixUserId: "10", events: [] },
    { advisorId: "second", bitrixUserId: "20", events: [] }
  ] });
  assert.equal(slots.length, 6);
  assert.ok(slots.every((slot) => slot.advisorId === "first" && slot.bitrixUserId === "10"));
});

test("respeta también las reservas locales aún no reflejadas en el calendario", () => {
  const slots = calculateAdvisorDateSlots({ ...base, calendars: [{
    advisorId: "first", bitrixUserId: "10", events: [], reservations: [{
      startAt: "2026-11-03T09:00:00-05:00", endAt: "2026-11-03T09:30:00-05:00"
    }]
  }] });
  assert.equal(slots[0].start, "09:30");
});

test("convierte reservas UTC a Bogotá antes de excluir los horarios", () => {
  const slots = calculateAdvisorDateSlots({ ...base, calendars: [{
    advisorId: "first", bitrixUserId: "10", events: [], reservations: [{
      startAt: "2026-11-03T14:00:00Z", endAt: "2026-11-03T14:30:00Z"
    }]
  }] });
  assert.equal(slots[0].start, "09:30");
});

test("un evento que termina a medianoche no bloquea el día siguiente", () => {
  const slots = calculateAdvisorDateSlots({ ...base, calendars: [{
    advisorId: "first", bitrixUserId: "10", events: [{
      DATE_FROM: "02/11/2026 00:00:00", DATE_TO: "03/11/2026 00:00:00", DT_SKIP_TIME: "Y"
    }]
  }] });
  assert.equal(slots.length, 6);
});

test("las siguientes tres opciones conservan el período y no repiten horas", () => {
  const slots = calculateAdvisorDateSlots({ ...base, calendars: [
    { advisorId: "first", bitrixUserId: "10", events: [] }
  ] });
  const first = nextAdvisorOptions({ slots, ...base, excludedStarts: [] });
  const next = nextAdvisorOptions({ slots, ...base, excludedStarts: first.map((slot) => slot.startAt) });
  assert.equal(first.length, 3);
  assert.equal(next.length, 3);
  assert.ok(next.every((slot) => slot.date === base.date && slot.start >= base.fromTime && slot.end <= base.toTime));
  assert.ok(!next.some((slot) => first.some((previous) => previous.startAt === slot.startAt)));
});

test("cuando ambos estan libres gana el de menos citas confirmadas ese dia", () => {
  const slots = calculateAdvisorDateSlots({ ...base, durationMinutes: 15, calendars: [
    { advisorId: "first", bitrixUserId: "10", events: [], confirmedByDate: { [base.date]: 3 } },
    { advisorId: "second", bitrixUserId: "20", events: [], confirmedByDate: { [base.date]: 1 } }
  ] });
  assert.equal(slots.length, 4);
  assert.ok(slots.every((slot) => slot.advisorId === "second"));
});

test("la disponibilidad prevalece sobre el equilibrio de carga", () => {
  const slots = calculateAdvisorDateSlots({ ...base, durationMinutes: 15, calendars: [
    { advisorId: "first", bitrixUserId: "10", events: [], confirmedByDate: { [base.date]: 4 } },
    { advisorId: "second", bitrixUserId: "20", events: busy("09:00", "10:00"), confirmedByDate: {} }
  ] });
  assert.equal(slots.length, 4);
  assert.ok(slots.every((slot) => slot.advisorId === "first"));
});

test("con carga igual gana quien lleva mas tiempo sin una asignacion", () => {
  const slots = calculateAdvisorDateSlots({ ...base, calendars: [
    { advisorId: "first", bitrixUserId: "10", events: [], lastAssignedAt: "2026-10-30T14:00:00Z" },
    { advisorId: "second", bitrixUserId: "20", events: [], lastAssignedAt: "2026-10-30T13:00:00Z" }
  ] });
  assert.ok(slots.every((slot) => slot.advisorId === "second"));
});

test("los quince minutos completos deben caber en el calendario", () => {
  const slots = calculateAdvisorDateSlots({ ...base, durationMinutes: 15, calendars: [
    { advisorId: "first", bitrixUserId: "10", events: busy("09:10", "10:00") }
  ] });
  assert.deepEqual(slots, []);
});

test("el reparto funciona con cuatro asesores sin posiciones fijas", () => {
  const calendars = ["a", "b", "c", "d"].map((advisorId, index) => ({
    advisorId, bitrixUserId: String(index + 10), events: [],
    confirmedByDate: { [base.date]: 0 }, lastAssignedAt: null
  }));
  const assignments = [];
  for (let index = 0; index < 12; index++) {
    const [slot] = calculateAdvisorDateSlots({ ...base, calendars });
    assignments.push(slot.advisorId);
    calendars.find((item) => item.advisorId === slot.advisorId).confirmedByDate[base.date]++;
  }
  assert.deepEqual(Object.fromEntries(calendars.map((item) =>
    [item.advisorId, item.confirmedByDate[base.date]])), { a: 3, b: 3, c: 3, d: 3 });
  assert.deepEqual(assignments.slice(0, 4), ["a", "b", "c", "d"]);
});

test("con tres asesores solo compiten por carga los que tienen el intervalo libre", () => {
  const slots = calculateAdvisorDateSlots({ ...base, calendars: [
    { advisorId: "a", bitrixUserId: "10", events: busy("09:00", "10:00"), confirmedByDate: {} },
    { advisorId: "b", bitrixUserId: "20", events: [], confirmedByDate: { [base.date]: 5 } },
    { advisorId: "c", bitrixUserId: "30", events: [], confirmedByDate: { [base.date]: 2 } }
  ] });
  assert.ok(slots.length > 0 && slots.every((slot) => slot.advisorId === "c"));
});
