import { Router, Request, Response } from "express";
import { GHL } from "../ghl";
import { getInstallation } from "../db";
import {
  FreeSlotsRequest,
  BookAppointmentRequest,
  CancelAppointmentRequest,
  RescheduleAppointmentRequest,
} from "../types";

const router = Router();
const ghl = new GHL();

function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const wordToDigit: Record<string, string> = {
  zero: "0", oh: "0", o: "0",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
};

function normalizePhone(raw: string): string {
  // Replace spoken word numbers with digits, then strip non-digit chars
  const converted = raw
    .toLowerCase()
    .split(/[\s\-,.]+/)
    .map((token) => wordToDigit[token] ?? token)
    .join("");
  const digits = converted.replace(/\D/g, "");
  // Strip leading 1 for US numbers if 11 digits
  if (digits.length === 11 && digits.startsWith("1")) {
    return "+" + digits;
  }
  if (digits.length === 10) {
    return "+1" + digits;
  }
  return "+" + digits;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---------------------------------------------------------------------------
// Shared helper: determine which days-of-week a calendar is actually open.
// Fetches a reference week (next Mon–Sun) of free-slots from GHL and caches
// the result per calendar so every free-slots call doesn't double-fetch.
// ---------------------------------------------------------------------------

interface DayScheduleInfo {
  earliest: string; // first slot ISO string
  latest: string;   // last slot ISO string
  slotCount: number;
}

interface CalendarSchedule {
  openDays: Set<number>;               // day-of-week numbers (0=Sun … 6=Sat)
  dayInfo: Map<number, DayScheduleInfo>;
}

const scheduleCache: Map<string, { schedule: CalendarSchedule; fetchedAt: number }> = new Map();
const SCHEDULE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getCalendarSchedule(
  client: any,
  calendarId: string,
  timezone: string,
): Promise<CalendarSchedule> {
  const cached = scheduleCache.get(calendarId);
  if (cached && Date.now() - cached.fetchedAt < SCHEDULE_CACHE_TTL) {
    console.log(`[Calendar] Schedule cache HIT for ${calendarId}`);
    return cached.schedule;
  }

  console.log(`[Calendar] Schedule cache MISS for ${calendarId} — fetching reference week`);

  // Next Monday → Sunday
  const now = new Date();
  const dow = now.getDay(); // 0=Sun
  const daysUntilMon = dow === 0 ? 1 : dow === 1 ? 7 : 8 - dow;
  const refStart = new Date(now);
  refStart.setDate(now.getDate() + daysUntilMon);
  refStart.setHours(0, 0, 0, 0);
  const refEnd = new Date(refStart);
  refEnd.setDate(refStart.getDate() + 6);
  refEnd.setHours(23, 59, 59, 999);

  const resp = await client.get(
    `/calendars/${calendarId}/free-slots?startDate=${refStart.getTime()}&endDate=${refEnd.getTime()}&timezone=${encodeURIComponent(timezone)}`,
    { headers: { Version: "2021-07-28" } },
  );

  const rawData = resp.data || {};
  const dateKeys = Object.keys(rawData).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));

  const openDays = new Set<number>();
  const dayInfo = new Map<number, DayScheduleInfo>();

  for (const dateKey of dateKeys) {
    const entry = rawData[dateKey];
    const slots: string[] = Array.isArray(entry) ? entry : (entry?.slots || []);
    if (slots.length === 0) continue;

    const d = new Date(dateKey + "T00:00:00");
    const dayNum = d.getDay();
    openDays.add(dayNum);

    if (!dayInfo.has(dayNum)) {
      dayInfo.set(dayNum, { earliest: slots[0], latest: slots[slots.length - 1], slotCount: slots.length });
    }
  }

  const schedule: CalendarSchedule = { openDays, dayInfo };
  scheduleCache.set(calendarId, { schedule, fetchedAt: Date.now() });

  console.log(
    `[Calendar] Open days for ${calendarId}: ${Array.from(openDays).sort().map((d) => DAY_NAMES[d]).join(", ") || "(none)"}`,
  );

  return schedule;
}

/**
 * POST /api/calendar/free-slots
 * Check available time slots for a calendar.
 *
 * Body: { locationId, time_preference?, duration_minutes?, timezone? }
 *   - time_preference: "morning" (before 12pm), "afternoon" (12pm+), "any" (default)
 *   - duration_minutes: how many days ahead to search (default 7)
 *   - Also accepts legacy startDate/endDate for backwards compatibility
 */
