// Adaptado del código del proyecto de referencia del usuario; módulo autónomo.
import { calculateDateSlots, parseBitrixDate } from "./appointmentAvailability.js";
export function calculateAdvisorDateSlots(input) {
    const byTime = new Map();
    const calendars = [
        ...input.calendars
    ].sort((left, right)=>(left.confirmedByDate?.[input.date] ?? 0) - (right.confirmedByDate?.[input.date] ?? 0) || (left.lastAssignedAt ? Date.parse(left.lastAssignedAt) : 0) - (right.lastAssignedAt ? Date.parse(right.lastAssignedAt) : 0) || left.advisorId.localeCompare(right.advisorId));
    for (const calendar of calendars){
        if (!calendar.advisorId || !calendar.bitrixUserId || calendar.events === null) continue;
        const busy = [
            ...calendar.events,
            ...(calendar.reservations || []).map((item)=>({
                    DATE_FROM: item.startAt,
                    DATE_TO: item.endAt,
                    ACCESSIBILITY: "busy"
                }))
        ];
        const unreadable = busy.some((event)=>String(event.ACCESSIBILITY ?? event.accessibility ?? "busy").toLowerCase() !== "free" && (!parseBitrixDate(event.DATE_FROM ?? event.dateFrom) || !parseBitrixDate(event.DATE_TO ?? event.dateTo)));
        if (unreadable) continue;
        for (const slot of calculateDateSlots({
            ...input,
            additionalHolidays: calendar.additionalHolidays || input.additionalHolidays || [],
            events: busy
        })){
            if (!byTime.has(slot.startAt)) {
                byTime.set(slot.startAt, {
                    ...slot,
                    advisorId: calendar.advisorId,
                    bitrixUserId: calendar.bitrixUserId
                });
            }
        }
    }
    return [
        ...byTime.values()
    ].sort((left, right)=>left.startAt.localeCompare(right.startAt));
}
export function nextAdvisorOptions(input) {
    const excluded = new Set(input.excludedStarts);
    return input.slots.filter((slot)=>slot.date === input.date && slot.start >= input.fromTime && slot.end <= input.toTime && !excluded.has(slot.startAt)).slice(0, input.quantity ?? 3);
}
