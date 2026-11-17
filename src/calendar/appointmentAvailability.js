// Adaptado del código del proyecto de referencia del usuario; módulo autónomo.
import {isHoliday} from './holidays.js';
const COLOMBIA_TIME_ZONE = "America/Bogota";
export const SPANISH_WEEKDAYS = [
    "domingo",
    "lunes",
    "martes",
    "miercoles",
    "jueves",
    "viernes",
    "sabado"
];
function zonedParts(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: COLOMBIA_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part)=>[
            part.type,
            part.value
        ]));
    return {
        date: `${values.year}-${values.month}-${values.day}`,
        hour: Number(values.hour),
        minute: Number(values.minute)
    };
}
export function bogotaToday(now = new Date()) {
    return zonedParts(now).date;
}
export function addCalendarDays(dateKey, days) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}
export function weekdayForDate(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return SPANISH_WEEKDAYS[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
}
export function normalizeWeekday(value) {
    return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
export function parseTime(value) {
    const match = value.match(/^(\d{2}):(\d{2})$/);
    if (!match) return null;
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    return minutes >= 0 && minutes < 1440 ? minutes : null;
}
function timeFromMinutes(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
export function parseBitrixDate(value) {
    const raw = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}[T\s].*(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) return null;
        const parts = zonedParts(date);
        return {
            date: parts.date,
            minutes: parts.hour * 60 + parts.minute
        };
    }
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
    if (iso) return {
        date: `${iso[1]}-${iso[2]}-${iso[3]}`,
        minutes: Number(iso[4]) * 60 + Number(iso[5])
    };
    const dayFirst = raw.match(/^(\d{2})[/.](\d{2})[/.](\d{4})\s+(\d{2}):(\d{2})/);
    if (dayFirst) return {
        date: `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`,
        minutes: Number(dayFirst[4]) * 60 + Number(dayFirst[5])
    };
    return null;
}
function slotLabel(dateKey, start) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const [hour, minute] = start.split(":").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
    const dayLabel = new Intl.DateTimeFormat("es-CO", {
        timeZone: COLOMBIA_TIME_ZONE,
        weekday: "long",
        day: "numeric",
        month: "long"
    }).format(date);
    const timeLabel = new Intl.DateTimeFormat("es-CO", {
        timeZone: COLOMBIA_TIME_ZONE,
        hour: "numeric",
        minute: "2-digit"
    }).format(date);
    return `${dayLabel} a las ${timeLabel}`;
}
function toSlot(date, start, end) {
    return {
        date,
        start,
        end,
        startAt: `${date}T${start}:00-05:00`,
        endAt: `${date}T${end}:00-05:00`,
        label: slotLabel(date, start)
    };
}
export function calculateDateSlots(input) {
    if (isHoliday(input.date,input.additionalHolidays || [])) return [];
    const now = input.now || new Date();
    const start = parseTime(input.fromTime);
    const end = parseTime(input.toTime);
    if (start === null || end === null || start >= end || !Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0) return [];
    const nowParts = zonedParts(now);
    const currentMinute = nowParts.hour * 60 + nowParts.minute;
    const busy = input.events.flatMap((event)=>{
        if (String(event.ACCESSIBILITY ?? event.accessibility ?? "busy").toLowerCase() === "free") return [];
        const eventStart = parseBitrixDate(event.DATE_FROM ?? event.dateFrom);
        const eventEnd = parseBitrixDate(event.DATE_TO ?? event.dateTo);
        if (!eventStart || !eventEnd || eventEnd.date < input.date || eventStart.date > input.date || eventEnd.date === input.date && eventEnd.minutes === 0) return [];
        if (String(event.DT_SKIP_TIME || "").toUpperCase() === "Y") return [
            {
                start: 0,
                end: 1440
            }
        ];
        return [
            {
                start: eventStart.date < input.date ? 0 : eventStart.minutes,
                end: eventEnd.date > input.date ? 1440 : eventEnd.minutes
            }
        ];
    });
    const slots = [];
    for(let slotStart = start; slotStart + input.durationMinutes <= end; slotStart += input.durationMinutes){
        const slotEnd = slotStart + input.durationMinutes;
        if (input.date < nowParts.date || input.date === nowParts.date && slotStart < currentMinute) continue;
        if (busy.some((event)=>slotStart < event.end && slotEnd > event.start)) continue;
        slots.push(toSlot(input.date, timeFromMinutes(slotStart), timeFromMinutes(slotEnd)));
    }
    return slots;
}
export function candidateDates(input) {
    const allowed = new Set(input.weekdays.map(normalizeWeekday));
    const dates = [];
    for(let offset = 0; offset <= input.daysAhead; offset += 1){
        const date = addCalendarDays(input.from, offset);
        if (allowed.has(weekdayForDate(date)) && !isHoliday(date,input.additionalHolidays || [])) dates.push(date);
    }
    return dates;
}
export function groupSlotsByDate(slots) {
    const grouped = new Map();
    slots.forEach((slot)=>grouped.set(slot.date, [
            ...grouped.get(slot.date) || [],
            slot
        ]));
    return Array.from(grouped, ([date, dateSlots])=>({
            date,
            slots: dateSlots
        }));
}
