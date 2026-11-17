import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateDateSlots,
  candidateDates,
  parseBitrixDate
} from "../src/calendar/appointmentAvailability.js";
import { requireBitrixEventId } from "../src/calendar/appointmentBooking.js";

test("interpreta las fechas reales de calendar.accessibility.get", () => {
  assert.deepEqual(parseBitrixDate("28/10/2026 13:30:00"), {
    date: "2026-10-28",
    minutes: 13 * 60 + 30
  });
});

test("excluye los eventos ocupados y conserva el horario hasta las 17:00", () => {
  const slots = calculateDateSlots({
    date: "2026-10-29",
    durationMinutes: 30,
    fromTime: "08:30",
    toTime: "17:00",
    now: new Date("2026-10-28T12:00:00-05:00"),
    events: [
      { DATE_FROM: "29/10/2026 08:30:00", DATE_TO: "29/10/2026 09:30:00", ACCESSIBILITY: "busy" },
      { DATE_FROM: "29/10/2026 13:00:00", DATE_TO: "29/10/2026 14:00:00", ACCESSIBILITY: "busy" },
      { DATE_FROM: "29/10/2026 15:00:00", DATE_TO: "29/10/2026 16:00:00", ACCESSIBILITY: "busy" }
    ]
  });

  assert.equal(slots[0].start, "09:30");
  assert.ok(slots.some((slot) => slot.start === "16:30" && slot.end === "17:00"));
  assert.ok(!slots.some((slot) => slot.start === "08:30" || slot.start === "13:30" || slot.start === "15:30"));
});

test("no ofrece horas pasadas hoy ni bloquea eventos marcados como libres", () => {
  const slots = calculateDateSlots({
    date: "2026-10-28",
    durationMinutes: 10,
    fromTime: "08:30",
    toTime: "17:00",
    now: new Date("2026-10-28T11:19:00-05:00"),
    events: [{ DATE_FROM: "28/10/2026 11:20:00", DATE_TO: "28/10/2026 12:00:00", ACCESSIBILITY: "free" }]
  });

  assert.equal(slots[0].start, "11:20");
});

test("incluye solo dias laborales dentro del horizonte", () => {
  assert.deepEqual(candidateDates({
    from: "2026-10-30",
    daysAhead: 4,
    weekdays: ["lunes", "martes", "miercoles", "jueves", "viernes"]
  }), ["2026-10-30", "2026-11-03"]);
});

test("solo confirma la reserva cuando Bitrix devuelve un id real", () => {
  assert.equal(requireBitrixEventId(4831), "4831");
  assert.equal(requireBitrixEventId("9012"), "9012");
  assert.throws(() => requireBitrixEventId(""), /no confirmó/i);
  assert.throws(() => requireBitrixEventId(false), /no confirmó/i);
  assert.throws(() => requireBitrixEventId(null), /no confirmó/i);
});