router.post("/free-slots", async (req: Request, res: Response) => {
  try {
    const {
      locationId,
      location_id,
      time_preference,
      duration_minutes,
      startDate,
      endDate,
      timezone
    } = req.body;

    // Accept both camelCase and snake_case for locationId
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: locationId",
      });
    }

    // Calculate dates automatically if not provided
    // Use Hawaii time (Pacific/Honolulu) for all "now" calculations
    const HAWAII_TZ = "Pacific/Honolulu";
    const hawaiiNowStr = new Date().toLocaleString("en-US", { timeZone: HAWAII_TZ });
    const hawaiiNow = new Date(hawaiiNowStr);

    const daysAhead = duration_minutes ? Math.ceil(duration_minutes / (24 * 60)) : 7; // Default 7 days

    let calculatedStartDate: string;
    let calculatedEndDate: string;

    if (startDate && endDate) {
      // Use legacy params if provided
      calculatedStartDate = startDate;
      calculatedEndDate = endDate;
    } else {
      // Auto-calculate: today (Hawaii time) through X days ahead
      const yyyy = hawaiiNow.getFullYear();
      const mm = String(hawaiiNow.getMonth() + 1).padStart(2, "0");
      const dd = String(hawaiiNow.getDate()).padStart(2, "0");
      calculatedStartDate = `${yyyy}-${mm}-${dd}`;
      const endDateObj = new Date(hawaiiNow);
      endDateObj.setDate(endDateObj.getDate() + daysAhead);
      const ey = endDateObj.getFullYear();
      const em = String(endDateObj.getMonth() + 1).padStart(2, "0");
      const ed = String(endDateObj.getDate()).padStart(2, "0");
      calculatedEndDate = `${ey}-${em}-${ed}`;
    }

    // Normalize time_preference
    const timePreference = (time_preference || "any").toLowerCase();

    const installation = await getInstallation(resolvedLocationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    if (!installation.calendar_id) {
      return res.status(400).json({ success: false, error: "No calendar configured for this location" });
    }

    const tz = timezone || installation.timezone || "America/New_York";

    // 15-minute buffer so we don't offer slots that are about to pass (in Hawaii time)
    const BUFFER_MS = 15 * 60 * 1000;
    const nowPlusBuffer = hawaiiNow.getTime() + BUFFER_MS;

    // Convert dates to Unix milliseconds for GHL API
    // Use the later of the requested start or "now + 15 min" so past slots aren't fetched
    const requestedStartMs = new Date(calculatedStartDate).getTime();
    const startMs = Math.max(requestedStartMs, nowPlusBuffer);
    const endMs = new Date(calculatedEndDate).getTime();

    const slotsUrl = `/calendars/${installation.calendar_id}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=${encodeURIComponent(tz)}`;

    console.log("[Calendar] ===== FREE SLOTS REQUEST =====");
    console.log("[Calendar] URL:", slotsUrl);
    console.log("[Calendar] calendarId:", installation.calendar_id);
    console.log("[Calendar] time_preference:", timePreference);
    console.log("[Calendar] startDate:", calculatedStartDate, "-> requested:", requestedStartMs, "-> actual:", startMs);
    console.log("[Calendar] endDate:", calculatedEndDate, "->", endMs);
    console.log("[Calendar] timezone:", tz);
    console.log("[Calendar] Hawaii now:", hawaiiNowStr);
    console.log("[Calendar] nowPlusBuffer (Hawaii):", new Date(nowPlusBuffer).toLocaleString("en-US", { timeZone: HAWAII_TZ }));

    const client = await ghl.requests(resolvedLocationId);

    // Determine which days-of-week the business is actually open
    // Default to weekdays (Mon-Fri) if schedule lookup fails
    const WEEKDAYS_DEFAULT = new Set([1, 2, 3, 4, 5]); // Mon=1 … Fri=5
    let openDays: Set<number> = WEEKDAYS_DEFAULT;
    try {
      const schedule = await getCalendarSchedule(client, installation.calendar_id, tz);
      openDays = schedule.openDays;
      console.log(`[Calendar] Schedule lookup OK — open days: ${Array.from(openDays).sort().map((d) => DAY_NAMES[d]).join(", ")}`);
    } catch (schedErr: any) {
      console.error("[Calendar] Schedule lookup failed, defaulting to Mon-Fri:", schedErr?.message);
    }

    // Helper to filter slots by time preference
    function filterByTimePreference(slots: string[], preference: string): string[] {
      if (preference === "any") return slots;
      return slots.filter((iso) => {
        const match = iso.match(/T(\d{2}):/);
        if (!match) return true;
        const hour = parseInt(match[1], 10);
        if (preference === "morning") return hour < 12;
        if (preference === "afternoon") return hour >= 12;
        return true;
      });
    }

    const resp = await client.get(slotsUrl, {
      headers: { Version: "2021-07-28" },
    });

    const rawData = resp.data;
    console.log("[Calendar] Response keys:", Object.keys(rawData));

    // Filter: remove past slots, closed days, and format for the voice agent
    const availableDates: Array<{
      date: string;
      dayOfWeek: string;
      formattedSlots: string[];
      slots: string[];
    }> = [];

    if (typeof rawData === "object" && rawData !== null) {
      const dateKeys = Object.keys(rawData).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
      console.log(`[Calendar] Dates returned: ${dateKeys.length}`);

      for (const dateKey of dateKeys) {
        const d = new Date(dateKey + "T00:00:00");
        const dow = d.getDay();
        const dayName = DAY_NAMES[dow];
        const isClosedDay = !openDays.has(dow);

        const entry = rawData[dateKey];
        const daySlots: string[] = Array.isArray(entry) ? entry : (entry?.slots || []);
        // Compare slot times in Hawaii local time to filter out past slots
        const futureSlots = daySlots.filter((slot) => {
          const slotHawaiiStr = new Date(slot).toLocaleString("en-US", { timeZone: HAWAII_TZ });
          const slotHawaiiMs = new Date(slotHawaiiStr).getTime();
          return slotHawaiiMs >= nowPlusBuffer;
        });
        // Apply time preference filter (morning/afternoon/any)
        const filteredSlots = filterByTimePreference(futureSlots, timePreference);

        const removedCount = daySlots.length - futureSlots.length;
        const prefRemovedCount = futureSlots.length - filteredSlots.length;
        console.log(`[Calendar]   ${dateKey} (${dayName})${isClosedDay ? " *** CLOSED DAY *** SKIPPED" : ""}: ${daySlots.length} total, ${removedCount} past, ${prefRemovedCount} filtered by ${timePreference}, ${filteredSlots.length} available`);

        if (isClosedDay) continue;
        if (filteredSlots.length === 0) continue;

        // Format each slot time for easy reading by the voice agent
        const formattedSlots = filteredSlots.map((iso) => {
          const match = iso.match(/T(\d{2}):(\d{2})/);
          if (!match) return iso;
          const h = parseInt(match[1], 10);
          const m = parseInt(match[2], 10);
          const period = h >= 12 ? "PM" : "AM";
          const hour12 = h % 12 || 12;
          return m === 0 ? `${hour12}:00 ${period}` : `${hour12}:${m.toString().padStart(2, "0")} ${period}`;
        });

        availableDates.push({
          date: dateKey,
          dayOfWeek: dayName,
          formattedSlots,
          slots: filteredSlots,
        });
      }
    }

    // Return the 3 soonest slots per day for up to 5 business days
    const MAX_BUSINESS_DAYS = 5;
    const result: Record<string, Array<{ startTime: string; formatted: string; dayOfWeek: string }>> = {};
    let businessDayCount = 0;

    for (const day of availableDates) {
      if (businessDayCount >= MAX_BUSINESS_DAYS) break;

      // Take the 3 soonest slots for this day
      const soonest = day.slots.slice(0, 3).map((slot, i) => ({
        startTime: slot,
        formatted: day.formattedSlots[i],
        dayOfWeek: day.dayOfWeek,
      }));

      if (soonest.length > 0) {
        result[day.date] = soonest;
        businessDayCount++;
      }
    }

    console.log(`[Calendar] Returning slots for ${businessDayCount} business days`);

    return res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error("[Calendar] free-slots error:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data?.message || error.message,
    });
  }
});

/**
 * POST /api/calendar/business-hours
 * Fetch the calendar's availability schedule and return it formatted for speech.
 *
 * Body: { locationId }
 * The 'action' field from ElevenLabs is ignored.
 */
router.post("/business-hours", async (req: Request, res: Response) => {
  try {
    const { locationId, location_id, calendarId, calendar_id } = req.body;
    const resolvedLocationId = locationId || location_id;
    const calendarIdParam = calendarId || calendar_id;

    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }

    const installation = await getInstallation(resolvedLocationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    const calId = calendarIdParam || installation.calendar_id;
    if (!calId) {
      return res.status(400).json({ success: false, error: "No calendar configured for this location" });
    }

    const client = await ghl.requests(resolvedLocationId);
    const tz = installation.timezone || "America/New_York";

    // Uses the same cached reference-week logic as free-slots filtering
    const { openDays, dayInfo } = await getCalendarSchedule(client, calId, tz);

    if (openDays.size === 0) {
      return res.json({
        success: true,
        formatted: "No availability found for the coming week.",
        raw: [],
      });
    }

    // Group days with the same hours (use time portion only, not full ISO date)
    const hourGroups: Map<string, number[]> = new Map();
    for (const [dow, info] of dayInfo) {
      const earliestTime = info.earliest.match(/T(\d{2}:\d{2})/)?.[1] || info.earliest;
      const latestTime = info.latest.match(/T(\d{2}:\d{2})/)?.[1] || info.latest;
      const groupKey = `${earliestTime}|${latestTime}`;
      if (!hourGroups.has(groupKey)) hourGroups.set(groupKey, []);
      hourGroups.get(groupKey)!.push(dow);
    }

    // Format for speech
    const parts: string[] = [];
    for (const [groupKey, days] of hourGroups) {
      const [earliestTime, latestTime] = groupKey.split("|");
      const dayRange = formatDayRange(days);

      // earliestTime/latestTime are "HH:mm" extracted from ISO strings
      const [oH, oM] = earliestTime.split(":").map(Number);
      const [cH, cM] = latestTime.split(":").map(Number);
      // The last slot is the START of the last appointment slot, add 1hr for closing time
      const openStr = formatTimeForSpeech(oH, oM);
      const closeStr = formatTimeForSpeech(cH + 1, cM);

      parts.push(`${dayRange}, ${openStr} to ${closeStr}`);
    }

    const formatted = parts.join(". ");
    console.log(`[Calendar] Inferred hours: ${formatted}`);

    return res.json({
      success: true,
      formatted,
      daysAvailable: Array.from(openDays).sort().map((d) => DAY_NAMES[d]),
    });
  } catch (error: any) {
    console.error("[Calendar] business-hours error:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data?.message || error.message,
    });
  }
});

// --- Formatting helpers ---

function formatTimeForSpeech(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  const wordNums: Record<number, string> = {
    1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
    6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
    11: "eleven", 12: "twelve",
  };
  const hourWord = wordNums[h] || String(h);
  if (minute === 0) return `${hourWord} ${period}`;
  if (minute === 30) return `${hourWord} thirty ${period}`;
  if (minute === 15) return `${hourWord} fifteen ${period}`;
  if (minute === 45) return `${hourWord} forty-five ${period}`;
  return `${hourWord} ${minute} ${period}`;
}

function formatDayRange(days: number[]): string {
  if (days.length === 0) return "";
  if (days.length === 1) return DAY_NAMES[days[0]];

  // Check if days are consecutive
  const sorted = [...days].sort((a, b) => a - b);
  let isConsecutive = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      isConsecutive = false;
      break;
    }
  }

  if (isConsecutive && sorted.length >= 3) {
    return `${DAY_NAMES[sorted[0]]} through ${DAY_NAMES[sorted[sorted.length - 1]]}`;
  }

  // List individually
  const names = sorted.map((d) => DAY_NAMES[d]);
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}

/**
 * POST /api/calendar/check-availability
 * Smart availability check for voice agents.
 *
 * TWO MODES:
 * 1. Time preference mode (morning/afternoon): Returns 1 slot per day for next 3 available days
 * 2. Specific date/time mode: Checks if requested slot is available, or returns nearby alternatives
 *
 * Body: {
 *   locationId,
 *   time_preference?: "morning" | "afternoon",  // Mode 1
 *   requested_date?: string,                     // Mode 2: "2026-02-07" or "Friday"
 *   requested_time?: string                      // Mode 2: "2:00 PM" or "14:00"
 * }
 *
 * Time ranges:
 *   - Morning = opening time to 12:00 PM
 *   - Afternoon = 12:15 PM to closing time
 *
 * Response: { slots: [{ date, time, label, startTime }] }
 * Labels: "today", "tomorrow", or day name (e.g., "Friday")
 */
router.post("/check-availability", async (req: Request, res: Response) => {
  try {
    const { locationId, location_id, time_preference, requested_date, requested_time } = req.body;
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: locationId",
      });
    }

    const installation = await getInstallation(resolvedLocationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    if (!installation.calendar_id) {
      return res.status(400).json({ success: false, error: "No calendar configured for this location" });
    }

    // Use Pacific/Honolulu timezone for all calculations
    const HAWAII_TZ = "Pacific/Honolulu";
    const hawaiiNowStr = new Date().toLocaleString("en-US", { timeZone: HAWAII_TZ });
    const hawaiiNow = new Date(hawaiiNowStr);

    // Calculate date strings for labeling
    const yyyy = hawaiiNow.getFullYear();
    const mm = String(hawaiiNow.getMonth() + 1).padStart(2, "0");
    const dd = String(hawaiiNow.getDate()).padStart(2, "0");
    const todayStr = `${yyyy}-${mm}-${dd}`;

    const tomorrowObj = new Date(hawaiiNow);
    tomorrowObj.setDate(tomorrowObj.getDate() + 1);
    const tomorrowStr = `${tomorrowObj.getFullYear()}-${String(tomorrowObj.getMonth() + 1).padStart(2, "0")}-${String(tomorrowObj.getDate()).padStart(2, "0")}`;

    // Calculate date range: today through 14 days ahead (to ensure we find 3 days)
    const endDateObj = new Date(hawaiiNow);
    endDateObj.setDate(endDateObj.getDate() + 14);
    const endDateStr = `${endDateObj.getFullYear()}-${String(endDateObj.getMonth() + 1).padStart(2, "0")}-${String(endDateObj.getDate()).padStart(2, "0")}`;

    // 15-minute buffer so we don't offer slots that are about to pass
    const BUFFER_MS = 15 * 60 * 1000;
    const nowPlusBuffer = hawaiiNow.getTime() + BUFFER_MS;

    const startMs = Math.max(new Date(todayStr).getTime(), nowPlusBuffer);
    const endMs = new Date(endDateStr).getTime();

    const client = await ghl.requests(resolvedLocationId);
    const tz = installation.timezone || HAWAII_TZ;

    const slotsUrl = `/calendars/${installation.calendar_id}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=${encodeURIComponent(tz)}`;

    console.log("[Calendar] ===== CHECK AVAILABILITY =====");
    console.log("[Calendar] Mode:", time_preference ? `preference (${time_preference})` : requested_date ? "specific date/time" : "general");
    console.log("[Calendar] URL:", slotsUrl);

    // Get calendar schedule to know which days are open
    let openDays: Set<number> = new Set([1, 2, 3, 4, 5]); // Default Mon-Fri
    try {
      const schedule = await getCalendarSchedule(client, installation.calendar_id, tz);
      openDays = schedule.openDays;
    } catch (err: any) {
      console.error("[Calendar] Schedule lookup failed:", err?.message);
    }

    const resp = await client.get(slotsUrl, {
      headers: { Version: "2021-07-28" },
    });

    const rawData = resp.data;

    // Helper: get label for a date
    function getDateLabel(dateKey: string): string {
      if (dateKey === todayStr) return "today";
      if (dateKey === tomorrowStr) return "tomorrow";
      const d = new Date(dateKey + "T00:00:00");
      return DAY_NAMES[d.getDay()];
    }

    // Helper: format time for display
    function formatTime(iso: string): string {
      const match = iso.match(/T(\d{2}):(\d{2})/);
      if (!match) return iso;
      const h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const period = h >= 12 ? "PM" : "AM";
      const hour12 = h % 12 || 12;
      return m === 0 ? `${hour12}:00 ${period}` : `${hour12}:${m.toString().padStart(2, "0")} ${period}`;
    }

    // Helper: check if slot is in morning (before 12:00 PM)
    function isMorning(iso: string): boolean {
      const match = iso.match(/T(\d{2}):(\d{2})/);
      if (!match) return false;
      const h = parseInt(match[1], 10);
      return h < 12;
    }

    // Helper: check if slot is in afternoon (12:15 PM or later)
    function isAfternoon(iso: string): boolean {
      const match = iso.match(/T(\d{2}):(\d{2})/);
      if (!match) return false;
      const h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      return h > 12 || (h === 12 && m >= 15);
    }

    // Helper: filter past slots
    function filterFutureSlots(slots: string[]): string[] {
      return slots.filter((slot) => {
        const slotHawaiiStr = new Date(slot).toLocaleString("en-US", { timeZone: HAWAII_TZ });
        const slotHawaiiMs = new Date(slotHawaiiStr).getTime();
        return slotHawaiiMs >= nowPlusBuffer;
      });
    }

    // Helper: resolve day name to date string (e.g., "Friday" -> "2026-02-07")
    function resolveDayName(dayName: string): string | null {
      const normalized = dayName.toLowerCase().trim();
      if (normalized === "today") return todayStr;
      if (normalized === "tomorrow") return tomorrowStr;

      const dayIndex = DAY_NAMES.findIndex((d) => d.toLowerCase() === normalized);
      if (dayIndex === -1) return null;

      // Find next occurrence of this day
      const currentDow = hawaiiNow.getDay();
      let daysAhead = dayIndex - currentDow;
      if (daysAhead <= 0) daysAhead += 7;

      const targetDate = new Date(hawaiiNow);
      targetDate.setDate(targetDate.getDate() + daysAhead);
      return `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, "0")}-${String(targetDate.getDate()).padStart(2, "0")}`;
    }

    // Parse raw data into usable structure
    const availabilityByDate: Map<string, string[]> = new Map();
    if (typeof rawData === "object" && rawData !== null) {
      const dateKeys = Object.keys(rawData).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
      for (const dateKey of dateKeys) {
        const d = new Date(dateKey + "T00:00:00");
        if (!openDays.has(d.getDay())) continue;

        const entry = rawData[dateKey];
        const daySlots: string[] = Array.isArray(entry) ? entry : (entry?.slots || []);
        const futureSlots = filterFutureSlots(daySlots);
        if (futureSlots.length > 0) {
          availabilityByDate.set(dateKey, futureSlots);
        }
      }
    }

    let resultSlots: Array<{ date: string; time: string; label: string; startTime: string }> = [];

    // Helper: parse time string to minutes since midnight
    function parseTimeToMinutes(timeStr: string): number | null {
      const normalized = timeStr.toLowerCase().replace(/\s+/g, "");
      const match12 = normalized.match(/^(\d{1,2}):?(\d{2})?(am|pm)?$/);
      const match24 = normalized.match(/^(\d{1,2}):(\d{2})$/);

      let hour = 0;
      let min = 0;

      if (match12) {
        hour = parseInt(match12[1], 10);
        min = match12[2] ? parseInt(match12[2], 10) : 0;
        if (match12[3] === "pm" && hour !== 12) hour += 12;
        if (match12[3] === "am" && hour === 12) hour = 0;
      } else if (match24) {
        hour = parseInt(match24[1], 10);
        min = parseInt(match24[2], 10);
      } else {
        return null;
      }

      return hour * 60 + min;
    }

    // Helper: get slot time in minutes
    function getSlotMinutes(iso: string): number {
      const match = iso.match(/T(\d{2}):(\d{2})/);
      if (!match) return 0;
      return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    }

    // Helper: find best slot from list (closest to target time, or first if no target)
    function findBestSlot(slots: string[], targetMinutes: number | null): string | null {
      if (slots.length === 0) return null;
      if (targetMinutes === null) return slots[0];

      let bestSlot = slots[0];
      let bestDiff = Math.abs(getSlotMinutes(slots[0]) - targetMinutes);

      for (const slot of slots) {
        const diff = Math.abs(getSlotMinutes(slot) - targetMinutes);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestSlot = slot;
        }
      }
      return bestSlot;
    }

    // MODE 1: Time preference (morning/afternoon) - with optional target time
    // Find next 3 DAYS with availability in that time range, return 1 slot per day
    if (time_preference) {
      const pref = time_preference.toLowerCase();
      const filterFn = pref === "morning" ? isMorning : isAfternoon;
      const targetMinutes = requested_time ? parseTimeToMinutes(requested_time) : null;
      let daysFound = 0;

      console.log(`[Calendar] Time preference: ${pref}, target time: ${requested_time || "none"}`);

      for (const [dateKey, slots] of availabilityByDate) {
        if (daysFound >= 3) break;

        const matchingSlots = slots.filter(filterFn);
        if (matchingSlots.length > 0) {
          // Find the best slot (closest to target time if specified, otherwise first)
          const bestSlot = findBestSlot(matchingSlots, targetMinutes);
          if (bestSlot) {
            resultSlots.push({
              date: dateKey,
              time: formatTime(bestSlot),
              label: getDateLabel(dateKey),
              startTime: bestSlot,
            });
            daysFound++;
          }
        }
      }

      console.log(`[Calendar] Time preference "${pref}": found ${daysFound} days with availability`);
    }
    // MODE 2: Specific date/time request (no time_preference)
    else if (requested_date || requested_time) {
      // Resolve the requested date
      let targetDate = requested_date;
      if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        const resolved = resolveDayName(targetDate);
        if (resolved) targetDate = resolved;
      }
      if (!targetDate) targetDate = todayStr;

      const daySlots = availabilityByDate.get(targetDate) || [];

      if (requested_time) {
        const targetMinutes = parseTimeToMinutes(requested_time);

        if (targetMinutes !== null) {
          // Find exact match or nearby slots
          let exactMatch: string | null = null;
          const nearbySlots: Array<{ slot: string; diff: number }> = [];

          for (const slot of daySlots) {
            const slotMinutes = getSlotMinutes(slot);
            const diff = Math.abs(slotMinutes - targetMinutes);

            if (diff === 0) {
              exactMatch = slot;
            } else if (diff <= 90) {
              nearbySlots.push({ slot, diff });
            }
          }

          if (exactMatch) {
            resultSlots.push({
              date: targetDate,
              time: formatTime(exactMatch),
              label: getDateLabel(targetDate),
              startTime: exactMatch,
            });
            console.log(`[Calendar] Exact match found for ${requested_time} on ${targetDate}`);
          } else if (nearbySlots.length > 0) {
            nearbySlots.sort((a, b) => a.diff - b.diff);
            for (const { slot } of nearbySlots.slice(0, 3)) {
              resultSlots.push({
                date: targetDate,
                time: formatTime(slot),
                label: getDateLabel(targetDate),
                startTime: slot,
              });
            }
            console.log(`[Calendar] No exact match, returning ${resultSlots.length} nearby alternatives`);
          } else {
            console.log(`[Calendar] No availability on ${targetDate} near ${requested_time}`);
          }
        }
      } else {
        // No specific time, return first 3 slots for that day
        for (const slot of daySlots.slice(0, 3)) {
          resultSlots.push({
            date: targetDate,
            time: formatTime(slot),
            label: getDateLabel(targetDate),
            startTime: slot,
          });
        }
        console.log(`[Calendar] Returning ${resultSlots.length} slots for ${targetDate}`);
      }
    }
    // DEFAULT MODE: No preference specified, return 1 slot per day for next 3 days
    else {
      let daysFound = 0;
      for (const [dateKey, slots] of availabilityByDate) {
        if (daysFound >= 3) break;
        if (slots.length > 0) {
          resultSlots.push({
            date: dateKey,
            time: formatTime(slots[0]),
            label: getDateLabel(dateKey),
            startTime: slots[0],
          });
          daysFound++;
        }
      }
      console.log(`[Calendar] Default mode: returning ${daysFound} days`);
    }

    return res.json({
      success: true,
      slots: resultSlots,
    });
  } catch (error: any) {
    console.error("[Calendar] check-availability error:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data?.message || error.message,
    });
  }
});

/**
 * POST /api/calendar/book
 * Create or upsert a GHL contact, then book an appointment.
 *
 * Accepts both camelCase and snake_case field names:
 *   - locationId / location_id
 *   - calendarId / calendar_id
 *   - startTime / start_time
 *   - customerName / customer_name
 *   - customerEmail / customer_email
 *   - customerPhone / customer_phone
 *   - serviceType / service_type
 *   - therapistPreference / therapist_preference
 *
 * The 'action' field from ElevenLabs is ignored.
 */
router.post("/book", async (req: Request, res: Response) => {
  try {
    const body = req.body;

    // Accept both camelCase and snake_case (camelCase takes priority)
    const locationId = body.locationId || body.location_id;
    const calendarId = body.calendarId || body.calendar_id;
    const startTime = body.startTime || body.start_time;
    const customerName = body.customerName || body.customer_name;
    const customerEmail = body.customerEmail || body.customer_email;
    const customerPhone = body.customerPhone || body.customer_phone;
    const serviceType = body.serviceType || body.service_type;
    const therapistPreference = body.therapistPreference || body.therapist_preference;
    const occasion = body.occasion;
    const title = body.title;
    const notes = body.notes;
    // 'action' field from ElevenLabs is intentionally ignored

    if (!locationId || !startTime || !customerName || !customerEmail) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: locationId, startTime, customerName, customerEmail",
      });
    }

    console.log("[Calendar] ===== BOOK REQUEST (normalized) =====");
    console.log("[Calendar] locationId:", locationId);
    console.log("[Calendar] startTime:", startTime);
    console.log("[Calendar] customerName:", customerName);
    console.log("[Calendar] customerEmail:", customerEmail);
    console.log("[Calendar] customerPhone:", customerPhone);
    console.log("[Calendar] serviceType:", serviceType);

    // 1. Look up installation
    const installation = await getInstallation(locationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    const resolvedCalendarId = calendarId || installation.calendar_id;
    if (!resolvedCalendarId) {
      return res.status(400).json({ success: false, error: "No calendar configured for this location" });
    }

    // 2. Get authenticated client (refreshes token if expired)
    const client = await ghl.requests(locationId);

    // 3. Create or upsert contact in GHL
    const nameParts = customerName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(" ") || "";

    const normalizedPhone = customerPhone ? normalizePhone(customerPhone) : null;
    if (customerPhone) {
      console.log(`[Calendar] Phone normalization: "${customerPhone}" -> "${normalizedPhone}"`);
    }

    const contactPayload: Record<string, string> = {
      locationId,
      email: customerEmail,
      firstName,
    };
    if (lastName) contactPayload.lastName = lastName;
    if (normalizedPhone) contactPayload.phone = normalizedPhone;

    let contactId: string;
    try {
      const contactResp = await client.post("/contacts/upsert", contactPayload, {
        headers: { Version: "2021-07-28" },
      });
      contactId = contactResp.data?.contact?.id;
      if (!contactId) {
        throw new Error("No contact ID returned from upsert");
      }
      console.log(`[Calendar] Contact upserted: ${contactId} (${customerEmail})`);
    } catch (err: any) {
      console.error("[Calendar] Contact upsert failed:", err?.response?.data || err.message);
      return res.status(500).json({
        success: false,
        error: "Failed to create/upsert contact: " + (err?.response?.data?.message || err.message),
      });
    }

    // 4. Book the appointment
    const startISO = new Date(startTime).toISOString();
    // Default to 1 hour duration
    const endISO = new Date(new Date(startTime).getTime() + 60 * 60 * 1000).toISOString();

    // Title-case the service type
    const formattedServiceType = serviceType ? toTitleCase(serviceType) : null;

    // Build title from serviceType or fallback
    const appointmentTitle = formattedServiceType || title || "Appointment";

    // Build notes: e.g. "Deep Tissue Massage - One Hour. Therapist preference: Female. Occasion: Birthday"
    const noteParts: string[] = [];
    if (formattedServiceType) {
      noteParts.push(formattedServiceType);
    }
    if (therapistPreference) {
      noteParts.push(`Therapist preference: ${therapistPreference}`);
    }
    if (occasion) {
      noteParts.push(`Occasion: ${occasion}`);
    }
    if (notes) {
      noteParts.push(notes);
    }
    const appointmentNotes = noteParts.join(". ");

    const appointmentPayload = {
      calendarId: resolvedCalendarId,
      locationId,
      contactId,
      startTime: startISO,
      endTime: endISO,
      title: appointmentTitle,
      appointmentStatus: "confirmed",
      notes: appointmentNotes || undefined,
    };

    console.log("[Calendar] ===== CREATE APPOINTMENT REQUEST =====");
    console.log("[Calendar] Endpoint: POST /calendars/events/appointments");
    console.log("[Calendar] Payload:", JSON.stringify(appointmentPayload, null, 2));

    const appointmentResp = await client.post(
      "/calendars/events/appointments",
      appointmentPayload,
      { headers: { Version: "2021-07-28" } }
    );

    console.log("[Calendar] ===== CREATE APPOINTMENT RESPONSE =====");
    console.log("[Calendar] Response:", JSON.stringify(appointmentResp.data, null, 2));

    const appointmentId =
      appointmentResp.data?.id ||
      appointmentResp.data?.event?.id ||
      appointmentResp.data?.eventId ||
      appointmentResp.data?.appointment?.id ||
      null;

    console.log(`[Calendar] Appointment booked: ${appointmentId} for contact ${contactId}`);

    // 5. Create Internal Note via Appointment Notes API
    if (appointmentNotes && appointmentId) {
      try {
        const noteResp = await client.post(
          `/calendars/appointments/${appointmentId}/notes`,
          { body: appointmentNotes },
          { headers: { Version: "2021-07-28" } }
        );
        console.log(`[Calendar] Note created for ${appointmentId}:`, JSON.stringify(noteResp.data));
      } catch (noteErr: any) {
        console.error("[Calendar] Note creation failed:", noteErr?.response?.status, noteErr?.response?.data || noteErr.message);
      }
    }

    // 6. Return success
    return res.json({
      success: true,
      appointmentId,
      contactId,
      data: appointmentResp.data,
    });
  } catch (error: any) {
    console.error("[Calendar] book error:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data?.message || error.message,
    });
  }
});

/**
 * POST /api/calendar/cancel
 * Cancel an appointment.
 *
 * Body: { locationId, eventId }
 */
router.post("/cancel", async (req: Request, res: Response) => {
  try {
    const { locationId, eventId } = req.body as CancelAppointmentRequest;

    if (!locationId || !eventId) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: locationId, eventId",
      });
    }

    const installation = await getInstallation(locationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    const client = await ghl.requests(locationId);
    const resp = await client.delete(
      `/calendars/events/appointments/${eventId}`,
      { headers: { Version: "2021-07-28" } }
    );

    return res.json({
      success: true,
      data: resp.data,
    });
  } catch (error: any) {
    console.error("[Calendar] cancel error:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data?.message || error.message,
    });
  }
});

/**
 * POST /api/calendar/reschedule
 * Reschedule an existing appointment.
 *
 * Body: { locationId, eventId, startTime, endTime }
 */
router.post("/reschedule", async (req: Request, res: Response) => {
  try {
    const { locationId, eventId, startTime, endTime } = req.body as RescheduleAppointmentRequest;

    if (!locationId || !eventId || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: locationId, eventId, startTime, endTime",
      });
    }

    const installation = await getInstallation(locationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    const client = await ghl.requests(locationId);
    const resp = await client.put(
      `/calendars/events/appointments/${eventId}`,
      {
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
      },
      { headers: { Version: "2021-07-28" } }
    );

    return res.json({
      success: true,
      data: resp.data,
    });
  } catch (error: any) {
    console.error("[Calendar] reschedule error:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data?.message || error.message,
    });
  }
});

export default router;
