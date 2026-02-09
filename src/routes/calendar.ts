import { Router, Request, Response } from "express";
import axios from "axios";
import { DateTime } from "luxon";
import * as chrono from "chrono-node";
import { GHL } from "../ghl";
import {
  getInstallation,
  getBusinessInfo,
  updateBusinessInfo,
  getServiceMappings,
  getCalendarsForService,
  getStaffCalendars,
  setServiceMappings,
  upsertServiceMapping,
  deleteServiceMappings,
  deleteServiceMappingById,
  getSyncStatus,
  getSyncedCalendars,
  getSyncedCalendarById,
  getSyncedCalendarsForService,
  getSyncedTeamMembers,
  getUniqueStaffNames,
  getCalendarsForStaffMember,
  getTeamMembersByGender,
  updateTeamMemberGender,
  updateTeamMemberName,
  getUniqueTeamMembers,
  getPackages,
  getPackageByName,
  upsertPackage,
  deletePackage,
} from "../db";
import { syncLocation } from "../sync";
import {
  FreeSlotsRequest,
  BookAppointmentRequest,
  CancelAppointmentRequest,
  RescheduleAppointmentRequest,
} from "../types";

const router = Router();
const ghl = new GHL();

// ---------------------------------------------------------------------------
// PLAN CACHE: Per BOOKING-LOGIC-SPEC Section 7 (Check-vs-Book Consistency)
// When check_availability builds a package plan, cache it with a short TTL.
// When book_appointment is called with the plan_id, use the EXACT cached plan
// instead of recalculating. This eliminates the "check says available, book
// says not" bug.
// ---------------------------------------------------------------------------
interface CachedPlan {
  locationId: string;
  packageName: string;
  plan: {
    date: string;
    slots: Array<{
      service: string;
      startTime: string;
      endTime: string;
      calendar_id: string;
      staff_name: string | null;
      staff_user_id: string | null;
    }>;
  };
  createdAt: number;
}

const planCache = new Map<string, CachedPlan>();
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generatePlanId(): string {
  return `plan_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

function cachePlan(planId: string, plan: CachedPlan): void {
  planCache.set(planId, plan);
  console.log(`[PlanCache] Cached plan ${planId} for ${plan.packageName} on ${plan.plan.date}`);
}

function getCachedPlan(planId: string): CachedPlan | null {
  const cached = planCache.get(planId);
  if (!cached) {
    console.log(`[PlanCache] Plan ${planId} not found in cache`);
    return null;
  }

  const age = Date.now() - cached.createdAt;
  if (age > PLAN_CACHE_TTL_MS) {
    console.log(`[PlanCache] Plan ${planId} expired (age: ${Math.round(age / 1000)}s)`);
    planCache.delete(planId);
    return null;
  }

  console.log(`[PlanCache] Retrieved plan ${planId} (age: ${Math.round(age / 1000)}s)`);
  return cached;
}

// Cleanup expired plans every minute
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [planId, cached] of planCache) {
    if (now - cached.createdAt > PLAN_CACHE_TTL_MS) {
      planCache.delete(planId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[PlanCache] Cleaned up ${cleaned} expired plans`);
  }
}, 60 * 1000);

/**
 * Get timezone-aware current time info for a location.
 * Uses luxon for reliable timezone handling on servers.
 */
function getLocalTimeInfo(timezone: string): {
  now: DateTime;
  todayStr: string;
  currentTimeStr: string;
  todayFormatted: string;
} {
  const now = DateTime.now().setZone(timezone);
  return {
    now,
    todayStr: now.toFormat("yyyy-MM-dd"),
    currentTimeStr: now.toFormat("h:mm a"), // "2:09 PM"
    todayFormatted: now.toFormat("cccc, MMMM d, yyyy"), // "Friday, February 7, 2026"
  };
}

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

    // Get installation first to determine the location's timezone
    const installation = await getInstallation(resolvedLocationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    if (!installation.calendar_id) {
      return res.status(400).json({ success: false, error: "No calendar configured for this location" });
    }

    const tz = timezone || installation.timezone || "America/New_York";

    // Use luxon for reliable timezone handling
    const localNow = DateTime.now().setZone(tz);
    console.log(`[FreeSlots] Timezone: ${tz}, LocalNow: ${localNow.toFormat("yyyy-MM-dd HH:mm")}`);

    const daysAhead = duration_minutes ? Math.ceil(duration_minutes / (24 * 60)) : 7;

    let calculatedStartDate: string;
    let calculatedEndDate: string;

    if (startDate && endDate) {
      calculatedStartDate = startDate;
      calculatedEndDate = endDate;
    } else {
      // Auto-calculate using location's timezone
      calculatedStartDate = localNow.toFormat("yyyy-MM-dd");
      calculatedEndDate = localNow.plus({ days: daysAhead }).toFormat("yyyy-MM-dd");
    }

    // Normalize time_preference
    const timePreference = (time_preference || "any").toLowerCase();

    // 15-minute buffer so we don't offer slots that are about to pass
    const BUFFER_MS = 15 * 60 * 1000;
    const nowPlusBuffer = localNow.toMillis() + BUFFER_MS;

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
    console.log("[Calendar] localNow:", localNow.toFormat("yyyy-MM-dd HH:mm"));
    console.log("[Calendar] nowPlusBuffer:", DateTime.fromMillis(nowPlusBuffer).setZone(tz).toFormat("yyyy-MM-dd HH:mm"));

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
        // Compare slot times to filter out past slots using luxon
        const futureSlots = daySlots.filter((slot) => {
          // Parse the slot ISO string and compare against nowPlusBuffer
          const slotMs = DateTime.fromISO(slot).toMillis();
          return slotMs >= nowPlusBuffer;
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

// --- Check-availability helpers (defined outside route for cleaner code) ---

function formatSlotTime(iso: string): string {
  const match = iso.match(/T(\d{2}):(\d{2})/);
  if (!match) return iso;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  return m === 0 ? `${hour12}:00 ${period}` : `${hour12}:${m.toString().padStart(2, "0")} ${period}`;
}

function isSlotMorning(iso: string): boolean {
  const match = iso.match(/T(\d{2}):/);
  if (!match) return false;
  return parseInt(match[1], 10) < 12;
}

function isSlotAfternoon(iso: string): boolean {
  const match = iso.match(/T(\d{2}):(\d{2})/);
  if (!match) return false;
  const h = parseInt(match[1], 10);
  // FIX 4: 12:00 PM and later is ALWAYS afternoon (hour >= 12)
  return h >= 12;
}

function getSlotMinutes(iso: string): number {
  const match = iso.match(/T(\d{2}):(\d{2})/);
  if (!match) return 0;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

/**
 * Parse a time string to minutes from midnight.
 * Handles:
 * 1. ISO strings like "2026-02-12T12:00:00-10:00" — extracts time in the given timezone
 * 2. Simple 12-hour format like "12:00 PM" or "9:00am"
 * 3. Simple 24-hour format like "12:00" or "09:00"
 *
 * IMPORTANT: For ISO strings, the timezone parameter is required to convert correctly.
 * The timezone should come from the installation record, never hardcoded.
 */
function parseTimeToMinutes(timeStr: string, timezone?: string): number | null {
  if (!timeStr) return null;

  // Check if this is an ISO string (contains "T" and looks like a date)
  if (timeStr.includes("T") && timeStr.match(/^\d{4}-\d{2}-\d{2}T/)) {
    try {
      // Use luxon to parse the ISO string and convert to the business timezone
      const tz = timezone || "America/New_York"; // Fallback, but should always be provided
      const dt = DateTime.fromISO(timeStr).setZone(tz);

      if (!dt.isValid) {
        console.log(`[parseTimeToMinutes] Invalid ISO date: ${timeStr}`);
        return null;
      }

      const hour = dt.hour;
      const min = dt.minute;
      console.log(`[parseTimeToMinutes] ISO string ${timeStr} => ${hour}:${min.toString().padStart(2, "0")} in ${tz} => ${hour * 60 + min} minutes`);
      return hour * 60 + min;
    } catch (err) {
      console.log(`[parseTimeToMinutes] Error parsing ISO string: ${timeStr}`, err);
      return null;
    }
  }

  // Simple time format parsing (12-hour or 24-hour)
  const normalized = timeStr.toLowerCase().replace(/\s+/g, "");
  const match12 = normalized.match(/^(\d{1,2}):?(\d{2})?(am|pm)?$/);
  const match24 = normalized.match(/^(\d{1,2}):(\d{2})$/);
  let hour = 0, min = 0;

  if (match12) {
    hour = parseInt(match12[1], 10);
    min = match12[2] ? parseInt(match12[2], 10) : 0;
    if (match12[3] === "pm" && hour !== 12) hour += 12;
    if (match12[3] === "am" && hour === 12) hour = 0;
  } else if (match24) {
    hour = parseInt(match24[1], 10);
    min = parseInt(match24[2], 10);
  } else {
    console.log(`[parseTimeToMinutes] Could not parse time format: ${timeStr}`);
    return null;
  }

  return hour * 60 + min;
}

/**
 * POST /api/calendar/sync
 * Trigger a sync of calendars from GHL.
 *
 * Body: { locationId }
 * Response: { success, calendars, teamMembers }
 */
router.post("/sync", async (req: Request, res: Response) => {
  try {
    const { locationId, location_id } = req.body;
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }

    const result = await syncLocation(resolvedLocationId);

    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    return res.json({
      success: true,
      calendars: result.calendars,
      teamMembers: result.teamMembers,
    });
  } catch (error: any) {
    console.error("[Calendar] sync error:", error?.message);
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * GET /api/calendar/sync-status
 * Get the sync status for a location.
 *
 * Query: ?locationId=xxx
 * Response: { success, last_sync_at, calendars_count, team_members_count, error_message }
 */
router.get("/sync-status", async (req: Request, res: Response) => {
  try {
    const locationId = req.query.locationId as string;

    if (!locationId) {
      return res.status(400).json({ success: false, error: "Missing required query param: locationId" });
    }

    const status = await getSyncStatus(locationId);

    if (!status) {
      return res.json({
        success: true,
        last_sync_at: null,
        calendars_count: 0,
        team_members_count: 0,
        sync_in_progress: false,
        error_message: null,
        message: "Never synced",
      });
    }

    return res.json({
      success: true,
      last_sync_at: status.last_sync_at,
      calendars_count: status.calendars_count,
      team_members_count: status.team_members_count,
      sync_in_progress: status.sync_in_progress,
      error_message: status.error_message,
    });
  } catch (error: any) {
    console.error("[Calendar] sync-status error:", error?.message);
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * POST /api/calendar/business-info
 * Get or update business info and service mappings.
 *
 * GET: Body: { locationId }
 * Response: { success, business_name, services, greeting, service_mappings }
 *
 * SET: Body: { locationId, business_name, services, greeting, service_mappings? }
 * service_mappings: [{ service_name, calendar_id, staff_name }]
 */
router.post("/business-info", async (req: Request, res: Response) => {
  try {
    const { locationId, location_id, business_name, services, greeting, service_mappings } = req.body;
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }

    // If business_name is provided, this is an UPDATE request
    if (business_name) {
      await updateBusinessInfo(
        resolvedLocationId,
        business_name,
        services || [],
        greeting || `Welcome to ${business_name}`
      );

      // Update service mappings if provided
      if (service_mappings && Array.isArray(service_mappings)) {
        await setServiceMappings(resolvedLocationId, service_mappings);
      }

      return res.json({ success: true, message: "Business info updated" });
    }

    // Otherwise, GET the business info
    const info = await getBusinessInfo(resolvedLocationId);

    // Get services from synced calendars (calendar names are service names)
    const syncedCalendars = await getSyncedCalendars(resolvedLocationId);
    const syncedServices = syncedCalendars.map((c) => c.calendar_name);

    // Get staff from synced team members
    const staffNames = await getUniqueStaffNames(resolvedLocationId);

    // Get packages
    const packages = await getPackages(resolvedLocationId);

    // Build services list from synced GHL calendars (no hardcoded defaults - this is a platform)
    const servicesList = syncedServices.length > 0 ? syncedServices : (info?.services || []);

    return res.json({
      success: true,
      business_name: info?.business_name || null,  // No hardcoded default - read from GHL
      services: servicesList,
      staff: staffNames,
      packages: packages.map((p) => ({
        name: p.package_name,
        services: p.services,
        total_duration_minutes: p.total_duration_minutes,
        price: p.price,
        description: p.description,
      })),
      greeting: info?.greeting || null,  // No hardcoded default - read from GHL
      synced_calendars: syncedCalendars.map((c) => ({
        calendar_id: c.calendar_id,
        calendar_name: c.calendar_name,
        calendar_type: c.calendar_type,
      }))
    });

  } catch (error: any) {
    console.error("[Calendar] business-info error:", error?.message);
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * POST /api/calendar/location-info
 * CONSOLIDATED TOOL #1: Get all location info in one call.
 * Replaces: get_business_hours, get_business_info, get_package_info
 *
 * Body: { locationId }
 *
 * Returns: business_name, business_hours, services, packages, staff, today, currentTime, timezone
 */
router.post("/location-info", async (req: Request, res: Response) => {
  try {
    const { locationId, location_id } = req.body;
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }

    const installation = await getInstallation(resolvedLocationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    // Use luxon for reliable timezone handling
    const tz = installation.timezone || "America/New_York";
    const { todayStr, currentTimeStr } = getLocalTimeInfo(tz);
    console.log(`[LocationInfo] Timezone: ${tz}, Today: ${todayStr}, CurrentTime: ${currentTimeStr}`);

    // Get business info
    const info = await getBusinessInfo(resolvedLocationId);

    // Get synced calendars (services)
    const syncedCalendars = await getSyncedCalendars(resolvedLocationId);
    const services = syncedCalendars.map((c) => ({
      name: c.calendar_name,
      duration: c.slot_duration || 60,
      calendar_id: c.calendar_id,
    }));

    // Get packages
    const packages = await getPackages(resolvedLocationId);
    const packagesFormatted = packages.map((p) => ({
      name: p.package_name,
      services: p.services,
      total_duration_minutes: p.total_duration_minutes,
      price: p.price,
      description: p.description,
    }));

    // Get staff with their services
    const staffMap: Map<string, Set<string>> = new Map();
    for (const cal of syncedCalendars) {
      const members = await getSyncedTeamMembers(resolvedLocationId, cal.calendar_id);
      for (const member of members) {
        if (member.user_name) {
          if (!staffMap.has(member.user_name)) {
            staffMap.set(member.user_name, new Set());
          }
          if (cal.calendar_name) {
            staffMap.get(member.user_name)!.add(cal.calendar_name);
          }
        }
      }
    }
    const staff = Array.from(staffMap.entries()).map(([name, servicesSet]) => ({
      name,
      services: Array.from(servicesSet),
    }));

    // Get business hours from the first calendar with schedule data
    let business_hours: Record<string, string> = {
      monday: "Closed",
      tuesday: "Closed",
      wednesday: "Closed",
      thursday: "Closed",
      friday: "Closed",
      saturday: "Closed",
      sunday: "Closed",
    };

    if (syncedCalendars.length > 0) {
      const client = await ghl.requests(resolvedLocationId);
      const firstCalId = syncedCalendars[0].calendar_id;

      try {
        const { openDays, dayInfo } = await getCalendarSchedule(client, firstCalId, tz);
        const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

        for (const [dow, info] of dayInfo) {
          const earliestTime = info.earliest.match(/T(\d{2}:\d{2})/)?.[1] || info.earliest;
          const latestTime = info.latest.match(/T(\d{2}:\d{2})/)?.[1] || info.latest;

          const [oH, oM] = earliestTime.split(":").map(Number);
          const [cH, cM] = latestTime.split(":").map(Number);

          const openStr = formatTimeForSpeech(oH, oM);
          const closeStr = formatTimeForSpeech(cH + 1, cM);

          business_hours[dayNames[dow]] = `${openStr} - ${closeStr}`;
        }
      } catch (err: any) {
        console.error("[LocationInfo] Error getting business hours:", err.message);
      }
    }

    console.log(`[LocationInfo] Returning info for ${resolvedLocationId}: ${services.length} services, ${packagesFormatted.length} packages, ${staff.length} staff`);

    return res.json({
      success: true,
      business_name: info?.business_name || null,  // No hardcoded default - read from GHL
      business_hours,
      services,
      packages: packagesFormatted,
      staff,
      today: todayStr,
      currentTime: currentTimeStr,
      timezone: tz,
    });

  } catch (error: any) {
    console.error("[LocationInfo] Error:", error?.message);
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * POST /api/calendar/service-mappings
 * Manage service-to-staff calendar mappings.
 *
 * List: { locationId, action: "list" }
 * Add:  { locationId, action: "add", service_name, calendar_id, staff_name }
 * Delete: { locationId, action: "delete", id }
 */
router.post("/service-mappings", async (req: Request, res: Response) => {
  try {
    const { locationId, location_id, action, service_name, calendar_id, staff_name, id } = req.body;
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }

    const actionLower = (action || "list").toLowerCase();

    if (actionLower === "list") {
      const mappings = await getServiceMappings(resolvedLocationId);
      return res.json({
        success: true,
        mappings: mappings.map((m) => ({
          id: m.id,
          service_name: m.service_name,
          calendar_id: m.calendar_id,
          staff_name: m.staff_name
        }))
      });
    }

    if (actionLower === "add") {
      if (!service_name || !calendar_id || !staff_name) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: service_name, calendar_id, staff_name"
        });
      }

      await upsertServiceMapping({
        location_id: resolvedLocationId,
        service_name,
        calendar_id,
        staff_name
      });

      return res.json({ success: true, message: "Service mapping added" });
    }

    if (actionLower === "delete") {
      if (!id) {
        return res.status(400).json({ success: false, error: "Missing required field: id" });
      }

      await deleteServiceMappingById(id);
      return res.json({ success: true, message: "Service mapping deleted" });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });

  } catch (error: any) {
    console.error("[Calendar] service-mappings error:", error?.message);
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * POST /api/calendar/check-availability
 * CONSOLIDATED TOOL #2: Check availability for services OR packages.
 *
 * Body:
 *   For services: { locationId, type: "service", service_name, time_preference, requested_date?, staff_name?, start_after? }
 *   For packages: { locationId, type: "package", package_name, time_preference, requested_date? }
 *   Legacy (no type): treats as service with service_type parameter
 *
 * Response includes today, currentTime, timezone so agent knows what day it is.
 */
router.post("/check-availability", async (req: Request, res: Response) => {
  console.log('[Check] Request body:', JSON.stringify(req.body, null, 2));
  try {
    const {
      locationId,
      location_id,
      type,
      service_name,
      service_type,
      package_name,
      staff_name,
      time_preference,
      requested_date,
      requested_time,
      start_after,
      therapist_preference,
      strict_gender  // When true, apply gender filter strictly to ALL services (no fallback)
    } = req.body;
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }

    const installation = await getInstallation(resolvedLocationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    // Use luxon for reliable timezone handling
    const tz = installation.timezone || "America/New_York";
    const timeInfo = getLocalTimeInfo(tz);
    const todayStr = timeInfo.todayStr;
    const currentTimeStr = timeInfo.currentTimeStr;
    const localNow = timeInfo.now.toJSDate(); // For calculations that need Date object
    console.log(`[Check] Timezone: ${tz}, Today: ${todayStr}, CurrentTime: ${currentTimeStr}`);

    // ========== PACKAGE AVAILABILITY ==========
    if (type === "package") {
      if (!package_name) {
        return res.status(400).json({ success: false, error: "Missing required field: package_name" });
      }
      if (!time_preference) {
        return res.status(400).json({ success: false, error: "Missing required field: time_preference" });
      }

      console.log(`[CheckAvailability] Package mode: ${package_name}, preference: ${time_preference}`);

      // Look up the package
      const pkg = await getPackageByName(resolvedLocationId, package_name);
      if (!pkg) {
        const allPackages = await getPackages(resolvedLocationId);
        const suggestion = allPackages.length > 0 ? allPackages[0].package_name : null;

        return res.status(404).json({
          success: false,
          error: "Package not found",
          message: suggestion
            ? `I couldn't find a package called '${package_name}'. Did you mean ${suggestion}?`
            : `I couldn't find a package called '${package_name}'.`,
        });
      }

      // Parse requested_date if provided
      let startDateFilter: string | null = null;
      if (requested_date) {
        const parsed = parseRequestedDate(requested_date, localNow);
        if (parsed) startDateFilter = parsed;
      }

      // Find up to 3 days where all services fit
      // Pass requested_time so package availability respects user's time preference
      const packagePlans = await findPackageDayAvailability(
        resolvedLocationId,
        pkg.services,
        time_preference,
        startDateFilter,
        tz,
        installation,
        localNow,
        3,
        therapist_preference,
        strict_gender === true,  // Pass strict gender mode
        requested_time  // BUG FIX: Pass requested start time
      );

      if (packagePlans.length === 0) {
        const alternativePreference = time_preference === "afternoon" ? "morning" : "afternoon";
        return res.json({
          success: false,
          package_name: pkg.package_name,
          today: todayStr,
          currentTime: currentTimeStr,
          timezone: tz,
          available_dates: [],
          message: `I couldn't find any days with availability for all services in the ${pkg.package_name}. Would you like to try ${alternativePreference} instead of ${time_preference}?`,
        });
      }

      // Format response - IMPORTANT: start_time is when the PACKAGE starts (first service)
      // Don't put staff names at the top level - they apply to individual services
      // SPEC Section 7: Cache each plan with a plan_id for check-vs-book consistency
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const available_dates = packagePlans.map((plan) => {
        const dateObj = new Date(plan.date + "T12:00:00");
        const dayName = dayNames[dateObj.getDay()];

        // First slot is when the package STARTS
        const firstSlot = plan.slots[0];
        const packageStartTime = formatTimeForVoice(new Date(firstSlot.startTime), tz);

        // Generate a plan_id and cache this plan for book_appointment to use
        const planId = generatePlanId();
        cachePlan(planId, {
          locationId: resolvedLocationId,
          packageName: pkg.package_name,
          plan: {
            date: plan.date,
            slots: plan.slots.map((slot) => ({
              service: slot.service,
              startTime: slot.startTime,
              endTime: slot.endTime,
              calendar_id: slot.calendar_id,
              staff_name: slot.staff_name,
              staff_user_id: slot.staff_user_id,
            })),
          },
          createdAt: Date.now(),
        });

        return {
          date: plan.date,
          day_name: dayName,
          plan_id: planId,  // IMPORTANT: Pass this to book_appointment to use the cached plan
          // Package start time - this is what the agent should say: "starting at 9:00 AM"
          start_time: packageStartTime,
          startTime: firstSlot.startTime,  // ISO timestamp for booking
          // Individual service details (for internal use, not for voice)
          services: plan.slots.map((slot) => ({
            service: slot.service,
            start_time: formatTimeForVoice(new Date(slot.startTime), tz),
            end_time: formatTimeForVoice(new Date(slot.endTime), tz),
            startTime: slot.startTime,
            endTime: slot.endTime,
            staff_name: slot.staff_name,
          })),
        };
      });

      console.log(`[CheckAvailability] Package: found ${available_dates.length} available dates with plan_ids`);

      const response = {
        success: true,
        package_name: pkg.package_name,
        total_price: pkg.price,
        total_duration_minutes: pkg.total_duration_minutes,
        today: todayStr,
        currentTime: currentTimeStr,
        timezone: tz,
        available_dates,
      };

      // LOG FULL RESPONSE so we can verify plan_id is included for ElevenLabs
      console.log(`[CheckAvailability] FULL RESPONSE:`, JSON.stringify(response, null, 2));

      return res.json(response);
    }

    // ========== SERVICE AVAILABILITY (default) ==========
    // Support both service_name (new) and service_type (legacy)
    const serviceToCheck = service_name || service_type;

    // Determine which calendars to check (prefer synced data, fall back to manual mappings)
    let calendarsToCheck: Array<{ calendar_id: string; calendar_name: string | null; staff_name: string | null; staff_id: string | null }> = [];

    // If staff_name is provided, get calendars for that specific staff member
    if (staff_name) {
      const staffMembers = await getCalendarsForStaffMember(resolvedLocationId, staff_name);
      if (staffMembers.length === 0) {
        // No matching staff member found - return error
        console.log(`[Calendar] No staff member found matching "${staff_name}"`);
        return res.status(404).json({ success: false, error: "No staff member found with that name" });
      }

      // Get the calendar IDs this staff member is assigned to
      const staffCalendarIds = new Set(staffMembers.map((m) => m.calendar_id));
      console.log(`[Calendar] Staff "${staff_name}" is assigned to ${staffCalendarIds.size} calendar(s)`);

      // If service is also provided, filter to calendars that match both
      if (serviceToCheck) {
        const syncedCals = await getSyncedCalendarsForService(resolvedLocationId, serviceToCheck);
        for (const cal of syncedCals) {
          if (staffCalendarIds.has(cal.calendar_id)) {
            // Find the staff member info for this calendar
            const staffMember = staffMembers.find((m) => m.calendar_id === cal.calendar_id);
            calendarsToCheck.push({
              calendar_id: cal.calendar_id,
              calendar_name: cal.calendar_name,
              staff_name: staffMember?.user_name || null,
              staff_id: staffMember?.user_id || null,
            });
          }
        }
        console.log(`[Calendar] Found ${calendarsToCheck.length} calendars for staff "${staff_name}" + service "${serviceToCheck}"`);
      } else {
        // Staff-only filter: get all calendars for this staff member
        const syncedCals = await getSyncedCalendars(resolvedLocationId);
        for (const cal of syncedCals) {
          if (staffCalendarIds.has(cal.calendar_id)) {
            const staffMember = staffMembers.find((m) => m.calendar_id === cal.calendar_id);
            calendarsToCheck.push({
              calendar_id: cal.calendar_id,
              calendar_name: cal.calendar_name,
              staff_name: staffMember?.user_name || null,
              staff_id: staffMember?.user_id || null,
            });
          }
        }
        console.log(`[Calendar] Found ${calendarsToCheck.length} calendars for staff "${staff_name}"`);
      }
    } else if (serviceToCheck) {
      // Service only - existing logic
      const syncedCals = await getSyncedCalendarsForService(resolvedLocationId, serviceToCheck);
      if (syncedCals.length > 0) {
        // Get team members for each calendar
        for (const cal of syncedCals) {
          const members = await getSyncedTeamMembers(resolvedLocationId, cal.calendar_id);
          const primaryMember = members.find((m) => m.is_primary) || members[0];
          calendarsToCheck.push({
            calendar_id: cal.calendar_id,
            calendar_name: cal.calendar_name,
            staff_name: primaryMember?.user_name || null,
            staff_id: primaryMember?.user_id || null,
          });
        }
        console.log(`[Calendar] Found ${calendarsToCheck.length} synced calendars for service "${serviceToCheck}"`);
      } else {
        // Fall back to manual service mappings
        const mappings = await getCalendarsForService(resolvedLocationId, serviceToCheck);
        if (mappings.length > 0) {
          calendarsToCheck = mappings.map((m) => ({
            calendar_id: m.calendar_id,
            calendar_name: null,
            staff_name: m.staff_name,
            staff_id: null,
          }));
          console.log(`[Calendar] Found ${calendarsToCheck.length} manual mappings for service "${serviceToCheck}"`);
        }
      }
    } else {
      // No service or staff specified - use all synced calendars
      const syncedCals = await getSyncedCalendars(resolvedLocationId);
      if (syncedCals.length > 0) {
        for (const cal of syncedCals) {
          const members = await getSyncedTeamMembers(resolvedLocationId, cal.calendar_id);
          const primaryMember = members.find((m) => m.is_primary) || members[0];
          calendarsToCheck.push({
            calendar_id: cal.calendar_id,
            calendar_name: cal.calendar_name,
            staff_name: primaryMember?.user_name || null,
            staff_id: primaryMember?.user_id || null,
          });
        }
        console.log(`[Calendar] Using all ${calendarsToCheck.length} synced calendars`);
      }
    }

    // Fallback to default calendar if nothing found
    if (calendarsToCheck.length === 0) {
      if (!installation.calendar_id) {
        return res.status(400).json({ success: false, error: "No calendar configured for this location" });
      }
      calendarsToCheck = [{ calendar_id: installation.calendar_id, calendar_name: null, staff_name: null, staff_id: null }];
      console.log(`[Calendar] Falling back to default calendar`);
    }

    // Filter by therapist_preference (gender) if provided
    const genderPreference = therapist_preference?.toLowerCase();
    if (genderPreference === "male" || genderPreference === "female") {
      console.log(`[Calendar] Filtering by therapist_preference: ${genderPreference}`);

      // For each calendar, get only team members with matching gender
      const genderFilteredCalendars: typeof calendarsToCheck = [];

      for (const cal of calendarsToCheck) {
        const genderMembers = await getTeamMembersByGender(resolvedLocationId, cal.calendar_id, genderPreference);
        if (genderMembers.length > 0) {
          // Add each matching team member as a separate entry (so we can pass their userId)
          for (const member of genderMembers) {
            genderFilteredCalendars.push({
              calendar_id: cal.calendar_id,
              calendar_name: cal.calendar_name,
              staff_name: member.user_name,
              staff_id: member.user_id,
            });
          }
        }
      }

      if (genderFilteredCalendars.length === 0) {
        console.log(`[Calendar] No ${genderPreference} therapists found with availability`);
        return res.json({
          success: false,
          error: `No ${genderPreference} therapists available`,
          message: `I couldn't find any ${genderPreference} therapists with availability. Would you like me to check for any available therapist instead?`,
          today: todayStr,
          currentTime: currentTimeStr,
          timezone: tz,
          slots: [],
        });
      }

      calendarsToCheck = genderFilteredCalendars;
      console.log(`[Calendar] Found ${calendarsToCheck.length} ${genderPreference} therapist entries across calendars`);
    }

    // Use tz, localNow, todayStr already defined at top of endpoint
    const tomorrowDate = new Date(localNow);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().split("T")[0];

    // Format today's date for the agent (e.g., "Thursday, February 5th, 2026")
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const dayOfWeek = dayNames[localNow.getDay()];
    const month = monthNames[localNow.getMonth()];
    const dayNum = localNow.getDate();
    const year = localNow.getFullYear();
    const daySuffix = (d: number) => { if (d > 3 && d < 21) return "th"; switch (d % 10) { case 1: return "st"; case 2: return "nd"; case 3: return "rd"; default: return "th"; } };
    const todayFormatted = `${dayOfWeek}, ${month} ${dayNum}${daySuffix(dayNum)}, ${year}`;

    // Format current time (e.g., "2:52 PM")
    const hours = localNow.getHours();
    const minutes = localNow.getMinutes();
    const period = hours >= 12 ? "PM" : "AM";
    const hour12 = hours % 12 || 12;
    const currentTimeFormatted = `${hour12}:${minutes.toString().padStart(2, "0")} ${period}`;

    const BUFFER_MS = 15 * 60 * 1000;
    const nowPlusBuffer = localNow.getTime() + BUFFER_MS;

    // For multi-service booking: parse start_after to get minimum slot time
    // This lets the agent find slots that start after the previous service ends
    let minSlotTimeMs = nowPlusBuffer;
    if (start_after) {
      const startAfterMs = new Date(start_after).getTime();
      if (!isNaN(startAfterMs)) {
        minSlotTimeMs = Math.max(minSlotTimeMs, startAfterMs);
        console.log(`[Calendar] start_after filter: only slots >= ${start_after}`);
      }
    }

    const startMs = Math.max(new Date(todayStr).getTime(), minSlotTimeMs);

    // Slot type with staff info
    type SlotWithStaff = { slot: string; staff_name: string | null; staff_id: string | null; calendar_id: string; calendar_name: string | null };

    // Helper: fetch slots for a given calendar and number of days ahead
    const fetchSlotsForCalendar = async (
      calendarId: string,
      calendarName: string | null,
      staffName: string | null,
      staffId: string | null,
      daysAhead: number
    ): Promise<Record<string, SlotWithStaff[]>> => {
      const endDate = new Date(localNow);
      endDate.setDate(endDate.getDate() + daysAhead);
      const endMs = endDate.getTime();

      // Build URL - include userId if filtering by specific staff member (for gender preference)
      let slotsUrl = `${process.env.GHL_API_DOMAIN}/calendars/${calendarId}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=${encodeURIComponent(tz)}`;
      if (staffId) {
        slotsUrl += `&userId=${encodeURIComponent(staffId)}`;
        console.log(`[Calendar] Fetching slots for specific user: ${staffName} (${staffId})`);
      }
      let resp;
      try {
        resp = await axios.get(slotsUrl, {
          headers: { Authorization: `Bearer ${installation.access_token}`, Version: "2021-07-28" }
        });
      } catch (err: any) {
        if (err?.response?.status === 401) {
          console.log("[Calendar] Token expired, falling back to ghl.requests");
          const client = await ghl.requests(resolvedLocationId);
          resp = await client.get(slotsUrl, { headers: { Version: "2021-07-28" } });
        } else {
          throw err;
        }
      }

      const availabilityByDate: Record<string, SlotWithStaff[]> = {};
      const rawData = resp.data || {};
      for (const dateKey of Object.keys(rawData).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort()) {
        const entry = rawData[dateKey];
        const slots: string[] = Array.isArray(entry) ? entry : (entry?.slots || []);
        // Filter slots: must be >= minSlotTimeMs (accounts for both "now + buffer" AND start_after)
        const futureSlots = slots.filter(slot => {
          const slotMs = new Date(slot).getTime();
          return slotMs >= minSlotTimeMs;
        });
        if (futureSlots.length > 0) {
          availabilityByDate[dateKey] = futureSlots.map(slot => ({
            slot,
            staff_name: staffName,
            staff_id: staffId,
            calendar_id: calendarId,
            calendar_name: calendarName
          }));
        }
      }
      return availabilityByDate;
    };

    // Fetch slots from all calendars and merge
    const fetchAllCalendarsForDays = async (daysAhead: number): Promise<Record<string, SlotWithStaff[]>> => {
      const merged: Record<string, SlotWithStaff[]> = {};

      // Fetch all calendars in parallel
      const results = await Promise.all(
        calendarsToCheck.map(({ calendar_id, calendar_name, staff_name, staff_id }) =>
          fetchSlotsForCalendar(calendar_id, calendar_name, staff_name, staff_id, daysAhead)
        )
      );

      // Merge results
      for (const calendarSlots of results) {
        for (const [dateKey, slots] of Object.entries(calendarSlots)) {
          if (!merged[dateKey]) merged[dateKey] = [];
          merged[dateKey].push(...slots);
        }
      }

      // Sort slots within each day by time
      for (const dateKey of Object.keys(merged)) {
        merged[dateKey].sort((a, b) => a.slot.localeCompare(b.slot));
      }

      return merged;
    };

    // Start with 7 days (fast path)
    let availabilityByDate = await fetchAllCalendarsForDays(7);

    // Debug logging
    const availableDates = Object.keys(availabilityByDate).sort();
    console.log(`[Calendar] CHECK-AVAILABILITY DEBUG:`);
    console.log(`[Calendar]   time_preference: "${time_preference}", requested_date: "${requested_date}"`);
    console.log(`[Calendar]   todayStr: ${todayStr}, available dates: ${availableDates.join(", ")}`);
    console.log(`[Calendar]   today in availability: ${availableDates.includes(todayStr)}`);
    if (availableDates.includes(todayStr)) {
      console.log(`[Calendar]   today's slots: ${availabilityByDate[todayStr].length} total`);
    }

    // Helper: get label
    const getLabel = (dateKey: string): string => {
      if (dateKey === todayStr) return "today";
      if (dateKey === tomorrowStr) return "tomorrow";
      return DAY_NAMES[new Date(dateKey + "T00:00:00").getDay()];
    };

    // Helper: parse natural language date requests into a date filter function
    // Returns a function that takes a dateKey (YYYY-MM-DD) and returns true if it matches
    const parseDateRequest = (input: string): ((dateKey: string) => boolean) | null => {
      const n = input.toLowerCase().trim();

      // Exact ISO date: "2026-02-15"
      if (/^\d{4}-\d{2}-\d{2}$/.test(n)) {
        return (dateKey) => dateKey === n;
      }

      // "today"
      if (n === "today") {
        return (dateKey) => dateKey === todayStr;
      }

      // "tomorrow"
      if (n === "tomorrow") {
        return (dateKey) => dateKey === tomorrowStr;
      }

      // "this weekend" - Saturday and Sunday of current week
      if (n === "this weekend" || n === "weekend") {
        const saturday = new Date(localNow);
        const daysToSat = 6 - localNow.getDay();
        saturday.setDate(saturday.getDate() + daysToSat);
        const satStr = saturday.toISOString().split("T")[0];
        const sunday = new Date(saturday);
        sunday.setDate(sunday.getDate() + 1);
        const sunStr = sunday.toISOString().split("T")[0];
        return (dateKey) => dateKey === satStr || dateKey === sunStr;
      }

      // "next week" - starting from next Monday
      if (n === "next week") {
        const nextMonday = new Date(localNow);
        const daysToMon = (8 - localNow.getDay()) % 7 || 7; // days until next Monday
        nextMonday.setDate(nextMonday.getDate() + daysToMon);
        const nextMondayStr = nextMonday.toISOString().split("T")[0];
        return (dateKey) => dateKey >= nextMondayStr;
      }

      // "next [day]" - e.g., "next Monday", "next Friday"
      const nextDayMatch = n.match(/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
      if (nextDayMatch) {
        const dayName = nextDayMatch[1];
        const targetDayIdx = DAY_NAMES.findIndex(d => d.toLowerCase() === dayName);
        if (targetDayIdx !== -1) {
          let daysAhead = targetDayIdx - localNow.getDay();
          if (daysAhead <= 0) daysAhead += 7;
          // "next Monday" means the Monday of NEXT week, not this week
          if (daysAhead < 7) daysAhead += 7;
          const target = new Date(localNow);
          target.setDate(target.getDate() + daysAhead);
          const targetStr = target.toISOString().split("T")[0];
          return (dateKey) => dateKey === targetStr;
        }
      }

      // Single day name: "Friday", "Monday", etc. - next occurrence
      const dayIdx = DAY_NAMES.findIndex(d => d.toLowerCase() === n);
      if (dayIdx !== -1) {
        let daysAhead = dayIdx - localNow.getDay();
        if (daysAhead <= 0) daysAhead += 7;
        const target = new Date(localNow);
        target.setDate(target.getDate() + daysAhead);
        const targetStr = target.toISOString().split("T")[0];
        return (dateKey) => dateKey === targetStr;
      }

      // Month + day: "February 15th", "Feb 15", "February 15"
      const monthDayMatch = n.match(/^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
      if (monthDayMatch) {
        const monthNames: Record<string, number> = {
          january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
          april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
          august: 7, aug: 7, september: 8, sep: 8, october: 9, oct: 9,
          november: 10, nov: 10, december: 11, dec: 11
        };
        const month = monthNames[monthDayMatch[1]];
        const day = parseInt(monthDayMatch[2]);
        // Assume current year, or next year if date has passed
        let targetYear = year;
        const targetDate = new Date(targetYear, month, day);
        if (targetDate < localNow) {
          targetYear++;
        }
        const targetStr = `${targetYear}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        return (dateKey) => dateKey === targetStr;
      }

      // Couldn't parse - return null (no filter)
      return null;
    };

    // Parse date filter if requested_date is provided
    // BUG FIX: Use chrono-node (parseRequestedDate) for consistent date parsing
    // The internal parseDateRequest doesn't handle formats like "Monday the 16th"
    let dateFilter: ((dateKey: string) => boolean) | null = null;
    if (requested_date) {
      const parsedDate = parseRequestedDate(requested_date, localNow);
      if (parsedDate) {
        console.log(`[Calendar] Parsed requested_date "${requested_date}" to "${parsedDate}" using chrono-node`);
        dateFilter = (dateKey) => dateKey === parsedDate;
      } else {
        // Fall back to internal parser for formats chrono-node doesn't handle well
        console.log(`[Calendar] chrono-node couldn't parse "${requested_date}", trying internal parser`);
        dateFilter = parseDateRequest(requested_date);
      }
    }

    // Determine time filter function
    let timeFilterFn: ((slot: string) => boolean) | null = null;
    if (time_preference) {
      const pref = time_preference.toLowerCase();
      timeFilterFn = pref === "morning" ? isSlotMorning : isSlotAfternoon;
    }

    // Target time for sorting (if requested_time is provided)
    const targetMins = requested_time ? parseTimeToMinutes(requested_time, tz) : null;

    // How many slots to return: 5 if specific time requested, otherwise 3
    const maxSlots = targetMins !== null ? 5 : 3;

    // Result slot type
    type ResultSlot = {
      date: string;
      time: string;
      label: string;
      startTime: string;
      staff_name?: string;
      staff_id?: string;
      calendar_id?: string;
      calendar_name?: string;
    };

    // Helper: collect slots from availability map
    const collectSlots = (availability: Record<string, SlotWithStaff[]>): ResultSlot[] => {
      let filteredDates = Object.keys(availability).sort();

      if (dateFilter) {
        filteredDates = filteredDates.filter(dateFilter);
      }

      // If specific time requested, collect slots NEAR that time only
      // BUG FIX: Don't return 8 AM when user asked for 10 AM - max 60 min difference
      if (targetMins !== null) {
        const MAX_TIME_DIFF_MINS = 60;  // Only return slots within 1 hour of requested time
        const allSlots: Array<{ date: string; slotInfo: SlotWithStaff; diff: number }> = [];

        for (const dateKey of filteredDates) {
          let slots = availability[dateKey];

          // Apply time preference filter (morning/afternoon)
          if (timeFilterFn) {
            slots = slots.filter((s) => timeFilterFn!(s.slot));
          }

          for (const slotInfo of slots) {
            const slotMins = getSlotMinutes(slotInfo.slot);
            const diff = Math.abs(slotMins - targetMins);

            // BUG FIX: Only include slots within acceptable range of requested time
            if (diff <= MAX_TIME_DIFF_MINS) {
              allSlots.push({ date: dateKey, slotInfo, diff });
            }
          }
        }

        // Sort by proximity to requested time
        allSlots.sort((a, b) => a.diff - b.diff);

        // If no slots within range, log it
        if (allSlots.length === 0) {
          console.log(`[Calendar] No slots found within ${MAX_TIME_DIFF_MINS} minutes of requested time ${requested_time}`);
        }

        // Return top slots
        return allSlots.slice(0, maxSlots).map(({ date, slotInfo }) => ({
          date,
          time: formatSlotTime(slotInfo.slot),
          label: getLabel(date),
          startTime: slotInfo.slot,
          ...(slotInfo.staff_name && { staff_name: slotInfo.staff_name }),
          ...(slotInfo.staff_id && { staff_id: slotInfo.staff_id }),
          ...(slotInfo.calendar_id && { calendar_id: slotInfo.calendar_id }),
          ...(slotInfo.calendar_name && { calendar_name: slotInfo.calendar_name })
        }));
      }

      // Default behavior: 1 slot per day, up to maxSlots days
      const results: ResultSlot[] = [];
      let daysFound = 0;

      for (const dateKey of filteredDates) {
        if (daysFound >= maxSlots) break;

        let slots = availability[dateKey];

        // Apply time preference filter (morning/afternoon)
        if (timeFilterFn) {
          slots = slots.filter((s) => timeFilterFn!(s.slot));
        }

        if (slots.length === 0) continue;

        // Pick first available slot
        const firstSlot = slots[0];
        results.push({
          date: dateKey,
          time: formatSlotTime(firstSlot.slot),
          label: getLabel(dateKey),
          startTime: firstSlot.slot,
          ...(firstSlot.staff_name && { staff_name: firstSlot.staff_name }),
          ...(firstSlot.staff_id && { staff_id: firstSlot.staff_id }),
          ...(firstSlot.calendar_id && { calendar_id: firstSlot.calendar_id }),
          ...(firstSlot.calendar_name && { calendar_name: firstSlot.calendar_name })
        });
        daysFound++;
      }
      return results;
    };

    // Auto-extension: try 7 days, then 14, then 30 if no slots found
    let resultSlots = collectSlots(availabilityByDate);

    if (resultSlots.length === 0) {
      console.log("[Calendar] No slots in 7 days, extending to 14 days...");
      availabilityByDate = await fetchAllCalendarsForDays(14);
      resultSlots = collectSlots(availabilityByDate);
    }

    if (resultSlots.length === 0) {
      console.log("[Calendar] No slots in 14 days, extending to 30 days...");
      availabilityByDate = await fetchAllCalendarsForDays(30);
      resultSlots = collectSlots(availabilityByDate);
    }

    console.log(`[Calendar] Returning ${resultSlots.length} slots: ${resultSlots.map(s => `${s.label} ${s.time}`).join(", ")}`);
    return res.json({
      success: true,
      service: serviceToCheck || null,
      today: todayFormatted,
      currentTime: currentTimeFormatted,
      timezone: tz,
      slots: resultSlots
    });

  } catch (error: any) {
    console.error("[Calendar] check-availability error:", error?.response?.data || error.message);
    return res.status(500).json({ success: false, error: error?.response?.data?.message || error.message });
  }
});

/**
 * POST /api/calendar/book
 * Consolidated booking endpoint for both services and packages.
 *
 * For type=service (or no type):
 *   - locationId, service_name, selected_date, selected_time, customer_name, email, phone
 * For type=package:
 *   - locationId, package_name, selected_date, time_preference, customer_name, email, phone
 *
 * Accepts both camelCase and snake_case field names.
 */
router.post("/book", async (req: Request, res: Response) => {
  console.log('[Book] Request body:', JSON.stringify(req.body, null, 2));
  try {
    const body = req.body;

    // Accept both camelCase and snake_case (camelCase takes priority)
    const locationId = body.locationId || body.location_id;
    const type = body.type || "service"; // default to service
    const customerName = body.customerName || body.customer_name;
    const customerEmail = body.customerEmail || body.customer_email || body.email;
    const customerPhone = body.customerPhone || body.customer_phone || body.phone;
    const therapistPreference = body.therapistPreference || body.therapist_preference;
    const strictGender = body.strictGender || body.strict_gender;  // When true, no gender fallback
    const notes = body.notes;

    // ========== PACKAGE BOOKING ==========
    if (type === "package") {
      const packageName = body.package_name;
      const selectedDate = body.selected_date;
      const timePreference = body.time_preference;
      const requestedTime = body.requested_time || body.requestedTime || body.start_time || body.startTime;
      const providedSlots = body.slots;  // Legacy: Accept slots directly from check_availability
      const planId = body.plan_id;  // SPEC Section 7: Use cached plan for check-vs-book consistency

      console.log(`[Book] ===== PACKAGE BOOKING START =====`);
      console.log(`[Book] Request body:`, JSON.stringify(body, null, 2));
      console.log(`[Book] Plan ID: ${planId || "(none)"}`);
      console.log(`[Book] Requested start time: ${requestedTime || "(none - will use cached plan)"}`);


      if (!locationId) {
        console.log(`[Book] VALIDATION FAILED: Missing locationId`);
        return res.status(400).json({ success: false, error: "Missing required field: locationId" });
      }
      if (!packageName) {
        console.log(`[Book] VALIDATION FAILED: Missing package_name`);
        return res.status(400).json({ success: false, error: "Missing required field: package_name" });
      }
      if (!customerName || !customerPhone || !customerEmail) {
        console.log(`[Book] VALIDATION FAILED: Missing customer info - name: ${!!customerName}, phone: ${!!customerPhone}, email: ${!!customerEmail}`);
        return res.status(400).json({ success: false, error: "Missing required fields: customer_name, phone, email" });
      }

      console.log(`[Book] PACKAGE mode: ${packageName} for ${customerName}`);
      console.log(`[Book] Customer: ${customerName}, Email: ${customerEmail}, Phone: ${customerPhone}`);
      console.log(`[Book] Selected date: ${selectedDate}, Time preference: ${timePreference}`);
      console.log(`[Book] Provided slots: ${providedSlots ? JSON.stringify(providedSlots) : "(none)"}`);

      // STEP 1: Look up the package
      console.log(`[Book] STEP 1: Looking up package "${packageName}"...`);
      let pkg;
      try {
        pkg = await getPackageByName(locationId, packageName);
        if (pkg) {
          console.log(`[Book] STEP 1 SUCCESS: Package found - "${pkg.package_name}" with ${pkg.services?.length || 0} services: ${pkg.services?.join(", ") || "none"}`);
        } else {
          console.log(`[Book] STEP 1 FAILED: Package "${packageName}" NOT FOUND`);
        }
      } catch (pkgErr: any) {
        console.error(`[Book] STEP 1 FATAL ERROR: Package lookup threw exception`);
        console.error(`[Book] Error message:`, pkgErr.message);
        console.error(`[Book] Stack trace:`, pkgErr.stack);
        return res.status(500).json({ success: false, error: "Package lookup failed: " + pkgErr.message });
      }

      if (!pkg) {
        let allPackages: any[] = [];
        try {
          allPackages = await getPackages(locationId);
          console.log(`[Book] Available packages for location:`, allPackages.map(p => p.package_name).join(", ") || "none");
        } catch (e: any) {
          console.error(`[Book] Failed to list packages:`, e.message);
        }
        const suggestion = allPackages.length > 0 ? allPackages[0].package_name : null;
        return res.status(404).json({
          success: false,
          error: "Package not found",
          message: suggestion
            ? `I couldn't find a package called '${packageName}'. Did you mean ${suggestion}?`
            : `I couldn't find a package called '${packageName}'.`,
        });
      }

      // STEP 2: Get installation for timezone and auth
      console.log(`[Book] STEP 2: Getting installation for location ${locationId}...`);
      let installation;
      try {
        installation = await getInstallation(locationId);
        if (installation) {
          console.log(`[Book] STEP 2 SUCCESS: Installation found - timezone: ${installation.timezone}, calendar: ${installation.calendar_id}`);
        } else {
          console.log(`[Book] STEP 2 FAILED: Installation not found for location ${locationId}`);
          return res.status(404).json({ success: false, error: "Installation not found" });
        }
      } catch (instErr: any) {
        console.error(`[Book] STEP 2 FATAL ERROR: Installation lookup threw exception`);
        console.error(`[Book] Error message:`, instErr.message);
        console.error(`[Book] Stack trace:`, instErr.stack);
        return res.status(500).json({ success: false, error: "Installation lookup failed: " + instErr.message });
      }

      const tz = installation.timezone || "America/New_York";
      console.log(`[Book] STEP 3: Getting authenticated GHL client...`);
      let client;
      try {
        client = await ghl.requests(locationId);
        console.log(`[Book] STEP 3 SUCCESS: GHL client obtained`);
      } catch (clientErr: any) {
        console.error(`[Book] STEP 3 FATAL ERROR: Failed to get GHL client`);
        console.error(`[Book] Error message:`, clientErr.message);
        console.error(`[Book] Stack trace:`, clientErr.stack);
        return res.status(500).json({ success: false, error: "Failed to authenticate with GHL: " + clientErr.message });
      }
      const localNow = DateTime.now().setZone(tz).toJSDate();

      let packagePlan: {
        date: string;
        slots: Array<{
          service: string;
          startTime: string;
          endTime: string;
          calendar_id: string;
          staff_name: string | null;
          staff_user_id: string | null;
        }>;
      } | null = null;

      // SPEC Section 7: Check-vs-Book Consistency
      // Priority: 1) plan_id (cached plan), 2) providedSlots (legacy), 3) recalculate (fallback)
      console.log(`[Book] STEP 4: Processing slots...`);

      // PRIORITY 1: Use cached plan from check_availability via plan_id
      // Treat empty string as falsy (ElevenLabs sometimes sends "" instead of null)
      if (planId && planId.trim() !== "") {
        console.log(`[Book] STEP 4A: Looking up cached plan with ID: ${planId}`);
        const cached = getCachedPlan(planId);

        if (cached) {
          // Verify this plan belongs to the correct location and package
          if (cached.locationId !== locationId) {
            console.log(`[Book] CACHE MISMATCH: Plan location ${cached.locationId} !== request location ${locationId}`);
            return res.status(400).json({ success: false, error: "Plan ID belongs to a different location" });
          }
          if (cached.packageName.toLowerCase() !== packageName.toLowerCase()) {
            console.log(`[Book] CACHE MISMATCH: Plan package "${cached.packageName}" !== request package "${packageName}"`);
            return res.status(400).json({ success: false, error: "Plan ID belongs to a different package" });
          }

          // Use the cached plan directly - it already has all the slot details
          packagePlan = cached.plan;
          console.log(`[Book] STEP 4 SUCCESS: Using cached plan from check_availability`);
          console.log(`[Book] Package date: ${packagePlan.date}`);
          packagePlan.slots.forEach((s, idx) => {
            console.log(`[Book]   ${idx + 1}. ${s.service}: ${s.startTime} -> ${s.endTime} (staff: ${s.staff_name || "any"}, userId: ${s.staff_user_id || "none"}, calendar: ${s.calendar_id})`);
          });
        } else {
          console.log(`[Book] CACHE MISS: Plan ${planId} not found or expired`);
          // Fall through to recalculate
        }
      }

      // PRIORITY 2: Use providedSlots from legacy request format
      if (!packagePlan && providedSlots && Array.isArray(providedSlots) && providedSlots.length > 0) {
        console.log(`[Book] STEP 4B: Using ${providedSlots.length} pre-confirmed slots from request body`);
        console.log(`[Book] Provided slots:`, JSON.stringify(providedSlots, null, 2));

        // Map provided slots to the expected format
        const mappedSlots: Array<{
          service: string;
          startTime: string;
          endTime: string;
          calendar_id: string;
          staff_name: string | null;
          staff_user_id: string | null;
        }> = [];

        for (let slotIdx = 0; slotIdx < providedSlots.length; slotIdx++) {
          const slot = providedSlots[slotIdx];
          console.log(`[Book] Mapping slot ${slotIdx + 1}/${providedSlots.length}: service="${slot.service}"`);

          // Get calendar_id for this service
          try {
            const syncedCals = await getSyncedCalendarsForService(locationId, slot.service);
            console.log(`[Book]   Found ${syncedCals.length} calendars for service "${slot.service}"`);
            const calendarId = syncedCals[0]?.calendar_id || installation.calendar_id;

            if (!calendarId) {
              console.error(`[Book]   SKIPPING: No calendar found for service: ${slot.service}`);
              continue;
            }
            console.log(`[Book]   Using calendar: ${calendarId}`);

            // Get staff user_id if staff_name is provided
            let staffUserId: string | null = null;
            if (slot.staff_name) {
              console.log(`[Book]   Looking up staff "${slot.staff_name}"...`);
              const members = await getSyncedTeamMembers(locationId, calendarId);
              console.log(`[Book]   Found ${members.length} team members on calendar`);
              const matchingMember = members.find(m =>
                m.user_name?.toLowerCase() === slot.staff_name?.toLowerCase()
              );
              staffUserId = matchingMember?.user_id || null;
              console.log(`[Book]   Staff lookup result: ${staffUserId ? `found userId ${staffUserId}` : "NOT FOUND"}`);
            }

            mappedSlots.push({
              service: slot.service as string,
              startTime: slot.startTime as string,
              endTime: slot.endTime as string,
              calendar_id: calendarId,
              staff_name: slot.staff_name || null,
              staff_user_id: staffUserId,
            });
            console.log(`[Book]   Slot ${slotIdx + 1} mapped successfully`);
          } catch (mapErr: any) {
            console.error(`[Book]   FATAL ERROR mapping slot ${slotIdx + 1}:`, mapErr.message);
            console.error(`[Book]   Stack:`, mapErr.stack);
          }
        }

        if (mappedSlots.length === 0) {
          console.error(`[Book] STEP 4 FAILED: No slots could be mapped!`);
          return res.status(500).json({ success: false, error: "Failed to map any slots for booking" });
        }

        // Extract date from first slot
        const firstSlotDate = new Date(mappedSlots[0].startTime).toISOString().split("T")[0];

        packagePlan = {
          date: firstSlotDate,
          slots: mappedSlots,
        };

        console.log(`[Book] STEP 4 SUCCESS: Mapped ${mappedSlots.length} slots for date ${firstSlotDate}:`);
        mappedSlots.forEach((s, idx) => {
          console.log(`[Book]   ${idx + 1}. ${s.service}: ${s.startTime} -> ${s.endTime} (staff: ${s.staff_name || "any"}, userId: ${s.staff_user_id || "none"}, calendar: ${s.calendar_id})`);
        });
      }

      // PRIORITY 3: Fall back to recalculating if no cached plan or slots provided
      if (!packagePlan) {
        if (!selectedDate) {
          return res.status(400).json({ success: false, error: "Missing required field: selected_date (or provide slots array)" });
        }
        if (!timePreference) {
          return res.status(400).json({ success: false, error: "Missing required field: time_preference (or provide slots array)" });
        }

        console.log(`[Book] No pre-confirmed slots, recalculating for ${selectedDate} ${timePreference} ${requestedTime ? `starting at ${requestedTime}` : ""}`);

        // Parse selected_date
        const parsedDate = parseRequestedDate(selectedDate, localNow);
        if (!parsedDate) {
          return res.status(400).json({ success: false, error: "Invalid selected_date format" });
        }

        // Find availability on the selected date
        // BUG FIX: Pass requestedTime so package starts at user's requested time, not earliest available
        const packagePlans = await findPackageDayAvailability(
          locationId,
          pkg.services,
          timePreference,
          parsedDate,
          tz,
          installation,
          localNow,
          1,
          therapistPreference,
          strictGender === true,
          requestedTime  // BUG FIX: Use user's requested start time
        );

        packagePlan = packagePlans[0] || null;

        if (!packagePlan || packagePlan.date !== parsedDate) {
          const alternativePreference = timePreference === "afternoon" ? "morning" : "afternoon";
          return res.json({
            success: false,
            package_name: pkg.package_name,
            appointments: [],
            message: `I couldn't find availability for all services in the ${pkg.package_name} on ${parsedDate}. Would you like to try ${alternativePreference} instead of ${timePreference}?`,
          });
        }
      }

      if (!packagePlan) {
        return res.json({
          success: false,
          package_name: pkg.package_name,
          appointments: [],
          message: `Could not determine slots for booking.`,
        });
      }

      // RE-VALIDATION: Per booking spec Section 7, we must re-check that slots are still available
      // Time passes during voice calls (30+ seconds). Someone else could have booked these slots.
      // Use the SAME GHL free-slots API to verify each slot is still free.
      console.log(`[Book] ===== STEP 5: RE-VALIDATION START =====`);
      console.log(`[Book] Re-validating ${packagePlan.slots.length} slots before booking...`);
      console.log(`[Book] Package plan date: ${packagePlan.date}`);
      console.log(`[Book] Package plan slots:`, JSON.stringify(packagePlan.slots, null, 2));

      for (let revalIdx = 0; revalIdx < packagePlan.slots.length; revalIdx++) {
        const slot = packagePlan.slots[revalIdx];
        console.log(`[Book] Re-validation ${revalIdx + 1}/${packagePlan.slots.length}: ${slot.service}`);

        const slotDate = new Date(slot.startTime);
        const slotDateStr = slotDate.toISOString().split("T")[0];

        // Call GHL free-slots for this specific calendar + staff + date
        const startMs = new Date(slotDateStr + "T00:00:00").getTime();
        const endMs = new Date(slotDateStr + "T23:59:59").getTime();

        let slotsUrl = `${process.env.GHL_API_DOMAIN}/calendars/${slot.calendar_id}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=${encodeURIComponent(tz)}`;
        if (slot.staff_user_id) {
          slotsUrl += `&userId=${encodeURIComponent(slot.staff_user_id)}`;
        }

        console.log(`[Book]   API URL: ${slotsUrl}`);

        try {
          const resp = await axios.get(slotsUrl, {
            headers: {
              Authorization: `Bearer ${installation.access_token}`,
              Version: "2021-07-28",
            },
          });

          console.log(`[Book]   API response status: ${resp.status}`);
          const rawData = resp.data || {};
          const dateEntry = rawData[slotDateStr];
          const availableSlots: string[] = Array.isArray(dateEntry) ? dateEntry : dateEntry?.slots || [];

          console.log(`[Book]   Found ${availableSlots.length} available slots for ${slotDateStr}`);
          if (availableSlots.length > 0) {
            console.log(`[Book]   First 5 slots: ${availableSlots.slice(0, 5).join(", ")}`);
          }

          // Check if our slot time is still in the available slots
          // Use a 2-minute tolerance to handle timezone/rounding differences
          const TOLERANCE_MS = 2 * 60 * 1000; // 2 minutes
          const targetMs = slotDate.getTime();

          // Also check if the slot is in the past (for same-day bookings)
          const nowMs = Date.now();
          const isSlotInPast = targetMs < nowMs;

          console.log(`[Book]   Target time: ${slot.startTime} (${targetMs}ms)`);
          console.log(`[Book]   Current time: ${new Date().toISOString()} (${nowMs}ms)`);
          console.log(`[Book]   Is slot in past: ${isSlotInPast}`);

          if (isSlotInPast) {
            console.log(`[Book] RE-VALIDATION FAILED: ${slot.service} at ${slot.startTime} is in the past`);
            return res.json({
              success: false,
              package_name: pkg.package_name,
              appointments: [],
              message: `The ${slot.service} slot at ${slot.startTime} is no longer available because the time has passed. Let me find new options for you.`,
            });
          }

          const slotStillAvailable = availableSlots.some(availSlot => {
            const availMs = new Date(availSlot).getTime();
            const diff = Math.abs(availMs - targetMs);
            if (diff <= TOLERANCE_MS) {
              console.log(`[Book]     Matched: ${availSlot} (diff: ${diff}ms)`);
              return true;
            }
            return false;
          });

          console.log(`[Book]   Slot still available: ${slotStillAvailable}`);

          // Log closest match if not found
          if (!slotStillAvailable && availableSlots.length > 0) {
            let closestDiff = Infinity;
            let closestSlot = "";
            availableSlots.forEach(availSlot => {
              const availMs = new Date(availSlot).getTime();
              const diff = Math.abs(availMs - targetMs);
              if (diff < closestDiff) {
                closestDiff = diff;
                closestSlot = availSlot;
              }
            });
            console.log(`[Book]   Closest available slot: ${closestSlot} (diff: ${closestDiff}ms = ${Math.round(closestDiff / 60000)} minutes)`);
          }

          if (!slotStillAvailable) {
            console.log(`[Book] RE-VALIDATION FAILED: ${slot.service} at ${slot.startTime} is no longer available`);
            return res.json({
              success: false,
              package_name: pkg.package_name,
              appointments: [],
              message: `Availability has changed — the ${slot.service} slot at ${slot.startTime} was just booked by someone else. Let me find new options for you.`,
            });
          }

          console.log(`[Book]   PASS: ${slot.service} at ${slot.startTime} still available`);
        } catch (err: any) {
          console.error(`[Book]   Re-validation API ERROR for ${slot.service}:`);
          console.error(`[Book]   Error message:`, err.message);
          console.error(`[Book]   Response status:`, err?.response?.status);
          console.error(`[Book]   Response data:`, JSON.stringify(err?.response?.data));
          // If we can't verify, proceed cautiously - the booking will fail if truly unavailable
        }
      }

      console.log(`[Book] STEP 5 SUCCESS: All ${packagePlan.slots.length} slots re-validated. Proceeding with booking.`);

      // STEP 6: Book all services
      console.log(`[Book] ===== STEP 6: BOOKING SERVICES =====`);
      const appointments: Array<{
        service: string;
        date?: string;
        start_time?: string;
        end_time?: string;
        staff_name?: string;
        calendar_id?: string;
        appointment_id?: string;
        status: "confirmed" | "failed";
        error?: string;
      }> = [];

      let allSuccessful = true;

      console.log(`[Book] Booking ${packagePlan.slots.length} services...`);
      packagePlan.slots.forEach((s, idx) => {
        console.log(`[Book]   ${idx + 1}. ${s.service}: ${s.startTime} -> ${s.endTime} (staff: ${s.staff_name || "any"}, userId: ${s.staff_user_id || "none"})`);
      });

      for (let i = 0; i < packagePlan.slots.length; i++) {
        const slotInfo = packagePlan.slots[i];
        console.log(`[Book] ===== Booking service ${i + 1}/${packagePlan.slots.length}: ${slotInfo.service} =====`);
        console.log(`[Book]   Calendar: ${slotInfo.calendar_id}`);
        console.log(`[Book]   Start time: ${slotInfo.startTime}`);
        console.log(`[Book]   Staff: ${slotInfo.staff_name || "any"} (userId: ${slotInfo.staff_user_id || "none"})`);
        console.log(`[Book]   Customer: ${customerName}, ${customerEmail}, ${customerPhone}`);

        try {
          console.log(`[Book]   Calling bookServiceAppointment...`);
          const bookingResult = await bookServiceAppointment(
            client,
            locationId,
            slotInfo.calendar_id,
            slotInfo.startTime,
            slotInfo.service,
            customerName,
            customerEmail,
            customerPhone,
            notes,
            therapistPreference,
            slotInfo.staff_user_id || undefined  // BUG FIX: Assign to specific staff
          );

          console.log(`[Book]   bookServiceAppointment result:`, JSON.stringify(bookingResult));

          if (!bookingResult.success) {
            console.log(`[Book]   FAILED: ${bookingResult.error}`);
            appointments.push({ service: slotInfo.service, status: "failed", error: bookingResult.error });
            allSuccessful = false;
            continue;
          }

          console.log(`[Book]   SUCCESS: appointmentId=${bookingResult.appointmentId}, endTime=${bookingResult.endTime}`);
          const startDate = new Date(slotInfo.startTime);
          const endDate = new Date(bookingResult.endTime!);
          appointments.push({
            service: slotInfo.service,
            date: packagePlan.date,
            start_time: formatTimeForVoice(startDate, tz),
            end_time: formatTimeForVoice(endDate, tz),
            staff_name: slotInfo.staff_name || undefined,
            calendar_id: slotInfo.calendar_id,
            appointment_id: bookingResult.appointmentId,
            status: "confirmed",
          });
        } catch (err: any) {
          console.error(`[Book]   FATAL ERROR booking ${slotInfo.service}:`);
          console.error(`[Book]   Error message:`, err.message);
          console.error(`[Book]   Stack trace:`, err.stack);
          appointments.push({ service: slotInfo.service, status: "failed", error: err.message });
          allSuccessful = false;
        }
      }

      const confirmedAppointments = appointments.filter((a) => a.status === "confirmed");
      const failedAppointments = appointments.filter((a) => a.status === "failed");

      console.log(`[Book] Booking complete: ${confirmedAppointments.length} confirmed, ${failedAppointments.length} failed`);
      if (failedAppointments.length > 0) {
        console.log(`[Book] Failed services:`, failedAppointments.map(a => `${a.service}: ${a.error}`).join(", "));
      }

      if (confirmedAppointments.length === 0) {
        console.log(`[Book] ALL BOOKINGS FAILED - returning error response`);
        return res.json({
          success: false,
          package_name: pkg.package_name,
          appointments,
          message: `I found availability but the bookings failed. Would you like to try again?`,
        });
      }

      if (!allSuccessful) {
        const bookedServices = confirmedAppointments.map((a) => a.service).join(", ");
        const failedService = appointments.find((a) => a.status === "failed")?.service;
        console.log(`[Book] PARTIAL SUCCESS - ${bookedServices} booked, ${failedService} failed`);
        return res.json({
          success: false,
          partial: true,
          package_name: pkg.package_name,
          total_price: pkg.price,
          appointments,
          message: `I was able to book ${bookedServices}, but ${failedService} failed to book. Would you like me to try again?`,
        });
      }

      // Full success
      const confirmationMessage = buildPackageConfirmation(pkg.package_name, confirmedAppointments, pkg.price, tz);
      console.log(`[Book] ===== PACKAGE BOOKING SUCCESS =====`);
      console.log(`[Book] Package: ${pkg.package_name}`);
      console.log(`[Book] Services booked: ${confirmedAppointments.length}`);
      confirmedAppointments.forEach((a, idx) => {
        console.log(`[Book]   ${idx + 1}. ${a.service}: ${a.start_time} - ${a.end_time} (apptId: ${a.appointment_id})`);
      });

      return res.json({
        success: true,
        package_name: pkg.package_name,
        total_price: pkg.price,
        total_duration_minutes: pkg.total_duration_minutes,
        appointments: confirmedAppointments,
        confirmation_message: confirmationMessage,
      });
    }

    // ========== SERVICE BOOKING (default) ==========
    console.log(`[Book] ===== SINGLE SERVICE BOOKING START =====`);
    console.log(`[Book] Request body:`, JSON.stringify(body, null, 2));

    const calendarId = body.calendarId || body.calendar_id;
    const startTime = body.startTime || body.start_time || body.selected_time;
    const selectedDate = body.selected_date;
    const requestedTime = body.requested_time || body.requestedTime;  // BUG FIX: Accept requested_time
    const serviceName = body.service_name || body.serviceType || body.service_type;
    const occasion = body.occasion;
    const title = body.title;

    console.log(`[Book] Single service mode: ${serviceName || "(no service specified)"}`);
    console.log(`[Book] Customer: ${customerName}, Email: ${customerEmail}, Phone: ${customerPhone}`);
    console.log(`[Book] Time inputs - startTime: "${startTime}", selectedDate: "${selectedDate}", requestedTime: "${requestedTime}"`);

    if (!locationId || !customerName || !customerEmail) {
      console.log(`[Book] VALIDATION FAILED: locationId=${!!locationId}, customerName=${!!customerName}, customerEmail=${!!customerEmail}`);
      return res.status(400).json({
        success: false,
        error: "Missing required fields: locationId, customerName, customerEmail",
      });
    }

    // STEP 1: Look up installation first (needed for timezone)
    console.log(`[Book] STEP 1: Getting installation for location ${locationId}...`);
    let installation;
    try {
      installation = await getInstallation(locationId);
      if (installation) {
        console.log(`[Book] STEP 1 SUCCESS: Installation found - timezone: ${installation.timezone}, calendar: ${installation.calendar_id}`);
      } else {
        console.log(`[Book] STEP 1 FAILED: Installation not found`);
        return res.status(404).json({ success: false, error: "Installation not found" });
      }
    } catch (instErr: any) {
      console.error(`[Book] STEP 1 FATAL ERROR:`, instErr.message);
      console.error(`[Book] Stack:`, instErr.stack);
      return res.status(500).json({ success: false, error: "Installation lookup failed: " + instErr.message });
    }

    const tz = installation.timezone || "America/New_York";

    // Helper to build ISO datetime from date + time
    const buildISODateTime = (date: string, time: string): string | null => {
      const timeParsed = parseTimeToMinutes(time, tz);
      if (timeParsed === null) return null;

      const hours = Math.floor(timeParsed / 60);
      const mins = timeParsed % 60;
      const dateTimeStr = `${date}T${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:00`;

      // Get timezone offset using Intl API
      const tempDate = new Date();
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "longOffset"
      });
      const parts = formatter.formatToParts(tempDate);
      const offsetPart = parts.find(p => p.type === "timeZoneName");
      const offsetMatch = offsetPart?.value?.match(/GMT([+-]\d{2}:\d{2})/);
      const tzOffset = offsetMatch ? offsetMatch[1] : "-10:00";

      return `${dateTimeStr}${tzOffset}`;
    };

    // STEP 2: Resolve startTime - prefer full ISO datetime from slot, otherwise build from date+time
    console.log(`[Book] STEP 2: Resolving start time...`);
    let resolvedStartTime: string | null = null;

    // Option 1: startTime already contains full ISO datetime (from check-availability slot)
    if (startTime && startTime.includes("T")) {
      resolvedStartTime = startTime;
      console.log(`[Book] STEP 2 SUCCESS: Using provided ISO startTime: ${resolvedStartTime}`);
    }
    // Option 2: Build from selected_date + startTime (time portion)
    else if (selectedDate && startTime) {
      resolvedStartTime = buildISODateTime(selectedDate, startTime);
      if (resolvedStartTime) {
        console.log(`[Book] STEP 2 SUCCESS: Built datetime from selected_date + startTime: ${resolvedStartTime}`);
      }
    }
    // Option 3: BUG FIX - Build from selected_date + requested_time (e.g., "10:00 AM")
    else if (selectedDate && requestedTime) {
      resolvedStartTime = buildISODateTime(selectedDate, requestedTime);
      if (resolvedStartTime) {
        console.log(`[Book] STEP 2 SUCCESS: Built datetime from selected_date + requested_time: ${resolvedStartTime}`);
      } else {
        console.log(`[Book] STEP 2 FAILED: Could not parse requested_time "${requestedTime}"`);
      }
    }

    if (!resolvedStartTime) {
      console.log(`[Book] STEP 2 FAILED: No valid start time could be resolved`);
      console.log(`[Book] Hint: Provide startTime (ISO), or selected_date + startTime, or selected_date + requested_time`);
      return res.status(400).json({
        success: false,
        error: "Missing required field: startTime (or selected_date + requested_time like '10:00 AM')",
      });
    }

    // STEP 3: Resolve calendar_id
    console.log(`[Book] STEP 3: Finding calendar for service...`);
    let resolvedCalendarId = calendarId;
    let slotDuration = 60;
    let slotBuffer = 0;

    if (!resolvedCalendarId && serviceName) {
      try {
        const syncedCals = await getSyncedCalendarsForService(locationId, serviceName);
        console.log(`[Book] Found ${syncedCals.length} calendars for service "${serviceName}"`);
        if (syncedCals.length > 0) {
          resolvedCalendarId = syncedCals[0].calendar_id;
          slotDuration = syncedCals[0].slot_duration || 60;
          slotBuffer = syncedCals[0].slot_buffer || 0;
          console.log(`[Book] STEP 3 SUCCESS: Calendar found: ${resolvedCalendarId} (duration: ${slotDuration}min, buffer: ${slotBuffer}min)`);
        }
      } catch (calErr: any) {
        console.error(`[Book] Calendar lookup error:`, calErr.message);
      }
    }

    // Fallback to installation default if no service match
    if (!resolvedCalendarId) {
      resolvedCalendarId = installation.calendar_id;
      console.log(`[Book] Using default calendar: ${resolvedCalendarId}`);
    }

    if (!resolvedCalendarId) {
      console.log(`[Book] STEP 3 FAILED: No calendar configured for this location`);
      return res.status(400).json({ success: false, error: "No calendar configured for this location" });
    }

    // Get calendar settings if not already loaded
    if (slotDuration === 60) {
      try {
        const syncedCalendar = await getSyncedCalendarById(locationId, resolvedCalendarId);
        if (syncedCalendar) {
          slotDuration = syncedCalendar.slot_duration || 60;
          slotBuffer = syncedCalendar.slot_buffer || 0;
        }
      } catch (e: any) {
        console.error(`[Book] Calendar settings lookup error:`, e.message);
      }
    }
    console.log(`[Book] Calendar settings: duration=${slotDuration}min, buffer=${slotBuffer}min`);

    // Allow override via request body
    const durationMinutes = body.duration_minutes || body.durationMinutes || slotDuration;

    // STEP 4: Get authenticated client
    console.log(`[Book] STEP 4: Getting authenticated GHL client...`);
    let client;
    try {
      client = await ghl.requests(locationId);
      console.log(`[Book] STEP 4 SUCCESS: GHL client obtained`);
    } catch (clientErr: any) {
      console.error(`[Book] STEP 4 FATAL ERROR:`, clientErr.message);
      console.error(`[Book] Stack:`, clientErr.stack);
      return res.status(500).json({ success: false, error: "Failed to authenticate with GHL: " + clientErr.message });
    }

    // STEP 5: Create or upsert contact in GHL
    console.log(`[Book] STEP 5: Contact upsert starting...`);
    const nameParts = customerName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(" ") || "";

    const normalizedPhone = customerPhone ? normalizePhone(customerPhone) : null;
    console.log(`[Book] Phone normalization: "${customerPhone}" -> "${normalizedPhone}"`);

    const contactPayload: Record<string, string> = {
      locationId,
      email: customerEmail,
      firstName,
    };
    if (lastName) contactPayload.lastName = lastName;
    if (normalizedPhone) contactPayload.phone = normalizedPhone;

    console.log(`[Book] Contact payload:`, JSON.stringify(contactPayload));

    let contactId: string;
    try {
      const contactResp = await client.post("/contacts/upsert", contactPayload, {
        headers: { Version: "2021-07-28" },
      });
      contactId = contactResp.data?.contact?.id;
      if (!contactId) {
        throw new Error("No contact ID returned from upsert");
      }
      console.log(`[Book] STEP 5 SUCCESS: Contact upserted - contactId: ${contactId}`);
    } catch (err: any) {
      console.error(`[Book] STEP 5 FAILED: Contact upsert error`);
      console.error(`[Book] Error message:`, err.message);
      console.error(`[Book] Response data:`, JSON.stringify(err?.response?.data));
      return res.status(500).json({
        success: false,
        error: "Failed to create/upsert contact: " + (err?.response?.data?.message || err.message),
      });
    }

    // STEP 6: Book the appointment
    console.log(`[Book] STEP 6: Creating appointment...`);
    // Convert to UTC ISO format for GHL API
    const startISO = new Date(resolvedStartTime).toISOString();
    const startTimeMs = new Date(resolvedStartTime).getTime();
    const endTimeMs = startTimeMs + durationMinutes * 60 * 1000;
    const endISO = new Date(endTimeMs).toISOString();
    const bufferEndMs = endTimeMs + slotBuffer * 60 * 1000;
    const bufferEndISO = new Date(bufferEndMs).toISOString();

    console.log(`[Book] Time conversion: ${resolvedStartTime} => ${startISO}`);

    // Title-case the service type
    const formattedServiceType = serviceName ? toTitleCase(serviceName) : null;
    const appointmentTitle = formattedServiceType || title || "Appointment";

    // Build notes
    const noteParts: string[] = [];
    if (formattedServiceType) noteParts.push(formattedServiceType);
    if (therapistPreference) noteParts.push(`Therapist preference: ${therapistPreference}`);
    if (occasion) noteParts.push(`Occasion: ${occasion}`);
    if (notes) noteParts.push(notes);
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

    console.log("[Book] ===== GHL APPOINTMENT REQUEST =====");
    console.log("[Book] Full payload:", JSON.stringify(appointmentPayload, null, 2));

    let appointmentResp;
    try {
      appointmentResp = await client.post(
        "/calendars/events/appointments",
        appointmentPayload,
        { headers: { Version: "2021-07-28" } }
      );
      console.log("[Book] ===== GHL APPOINTMENT RESPONSE =====");
      console.log("[Book] Status:", appointmentResp.status);
      console.log("[Book] Response:", JSON.stringify(appointmentResp.data, null, 2));
    } catch (apptErr: any) {
      console.error(`[Book] STEP 6 FATAL ERROR: Appointment creation failed`);
      console.error(`[Book] Error message:`, apptErr.message);
      console.error(`[Book] Response status:`, apptErr?.response?.status);
      console.error(`[Book] Response data:`, JSON.stringify(apptErr?.response?.data));
      return res.status(500).json({
        success: false,
        error: "Appointment creation failed: " + (apptErr?.response?.data?.message || apptErr.message),
      });
    }

    const appointmentId =
      appointmentResp.data?.id ||
      appointmentResp.data?.event?.id ||
      appointmentResp.data?.eventId ||
      appointmentResp.data?.appointment?.id ||
      null;

    console.log(`[Book] STEP 6 SUCCESS: Appointment booked - appointmentId: ${appointmentId}`);

    // STEP 7: Create Internal Note via Appointment Notes API
    console.log(`[Book] STEP 7: Adding appointment note...`);
    if (appointmentNotes && appointmentId) {
      try {
        const notePayload = { body: appointmentNotes };
        console.log(`[Book] Notes API URL: /calendars/appointments/${appointmentId}/notes`);
        console.log(`[Book] Notes API payload:`, JSON.stringify(notePayload));

        const noteResp = await client.post(
          `/calendars/appointments/${appointmentId}/notes`,
          notePayload,
          { headers: { Version: "2021-07-28" } }
        );
        console.log(`[Book] STEP 7 SUCCESS: Note added - status: ${noteResp.status}`);
      } catch (noteErr: any) {
        console.error("[Book] STEP 7 FAILED: Notes API error");
        console.error("[Book] Status:", noteErr?.response?.status);
        console.error("[Book] Error:", JSON.stringify(noteErr?.response?.data || noteErr.message));
      }
    } else {
      console.log(`[Book] STEP 7 SKIPPED: No notes to add (appointmentNotes="${appointmentNotes}", appointmentId="${appointmentId}"`);
    }

    // STEP 8: Return success
    console.log(`[Book] ===== SINGLE SERVICE BOOKING SUCCESS =====`);
    console.log(`[Book] Appointment ID: ${appointmentId}`);
    console.log(`[Book] Contact ID: ${contactId}`);
    console.log(`[Book] Start: ${startISO}`);
    console.log(`[Book] End: ${endISO}`);
    console.log(`[Book] Service: ${serviceName || "(none)"}`);

    return res.json({
      success: true,
      appointmentId,
      contactId,
      startTime: startISO,
      endTime: endISO,
      buffer_end: bufferEndISO,
      duration_minutes: durationMinutes,
      buffer_minutes: slotBuffer,
      data: appointmentResp.data,
    });
  } catch (error: any) {
    console.error("[Book] ===== FATAL UNCAUGHT ERROR =====");
    console.error("[Book] Error message:", error.message);
    console.error("[Book] Stack trace:", error.stack);
    console.error("[Book] Response data:", JSON.stringify(error?.response?.data));
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

/**
 * POST /api/calendar/packages
 * Manage spa packages.
 *
 * List: { locationId, action: "list" }
 * Add:  { locationId, action: "add", package_name, services, total_duration_minutes?, price?, description? }
 * Delete: { locationId, action: "delete", id }
 */
router.post("/packages", async (req: Request, res: Response) => {
  try {
    const { locationId, location_id, action, package_name, services, total_duration_minutes, price, description, id } = req.body;
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }

    const actionLower = (action || "list").toLowerCase();

    if (actionLower === "list") {
      const packages = await getPackages(resolvedLocationId);
      return res.json({
        success: true,
        packages: packages.map((p) => ({
          id: p.id,
          package_name: p.package_name,
          services: p.services,
          total_duration_minutes: p.total_duration_minutes,
          price: p.price,
          description: p.description,
        })),
      });
    }

    if (actionLower === "add") {
      if (!package_name || !services || !Array.isArray(services)) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: package_name, services (array)",
        });
      }

      const pkg = await upsertPackage({
        location_id: resolvedLocationId,
        package_name,
        services,
        total_duration_minutes: total_duration_minutes || null,
        price: price || null,
        description: description || null,
        is_active: true,
      });

      if (!pkg) {
        return res.status(500).json({ success: false, error: "Failed to create package" });
      }

      return res.json({ success: true, package: pkg });
    }

    if (actionLower === "delete") {
      if (!id) {
        return res.status(400).json({ success: false, error: "Missing required field: id" });
      }

      const deleted = await deletePackage(id);
      if (!deleted) {
        return res.status(500).json({ success: false, error: "Failed to delete package" });
      }

      return res.json({ success: true, message: "Package deleted" });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });

  } catch (error: any) {
    console.error("[Calendar] packages error:", error?.message);
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * POST /api/calendar/staff
 * Manage staff gender for therapist preference filtering.
 *
 * Actions:
 *   - list: Get all unique staff members with their gender
 *   - update-gender: Update a staff member's gender
 *
 * Body: { locationId, action, memberId?, gender? }
 */
router.post("/staff", async (req: Request, res: Response) => {
  try {
    const { locationId, location_id, action, memberId, gender } = req.body;
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }

    const actionLower = (action || "list").toLowerCase();

    if (actionLower === "list") {
      const staff = await getUniqueTeamMembers(resolvedLocationId);
      const syncStatus = await getSyncStatus(resolvedLocationId);
      const allCalendars = await getSyncedCalendars(resolvedLocationId);

      // For each staff member, find which calendars they're assigned to
      const allTeamMembers = await getSyncedTeamMembers(resolvedLocationId, undefined);
      const staffWithCalendars = staff.map((m) => {
        // Find all calendar_ids this user is assigned to
        const memberCalendarIds = (allTeamMembers as any[])
          .filter((tm: any) => tm.user_id === m.user_id)
          .map((tm: any) => tm.calendar_id);

        // Get calendar names for those IDs
        const assignedCalendars = allCalendars
          .filter((cal) => memberCalendarIds.includes(cal.calendar_id))
          .map((cal) => cal.calendar_name);

        return {
          id: m.id,
          user_id: m.user_id,
          user_name: m.user_name,
          user_email: m.user_email,
          gender: m.gender,
          calendars: assignedCalendars,
        };
      });

      return res.json({
        success: true,
        staff: staffWithCalendars,
        last_sync: syncStatus?.last_sync_at || null,
      });
    }

    if (actionLower === "update-gender") {
      if (!memberId) {
        return res.status(400).json({ success: false, error: "Missing required field: memberId" });
      }

      // Validate gender value
      const validGender = gender === "male" || gender === "female" ? gender : null;

      const updated = await updateTeamMemberGender(resolvedLocationId, memberId, validGender);
      if (!updated) {
        return res.status(500).json({ success: false, error: "Failed to update gender" });
      }

      return res.json({ success: true, message: "Gender updated" });
    }

    if (actionLower === "update-name") {
      if (!memberId) {
        return res.status(400).json({ success: false, error: "Missing required field: memberId" });
      }

      const { name } = req.body;
      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return res.status(400).json({ success: false, error: "Missing required field: name" });
      }

      const updated = await updateTeamMemberName(resolvedLocationId, memberId, name.trim());
      if (!updated) {
        return res.status(500).json({ success: false, error: "Failed to update name" });
      }

      return res.json({ success: true, message: "Name updated" });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });

  } catch (error: any) {
    console.error("[Calendar] staff error:", error?.message);
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * POST /api/calendar/get-package
 * Get package details by name (for voice agent).
 *
 * Body: { locationId, package_name }
 * Returns package details. Supports partial matching (case-insensitive).
 */
router.post("/get-package", async (req: Request, res: Response) => {
  try {
    const { locationId, location_id, package_name } = req.body;
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }

    if (!package_name) {
      return res.status(400).json({ success: false, error: "Missing required field: package_name" });
    }

    const pkg = await getPackageByName(resolvedLocationId, package_name);

    if (!pkg) {
      return res.status(404).json({ success: false, error: "No package found with that name" });
    }

    return res.json({
      success: true,
      package: {
        id: pkg.id,
        package_name: pkg.package_name,
        services: pkg.services,
        total_duration_minutes: pkg.total_duration_minutes,
        price: pkg.price,
        description: pkg.description,
      },
    });

  } catch (error: any) {
    console.error("[Calendar] get-package error:", error?.message);
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * POST /api/calendar/book-package
 * Aggregator endpoint that books an entire spa package in one API call.
 * Handles finding availability and booking each service sequentially.
 *
 * Body: {
 *   locationId, package_name, time_preference, requested_date?,
 *   customer_name, phone, email, notes?, therapist_preference?
 * }
 *
 * therapist_preference: "male", "female", or null/undefined - appended to notes for spa staff
 */
router.post("/book-package", async (req: Request, res: Response) => {
  try {
    const {
      locationId,
      location_id,
      package_name,
      time_preference,
      requested_date,
      selected_date,
      requested_time,  // BUG FIX: Accept requested start time
      plan_id,  // SPEC Section 7: Use cached plan for check-vs-book consistency
      customer_name,
      phone,
      email,
      notes,
      therapist_preference,
      strict_gender,  // When true, no gender fallback for any service
    } = req.body;

    const resolvedLocationId = locationId || location_id;

    // Validate required fields
    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }
    if (!package_name) {
      return res.status(400).json({ success: false, error: "Missing required field: package_name" });
    }
    // time_preference is optional if plan_id is provided
    if (!time_preference && !plan_id) {
      return res.status(400).json({ success: false, error: "Missing required field: time_preference (or provide plan_id)" });
    }
    if (!customer_name || !phone || !email) {
      return res.status(400).json({ success: false, error: "Missing required fields: customer_name, phone, email" });
    }

    console.log(`[BookPackage] Starting package booking: ${package_name} for ${customer_name}`);
    console.log(`[BookPackage] Plan ID: ${plan_id || "(none)"}`);
    console.log(`[BookPackage] Requested time: ${requested_time || "(none)"}`);
    console.log(`[BookPackage] Selected date: ${selected_date || "(none)"}`);
    console.log(`[BookPackage] Time preference: ${time_preference || "(none)"}`);
    console.log(`[BookPackage] Therapist preference: ${therapist_preference || "(none)"}`);
    console.log(`[BookPackage] Strict gender: ${strict_gender || false}`);

    // Step 1: Look up the package
    const pkg = await getPackageByName(resolvedLocationId, package_name);
    if (!pkg) {
      // Try to find similar packages for suggestion
      const allPackages = await getPackages(resolvedLocationId);
      const suggestion = allPackages.length > 0 ? allPackages[0].package_name : null;

      return res.status(404).json({
        success: false,
        error: "Package not found",
        message: suggestion
          ? `I couldn't find a package called '${package_name}'. Did you mean ${suggestion}?`
          : `I couldn't find a package called '${package_name}'.`,
      });
    }

    console.log(`[BookPackage] Found package: ${pkg.package_name} with ${pkg.services.length} services`);

    // Step 2: Get installation for timezone and auth
    const installation = await getInstallation(resolvedLocationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    const tz = installation.timezone || "America/New_York";
    const client = await ghl.requests(resolvedLocationId);

    // Get local time using luxon
    const localNowLuxon = DateTime.now().setZone(tz);
    const localNow = localNowLuxon.toJSDate();
    const todayStr = localNowLuxon.toFormat("yyyy-MM-dd");

    // Parse requested_date or selected_date if provided
    let startDateFilter: string | null = null;
    let specificDate: string | null = null;

    if (selected_date) {
      // User picked a specific date from check-package-availability
      const parsed = parseRequestedDate(selected_date, localNow);
      if (parsed) {
        specificDate = parsed;
        startDateFilter = parsed;
      }
    } else if (requested_date) {
      const parsed = parseRequestedDate(requested_date, localNow);
      if (parsed) startDateFilter = parsed;
    }

    // Step 3: Get package plan (from cache or recalculate)
    // SPEC Section 7: Use cached plan for check-vs-book consistency
    let packagePlan: {
      date: string;
      slots: Array<{
        service: string;
        startTime: string;
        endTime: string;
        calendar_id: string;
        staff_name: string | null;
        staff_user_id: string | null;
      }>;
    } | null = null;

    // PRIORITY 1: Use cached plan from check_availability via plan_id
    // Treat empty string as falsy (ElevenLabs sometimes sends "" instead of null)
    if (plan_id && plan_id.trim() !== "") {
      console.log(`[BookPackage] Looking up cached plan with ID: ${plan_id}`);
      const cached = getCachedPlan(plan_id);

      if (cached) {
        // Verify this plan belongs to the correct location and package
        if (cached.locationId !== resolvedLocationId) {
          console.log(`[BookPackage] CACHE MISMATCH: Plan location ${cached.locationId} !== request location ${resolvedLocationId}`);
          return res.status(400).json({ success: false, error: "Plan ID belongs to a different location" });
        }
        if (cached.packageName.toLowerCase() !== package_name.toLowerCase()) {
          console.log(`[BookPackage] CACHE MISMATCH: Plan package "${cached.packageName}" !== request package "${package_name}"`);
          return res.status(400).json({ success: false, error: "Plan ID belongs to a different package" });
        }

        // Use the cached plan directly
        packagePlan = cached.plan;
        console.log(`[BookPackage] Using cached plan from check_availability`);
        console.log(`[BookPackage] Package date: ${packagePlan.date}`);
        packagePlan.slots.forEach((s, idx) => {
          console.log(`[BookPackage]   ${idx + 1}. ${s.service}: ${s.startTime} -> ${s.endTime} (staff: ${s.staff_name || "any"}, calendar: ${s.calendar_id})`);
        });
      } else {
        console.log(`[BookPackage] CACHE MISS: Plan ${plan_id} not found or expired, falling back to recalculate`);
      }
    }

    // PRIORITY 2: Fall back to recalculating if no cached plan
    if (!packagePlan) {
      console.log(`[BookPackage] Finding a day where all ${pkg.services.length} services fit...`);
      if (specificDate) {
        console.log(`[BookPackage] User selected specific date: ${specificDate}`);
      }

      const packagePlans = await findPackageDayAvailability(
        resolvedLocationId,
        pkg.services,
        time_preference,
        startDateFilter,
        tz,
        installation,
        localNow,
        1, // Only need 1 result for booking
        therapist_preference,
        strict_gender === true,  // Pass strict gender mode
        requested_time  // BUG FIX: Pass requested start time
      );

      // If user selected a specific date, verify the result matches
      packagePlan = packagePlans[0] || null;

      if (specificDate && packagePlan && packagePlan.date !== specificDate) {
        // The specific date doesn't work, return error
        console.log(`[BookPackage] Selected date ${specificDate} doesn't have availability`);
        packagePlan = null;
      }
    }

    if (!packagePlan) {
      // No plan found - suggest alternative
      const alternativePreference = time_preference === "afternoon" ? "morning" : "afternoon";
      const dateContext = specificDate ? ` on ${specificDate}` : "";
      return res.json({
        success: false,
        partial: false,
        package_name: pkg.package_name,
        appointments: [],
        message: `I couldn't find availability for all services in the ${pkg.package_name}${dateContext}. Would you like to try ${alternativePreference} instead of ${time_preference}?`,
      });
    }

    console.log(`[BookPackage] Found valid day: ${packagePlan.date} with ${packagePlan.slots.length} slots`);

    // Step 4: Book all services on the found day
    const appointments: Array<{
      service: string;
      date?: string;
      start_time?: string;
      end_time?: string;
      staff_name?: string;
      calendar_id?: string;
      appointment_id?: string;
      status: "confirmed" | "failed" | "skipped";
      error?: string;
    }> = [];

    let allSuccessful = true;

    for (let i = 0; i < packagePlan.slots.length; i++) {
      const slotInfo = packagePlan.slots[i];
      console.log(`[BookPackage] Booking service ${i + 1}/${packagePlan.slots.length}: ${slotInfo.service} at ${slotInfo.startTime}`);

      try {
        const bookingResult = await bookServiceAppointment(
          client,
          resolvedLocationId,
          slotInfo.calendar_id,
          slotInfo.startTime,
          slotInfo.service,
          customer_name,
          email,
          phone,
          notes,
          therapist_preference,
          slotInfo.staff_user_id || undefined  // BUG FIX: Assign to specific staff
        );

        if (!bookingResult.success) {
          console.log(`[BookPackage] Booking failed for ${slotInfo.service}: ${bookingResult.error}`);
          appointments.push({
            service: slotInfo.service,
            status: "failed",
            error: bookingResult.error,
          });
          allSuccessful = false;
          continue;
        }

        const startDate = new Date(slotInfo.startTime);
        const endDate = new Date(bookingResult.endTime!);

        appointments.push({
          service: slotInfo.service,
          date: packagePlan.date,
          start_time: formatTimeForVoice(startDate, tz),
          end_time: formatTimeForVoice(endDate, tz),
          staff_name: slotInfo.staff_name || undefined,
          calendar_id: slotInfo.calendar_id,
          appointment_id: bookingResult.appointmentId,
          status: "confirmed",
        });

        console.log(`[BookPackage] Booked ${slotInfo.service} successfully`);

      } catch (err: any) {
        console.error(`[BookPackage] Error booking ${slotInfo.service}:`, err.message);
        appointments.push({
          service: slotInfo.service,
          status: "failed",
          error: err.message,
        });
        allSuccessful = false;
      }
    }

    // Step 5: Build response
    const confirmedAppointments = appointments.filter((a) => a.status === "confirmed");

    if (confirmedAppointments.length === 0) {
      return res.json({
        success: false,
        partial: false,
        package_name: pkg.package_name,
        appointments,
        message: `I found availability but the bookings failed. Would you like to try again?`,
      });
    }

    if (!allSuccessful) {
      // Partial success - some bookings failed after we found availability
      const bookedServices = confirmedAppointments.map((a) => a.service).join(", ");
      const failedService = appointments.find((a) => a.status === "failed")?.service;

      return res.json({
        success: false,
        partial: true,
        package_name: pkg.package_name,
        total_price: pkg.price,
        appointments,
        message: `I was able to book ${bookedServices}, but ${failedService} failed to book. Would you like me to try again?`,
      });
    }

    // Full success - build confirmation message
    const confirmationMessage = buildPackageConfirmation(
      pkg.package_name,
      confirmedAppointments,
      pkg.price,
      tz
    );

    console.log(`[BookPackage] Successfully booked all ${confirmedAppointments.length} services`);

    return res.json({
      success: true,
      package_name: pkg.package_name,
      total_price: pkg.price,
      total_duration_minutes: pkg.total_duration_minutes,
      appointments: confirmedAppointments,
      confirmation_message: confirmationMessage,
    });

  } catch (error: any) {
    console.error("[BookPackage] Error:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data?.message || error.message,
    });
  }
});

/**
 * POST /api/calendar/check-package-availability
 * Check availability for a package WITHOUT booking.
 * Returns 2-3 available dates where ALL services fit on the SAME day.
 *
 * Body: {
 *   locationId, package_name, time_preference,
 *   requested_date? (optional - start searching from this date)
 * }
 */
router.post("/check-package-availability", async (req: Request, res: Response) => {
  try {
    const {
      locationId,
      location_id,
      package_name,
      time_preference,
      requested_date,
      requested_time,  // BUG FIX: Accept requested start time
      therapist_preference,
      strict_gender,  // When true, no gender fallback for any service
    } = req.body;

    const resolvedLocationId = locationId || location_id;

    // Validate required fields
    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }
    if (!package_name) {
      return res.status(400).json({ success: false, error: "Missing required field: package_name" });
    }
    if (!time_preference) {
      return res.status(400).json({ success: false, error: "Missing required field: time_preference" });
    }

    console.log(`[CheckPackage] Checking availability for: ${package_name}, preference: ${time_preference}, therapist: ${therapist_preference || "(none)"}`);

    // Look up the package
    const pkg = await getPackageByName(resolvedLocationId, package_name);
    if (!pkg) {
      const allPackages = await getPackages(resolvedLocationId);
      const suggestion = allPackages.length > 0 ? allPackages[0].package_name : null;

      return res.status(404).json({
        success: false,
        error: "Package not found",
        message: suggestion
          ? `I couldn't find a package called '${package_name}'. Did you mean ${suggestion}?`
          : `I couldn't find a package called '${package_name}'.`,
      });
    }

    // Get installation for timezone and auth
    const installation = await getInstallation(resolvedLocationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    const tz = installation.timezone || "America/New_York";
    const localNow = DateTime.now().setZone(tz).toJSDate();

    // Parse requested_date if provided
    let startDateFilter: string | null = null;
    if (requested_date) {
      const parsed = parseRequestedDate(requested_date, localNow);
      if (parsed) startDateFilter = parsed;
    }

    // Find up to 3 days where all services fit
    const packagePlans = await findPackageDayAvailability(
      resolvedLocationId,
      pkg.services,
      time_preference,
      startDateFilter,
      tz,
      installation,
      localNow,
      3, // Return up to 3 available dates
      therapist_preference,
      strict_gender === true,  // Pass strict gender mode
      requested_time  // BUG FIX: Pass requested start time
    );

    if (packagePlans.length === 0) {
      const alternativePreference = time_preference === "afternoon" ? "morning" : "afternoon";
      return res.json({
        success: false,
        package_name: pkg.package_name,
        available_dates: [],
        message: `I couldn't find any days with availability for all services in the ${pkg.package_name}. Would you like to try ${alternativePreference} instead of ${time_preference}?`,
      });
    }

    // Format response - IMPORTANT: start_time is when the PACKAGE starts (first service)
    // Don't put staff names at the top level - they apply to individual services
    // SPEC Section 7: Cache each plan with a plan_id for check-vs-book consistency
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    const available_dates = packagePlans.map((plan) => {
      const dateObj = new Date(plan.date + "T12:00:00");
      const dayName = dayNames[dateObj.getDay()];

      // First slot is when the package STARTS
      const firstSlot = plan.slots[0];
      const packageStartTime = formatTimeForVoice(new Date(firstSlot.startTime), tz);

      // Generate a plan_id and cache this plan for book_appointment to use
      const planId = generatePlanId();
      cachePlan(planId, {
        locationId: resolvedLocationId,
        packageName: pkg.package_name,
        plan: {
          date: plan.date,
          slots: plan.slots.map((slot) => ({
            service: slot.service,
            startTime: slot.startTime,
            endTime: slot.endTime,
            calendar_id: slot.calendar_id,
            staff_name: slot.staff_name,
            staff_user_id: slot.staff_user_id,
          })),
        },
        createdAt: Date.now(),
      });

      return {
        date: plan.date,
        day_name: dayName,
        plan_id: planId,  // IMPORTANT: Pass this to book_appointment to use the cached plan
        // Package start time - this is what the agent should say: "starting at 9:00 AM"
        start_time: packageStartTime,
        startTime: firstSlot.startTime,  // ISO timestamp for booking
        // Individual service details (for internal use, not for voice)
        services: plan.slots.map((slot) => ({
          service: slot.service,
          start_time: formatTimeForVoice(new Date(slot.startTime), tz),
          end_time: formatTimeForVoice(new Date(slot.endTime), tz),
          startTime: slot.startTime,
          endTime: slot.endTime,
          staff_name: slot.staff_name,
        })),
      };
    });

    console.log(`[CheckPackage] Found ${available_dates.length} available dates with plan_ids`);

    const response = {
      success: true,
      package_name: pkg.package_name,
      total_price: pkg.price,
      total_duration_minutes: pkg.total_duration_minutes,
      services: pkg.services,
      available_dates,
    };

    // LOG FULL RESPONSE so we can verify plan_id is included for ElevenLabs
    console.log(`[CheckPackage] FULL RESPONSE:`, JSON.stringify(response, null, 2));

    return res.json(response);

  } catch (error: any) {
    console.error("[CheckPackage] Error:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data?.message || error.message,
    });
  }
});

// ============================================================================
// Helper functions for book-package
// ============================================================================

/**
 * Parse requested_date string to ISO date string using chrono-node.
 * Handles natural language dates like "today", "tomorrow", "next Monday",
 * "Monday the 9th", "February 15th", etc.
 * Returns ISO date string (YYYY-MM-DD) or null if parsing fails.
 */
function parseRequestedDate(input: string, localNow: Date): string | null {
  if (!input || typeof input !== "string") return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // If already ISO format, validate and return
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = new Date(trimmed + "T00:00:00");
    if (!isNaN(parsed.getTime())) {
      return trimmed;
    }
  }

  // Use chrono-node for natural language parsing
  const parsed = chrono.parseDate(trimmed, localNow, { forwardDate: true });

  if (!parsed) {
    console.log(`[DateParse] chrono-node could not parse: "${input}"`);
    return null;
  }

  // Validate: must be today or future
  const today = new Date(localNow);
  today.setHours(0, 0, 0, 0);
  const parsedDay = new Date(parsed);
  parsedDay.setHours(0, 0, 0, 0);

  if (parsedDay < today) {
    console.log(`[DateParse] Parsed date "${input}" is in the past: ${parsed.toISOString()}`);
    return null;
  }

  // Validate: within 60 days
  const maxDate = new Date(localNow);
  maxDate.setDate(maxDate.getDate() + 60);
  if (parsedDay > maxDate) {
    console.log(`[DateParse] Parsed date "${input}" is beyond 60 days: ${parsed.toISOString()}`);
    return null;
  }

  // Return ISO date string (YYYY-MM-DD)
  const result = parsed.toISOString().split("T")[0];
  console.log(`[DateParse] Matched "${input}" to ${result}`);
  return result;
}

/**
 * Find availability for a specific service.
 */
async function findServiceAvailability(
  locationId: string,
  serviceName: string,
  timePreference: string,
  requestedDate: string | null,
  startAfter: string | null,
  tz: string,
  installation: any,
  localNow: Date
): Promise<{
  slot: { startTime: string; calendar_id: string; staff_name: string | null } | null;
}> {
  // Find calendars for this service
  let calendarsToCheck: Array<{ calendar_id: string; calendar_name: string | null; staff_name: string | null }> = [];

  const syncedCals = await getSyncedCalendarsForService(locationId, serviceName);
  if (syncedCals.length > 0) {
    for (const cal of syncedCals) {
      const members = await getSyncedTeamMembers(locationId, cal.calendar_id);
      const primaryMember = members.find((m) => m.is_primary) || members[0];
      calendarsToCheck.push({
        calendar_id: cal.calendar_id,
        calendar_name: cal.calendar_name,
        staff_name: primaryMember?.user_name || null,
      });
    }
  }

  // Fallback to default calendar
  if (calendarsToCheck.length === 0 && installation.calendar_id) {
    calendarsToCheck = [{ calendar_id: installation.calendar_id, calendar_name: null, staff_name: null }];
  }

  if (calendarsToCheck.length === 0) {
    return { slot: null };
  }

  // Calculate time window
  const BUFFER_MS = 15 * 60 * 1000;
  const nowPlusBuffer = localNow.getTime() + BUFFER_MS;

  let minSlotTimeMs = nowPlusBuffer;
  if (startAfter) {
    const startAfterMs = new Date(startAfter).getTime();
    if (!isNaN(startAfterMs)) {
      minSlotTimeMs = Math.max(minSlotTimeMs, startAfterMs);
    }
  }

  // Fetch slots for each calendar
  for (const cal of calendarsToCheck) {
    for (const daysAhead of [7, 14, 30]) {
      const endDate = new Date(localNow);
      endDate.setDate(endDate.getDate() + daysAhead);
      const endMs = endDate.getTime();
      const startMs = minSlotTimeMs;

      const slotsUrl = `${process.env.GHL_API_DOMAIN}/calendars/${cal.calendar_id}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=${encodeURIComponent(tz)}`;

      try {
        console.log(`[BookPackage] Fetching free-slots: ${slotsUrl}`);
        const resp = await axios.get(slotsUrl, {
          headers: {
            Authorization: `Bearer ${installation.access_token}`,
            Version: "2021-07-28",
          },
        });

        const rawData = resp.data || {};
        console.log(`[BookPackage] Raw GHL free-slots response:`, JSON.stringify(rawData, null, 2));

        const dateKeys = Object.keys(rawData).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
        console.log(`[BookPackage] Found ${dateKeys.length} dates with slots: ${dateKeys.join(", ")}`);

        for (const dateKey of dateKeys) {
          // Apply date filter: skip dates BEFORE requested date (start searching from that date)
          if (requestedDate && dateKey < requestedDate) {
            console.log(`[BookPackage] Skipping ${dateKey} (before requested date ${requestedDate})`);
            continue;
          }

          const entry = rawData[dateKey];
          const slots: string[] = Array.isArray(entry) ? entry : entry?.slots || [];
          console.log(`[BookPackage] Date ${dateKey} has ${slots.length} slots`);

          for (const slot of slots) {
            const slotMs = new Date(slot).getTime();
            if (slotMs < minSlotTimeMs) continue;

            // Apply time preference filter using LOCATION'S timezone
            const slotInTz = new Date(slot).toLocaleString("en-US", { timeZone: tz, hour12: false });
            const hourMatch = slotInTz.match(/(\d{1,2}):/);
            const localHour = hourMatch ? parseInt(hourMatch[1], 10) : new Date(slot).getHours();

            console.log(`[BookPackage] Slot ${slot} -> local hour ${localHour} in ${tz}, preference: ${timePreference}`);

            if (timePreference === "morning" && localHour >= 12) {
              console.log(`[BookPackage] Skipping slot - afternoon hour ${localHour} but preference is morning`);
              continue;
            }
            if (timePreference === "afternoon" && localHour < 12) {
              console.log(`[BookPackage] Skipping slot - morning hour ${localHour} but preference is afternoon`);
              continue;
            }

            // Found a valid slot
            console.log(`[BookPackage] Selected slot: ${slot} (local hour ${localHour})`);
            return {
              slot: {
                startTime: slot,
                calendar_id: cal.calendar_id,
                staff_name: cal.staff_name,
              },
            };
          }
        }
      } catch (err: any) {
        console.error(`[BookPackage] Error fetching slots for ${cal.calendar_id}:`, err.message);
        console.error(`[BookPackage] Full error:`, err.response?.data || err);
      }
    }
  }

  return { slot: null };
}

/**
 * Find days where ALL package services can be booked consecutively.
 * Returns up to maxResults valid days, or empty array if none found.
 *
 * SIMPLE GENDER LOGIC:
 * - Gender preference ONLY affects MASSAGE services (calendar name contains "massage")
 * - All other services (facial, body treatment, etc.) are completely unaffected
 * - Exception: strict_gender=true applies gender filter to ALL services
 */
// Helper to check if a service is a massage type
function isMassageService(serviceName: string, calendarName?: string): boolean {
  const lowerService = serviceName.toLowerCase();
  const lowerCalendar = (calendarName || "").toLowerCase();
  return lowerService.includes("massage") || lowerCalendar.includes("massage");
}

async function findPackageDayAvailability(
  locationId: string,
  services: string[],
  timePreference: string,
  requestedDate: string | null,
  tz: string,
  installation: any,
  localNow: Date,
  maxResults: number = 1,
  genderPreference?: string,  // "male", "female", or undefined for no preference
  strictGender: boolean = false,  // When true, apply gender filter to ALL services
  requestedTime?: string  // BUG FIX: Specific start time like "9:00 AM" - package starts AT this time
): Promise<Array<{
  date: string;
  slots: Array<{
    service: string;
    startTime: string;
    endTime: string;
    calendar_id: string;
    staff_name: string | null;
    staff_user_id: string | null;  // BUG FIX: Include user_id for booking assignment
  }>;
}>> {
  const DAYS_TO_SEARCH = 14;
  const BUFFER_MS = 15 * 60 * 1000;

  // Build list of dates to check
  // BUG FIX: If requestedDate is provided, ONLY check that specific date
  // Don't search 14 days when user asks for "Monday the 16th"
  const datesToCheck: string[] = [];

  if (requestedDate) {
    // User asked for a specific date - ONLY check that date
    datesToCheck.push(requestedDate);
    console.log(`[Package] Checking ONLY requested date: ${requestedDate}`);
  } else {
    // No specific date - search next 14 days
    const startDate = new Date(localNow);
    for (let i = 0; i < DAYS_TO_SEARCH; i++) {
      const checkDate = new Date(startDate);
      checkDate.setDate(startDate.getDate() + i);
      datesToCheck.push(checkDate.toISOString().split("T")[0]);
    }
    console.log(`[Package] Searching next ${DAYS_TO_SEARCH} days starting from today`);
  }

  console.log(`[BookPackage] Checking ${datesToCheck.length} dates for all ${services.length} services`);
  console.log(`[BookPackage] Gender preference: ${genderPreference || "(none)"}, strict mode: ${strictGender}`);

  // Normalize gender preference
  const normalizedGender = genderPreference?.toLowerCase() as "male" | "female" | undefined;

  // Get calendars and staff for each service
  const serviceCalendars: Map<string, Array<{ calendar_id: string; calendar_name: string | null; staff_name: string | null; user_id: string | null }>> = new Map();

  for (const service of services) {
    const syncedCals = await getSyncedCalendarsForService(locationId, service);
    const cals: Array<{ calendar_id: string; calendar_name: string | null; staff_name: string | null; user_id: string | null }> = [];

    if (syncedCals.length > 0) {
      for (const cal of syncedCals) {
        let members = await getSyncedTeamMembers(locationId, cal.calendar_id);
        const isMassage = isMassageService(service, cal.calendar_name || undefined);

        // SIMPLE RULE: Only filter by gender for massage services (or if strict_gender is true)
        const shouldFilterByGender = normalizedGender && (isMassage || strictGender);

        if (shouldFilterByGender) {
          const beforeCount = members.length;
          members = members.filter(m => m.gender === normalizedGender);
          console.log(`[Package] ${isMassage ? "Massage" : "Strict mode"} "${service}" filtered by gender ${normalizedGender}: ${beforeCount} -> ${members.length} staff`);
        }

        // Add staff members
        for (const member of members) {
          cals.push({
            calendar_id: cal.calendar_id,
            calendar_name: cal.calendar_name,
            staff_name: member.user_name,
            user_id: member.user_id,
          });
        }

        // Fallback if no members found (only if not filtering by gender)
        if (members.length === 0 && !shouldFilterByGender) {
          cals.push({ calendar_id: cal.calendar_id, calendar_name: cal.calendar_name, staff_name: null, user_id: null });
        }
      }
    } else if (installation.calendar_id) {
      cals.push({ calendar_id: installation.calendar_id, calendar_name: null, staff_name: null, user_id: null });
    }

    if (cals.length === 0) {
      const isMassage = isMassageService(service);
      if (isMassage && normalizedGender) {
        console.log(`[Package] Massage "${service}" has no ${normalizedGender} staff available`);
      } else if (strictGender && normalizedGender) {
        console.log(`[Package] Strict mode: "${service}" has no ${normalizedGender} staff available`);
      } else {
        console.log(`[Package] No calendar/staff found for service: ${service}`);
      }
      return [];
    }

    console.log(`[Package] Service "${service}": ${cals.length} staff options`);
    serviceCalendars.set(service, cals);
  }

  // Fetch free slots for each calendar+staff combination
  const endDateMs = new Date(datesToCheck[datesToCheck.length - 1] + "T23:59:59").getTime();
  const startMs = Math.max(localNow.getTime() + BUFFER_MS, new Date(datesToCheck[0] + "T00:00:00").getTime());

  const staffCalendarSlots: Map<string, Map<string, string[]>> = new Map();
  const staffCalendarKeys = new Set<string>();

  for (const cals of serviceCalendars.values()) {
    for (const cal of cals) {
      const key = `${cal.calendar_id}:${cal.user_id || "any"}`;
      staffCalendarKeys.add(key);
    }
  }

  // Fetch slots for each calendar+staff combination
  for (const key of staffCalendarKeys) {
    const [calendarId, userId] = key.split(":");

    let slotsUrl = `${process.env.GHL_API_DOMAIN}/calendars/${calendarId}/free-slots?startDate=${startMs}&endDate=${endDateMs}&timezone=${encodeURIComponent(tz)}`;
    if (userId && userId !== "any") {
      slotsUrl += `&userId=${encodeURIComponent(userId)}`;
    }

    try {
      const resp = await axios.get(slotsUrl, {
        headers: {
          Authorization: `Bearer ${installation.access_token}`,
          Version: "2021-07-28",
        },
      });

      const rawData = resp.data || {};
      const dateSlots: Map<string, string[]> = new Map();

      for (const dateKey of Object.keys(rawData)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
        const entry = rawData[dateKey];
        const slots: string[] = Array.isArray(entry) ? entry : entry?.slots || [];
        dateSlots.set(dateKey, slots);
      }

      staffCalendarSlots.set(key, dateSlots);
    } catch (err: any) {
      console.error(`[BookPackage] Error fetching slots for ${key}:`, err.message);
      staffCalendarSlots.set(key, new Map());
    }
  }

  // SPEC Section 8 & 22: Do NOT infer closing time from GHL slots.
  // GHL free-slots only returns slots within business hours. If a slot exists
  // in the API response, it's within business hours by definition.
  // The old closing time inference was broken because existing appointments
  // consume later slots, making the "last available slot" appear earlier than
  // actual closing time.

  // Helper to check time preference
  const matchesTimePreference = (slotTime: string): boolean => {
    const slotInTz = new Date(slotTime).toLocaleString("en-US", { timeZone: tz, hour12: false });
    const hourMatch = slotInTz.match(/(\d{1,2}):/);
    const localHour = hourMatch ? parseInt(hourMatch[1], 10) : new Date(slotTime).getHours();

    if (timePreference === "morning" && localHour >= 12) return false;
    if (timePreference === "afternoon" && localHour < 12) return false;
    return true;
  };

  // Helper to get calendar duration + buffer
  const getCalendarTiming = async (calendarId: string): Promise<{ duration: number; buffer: number }> => {
    const syncedCalendar = await getSyncedCalendarById(locationId, calendarId);
    return {
      duration: (syncedCalendar?.slot_duration || 60) * 60 * 1000,
      buffer: (syncedCalendar?.slot_buffer || 15) * 60 * 1000,
    };
  };

  // Collect valid dates
  const results: Array<{
    date: string;
    slots: Array<{
      service: string;
      startTime: string;
      endTime: string;
      calendar_id: string;
      staff_name: string | null;
      staff_user_id: string | null;  // BUG FIX: Include user_id for booking assignment
    }>;
  }> = [];

  // BUG FIX: Parse requestedTime to minutes for setting minimum start time
  // IMPORTANT: Pass timezone from installation record for correct ISO string parsing
  let requestedTimeMins: number | null = null;
  if (requestedTime) {
    requestedTimeMins = parseTimeToMinutes(requestedTime, tz);
    console.log(`[Package] User requested start time: ${requestedTime} => ${requestedTimeMins} minutes from midnight (timezone: ${tz})`);
  }

  // Try each date
  for (const dateKey of datesToCheck) {
    if (results.length >= maxResults) break;

    const plan: Array<{
      service: string;
      startTime: string;
      endTime: string;
      calendar_id: string;
      staff_name: string | null;
      staff_user_id: string | null;
    }> = [];

    // BUG FIX: If user requested a specific time (e.g., "9 AM"), start at that time, not earliest available
    let minStartTimeMs: number;
    if (requestedTimeMins !== null) {
      // Build the specific start time for this date
      const hours = Math.floor(requestedTimeMins / 60);
      const mins = requestedTimeMins % 60;
      const requestedDateTime = new Date(`${dateKey}T${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:00`);
      minStartTimeMs = Math.max(localNow.getTime() + BUFFER_MS, requestedDateTime.getTime());
      console.log(`[Package] Starting package at requested time: ${requestedDateTime.toISOString()}`);
    } else {
      minStartTimeMs = Math.max(localNow.getTime() + BUFFER_MS, new Date(dateKey + "T00:00:00").getTime());
    }
    let dateWorks = true;

    // FIX 3: Track consumed slots to prevent double-booking same staff at same time
    // Format: "staffKey:slotTimeMs" -> endTimeMs
    const consumedSlots: Map<string, number> = new Map();

    for (const service of services) {
      const cals = serviceCalendars.get(service) || [];
      let foundSlot = false;

      for (const cal of cals) {
        const staffKey = `${cal.calendar_id}:${cal.user_id || "any"}`;
        const dateSlots = staffCalendarSlots.get(staffKey)?.get(dateKey) || [];

        for (const slotTime of dateSlots) {
          const slotMs = new Date(slotTime).getTime();
          if (slotMs < minStartTimeMs) continue;
          if (!matchesTimePreference(slotTime)) continue;

          // FIX 3: Check if this staff member is already booked at this time
          // Look for any consumed slot for this staff that would overlap
          let slotConsumed = false;
          for (const [consumedKey, consumedEndMs] of consumedSlots) {
            if (consumedKey.startsWith(staffKey + ":")) {
              const consumedStartMs = parseInt(consumedKey.split(":").pop()!, 10);
              // Check for overlap: new slot starts before consumed ends
              if (slotMs < consumedEndMs && slotMs >= consumedStartMs) {
                slotConsumed = true;
                break;
              }
            }
          }
          if (slotConsumed) {
            console.log(`[Package] Skipping ${staffKey} at ${slotTime} - already booked for another service`);
            continue;
          }

          const timing = await getCalendarTiming(cal.calendar_id);
          const endTimeMs = slotMs + timing.duration;
          const endTimeISO = new Date(endTimeMs).toISOString();

          // FIX 3: Mark this slot as consumed for this staff
          consumedSlots.set(`${staffKey}:${slotMs}`, endTimeMs + timing.buffer);

          plan.push({
            service,
            startTime: slotTime,
            endTime: endTimeISO,
            calendar_id: cal.calendar_id,
            staff_name: cal.staff_name,
            staff_user_id: cal.user_id,
          });

          minStartTimeMs = endTimeMs + timing.buffer;
          foundSlot = true;
          break;
        }
        if (foundSlot) break;
      }

      if (!foundSlot) {
        dateWorks = false;
        break;
      }
    }

    if (dateWorks && plan.length === services.length) {
      // SPEC Section 8 & 22: Trust GHL free-slots data.
      // If we found valid GHL slots for ALL services in sequence, the package
      // fits within business hours by definition. GHL wouldn't return a slot
      // that extends past closing time.
      const lastSlot = plan[plan.length - 1];
      const lastEndTime = new Date(lastSlot.endTime);
      const endTimeLocal = lastEndTime.toLocaleString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });
      console.log(`[Package] Found valid day: ${dateKey} (package ends at ${endTimeLocal})`);

      results.push({ date: dateKey, slots: plan });
    }
  }

  console.log(`[Package] Found ${results.length} valid days out of ${datesToCheck.length} checked`);
  return results;
}

/**
 * Book an appointment for a service.
 */
async function bookServiceAppointment(
  client: any,
  locationId: string,
  calendarId: string,
  startTime: string,
  serviceName: string,
  customerName: string,
  customerEmail: string,
  customerPhone: string,
  notes?: string,
  therapistPreference?: string,
  staffUserId?: string  // BUG FIX: Assign to specific staff member
): Promise<{
  success: boolean;
  appointmentId?: string;
  endTime?: string;
  bufferEnd?: string;
  error?: string;
}> {
  console.log(`[BookService] ===== START: ${serviceName} =====`);
  console.log(`[BookService] Calendar: ${calendarId}`);
  console.log(`[BookService] Start time: ${startTime}`);
  console.log(`[BookService] Customer: ${customerName}, ${customerEmail}, ${customerPhone}`);
  console.log(`[BookService] Staff userId: ${staffUserId || "(none)"}`);

  try {
    // Get calendar settings for duration and buffer
    console.log(`[BookService] Getting calendar settings...`);
    const syncedCalendar = await getSyncedCalendarById(locationId, calendarId);
    const slotDuration = syncedCalendar?.slot_duration || 60;
    const slotBuffer = syncedCalendar?.slot_buffer || 15;
    console.log(`[BookService] Calendar settings: duration=${slotDuration}min, buffer=${slotBuffer}min`);

    // Create/upsert contact
    console.log(`[BookService] Upserting contact...`);
    const nameParts = customerName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(" ") || "";

    const contactPayload: Record<string, string> = {
      locationId,
      email: customerEmail,
      firstName,
    };
    if (lastName) contactPayload.lastName = lastName;
    if (customerPhone) contactPayload.phone = normalizePhoneForBooking(customerPhone);

    console.log(`[BookService] Contact payload:`, JSON.stringify(contactPayload));
    const contactResp = await client.post("/contacts/upsert", contactPayload, {
      headers: { Version: "2021-07-28" },
    });
    const contactId = contactResp.data?.contact?.id;
    if (!contactId) {
      console.error(`[BookService] Contact upsert returned no ID:`, JSON.stringify(contactResp.data));
      return { success: false, error: "Failed to create contact - no ID returned" };
    }
    console.log(`[BookService] Contact upserted: ${contactId}`);

    // Calculate times
    const startISO = new Date(startTime).toISOString();
    const startTimeMs = new Date(startTime).getTime();
    const endTimeMs = startTimeMs + slotDuration * 60 * 1000;
    const endISO = new Date(endTimeMs).toISOString();
    const bufferEndMs = endTimeMs + slotBuffer * 60 * 1000;
    const bufferEndISO = new Date(bufferEndMs).toISOString();

    // Build notes - ONLY add therapist preference to MASSAGE services
    // Other services (body treatment, facial) don't need therapist gender preference
    let appointmentNotes = notes || "";
    if (therapistPreference && ["male", "female"].includes(therapistPreference.toLowerCase())) {
      // Check if this is a massage service using the existing helper
      const calendarName = syncedCalendar?.calendar_name || "";
      const isMassage = isMassageService(serviceName, calendarName);

      if (isMassage) {
        const prefNote = `Therapist preference: ${therapistPreference.toLowerCase()}`;
        appointmentNotes = appointmentNotes ? `${appointmentNotes} | ${prefNote}` : prefNote;
        console.log(`[BookService] Added therapist preference to massage service: ${serviceName}`);
      } else {
        console.log(`[BookService] Skipping therapist preference for non-massage service: ${serviceName}`);
      }
    }

    // Build appointment
    const appointmentPayload: Record<string, any> = {
      calendarId,
      locationId,
      contactId,
      startTime: startISO,
      endTime: endISO,
      title: toTitleCase(serviceName),
      appointmentStatus: "confirmed",
      notes: appointmentNotes || undefined,
    };

    // BUG FIX: Assign to specific staff member so they show as booked
    // This ensures subsequent bookings use different available staff
    if (staffUserId) {
      appointmentPayload.assignedUserId = staffUserId;
      console.log(`[BookService] Assigning appointment to staff userId: ${staffUserId}`);
    }

    // DEBUG: Log exact payload being sent to GHL
    console.log(`[BookService] ===== GHL APPOINTMENT REQUEST =====`);
    console.log(`[BookService] Full payload:`, JSON.stringify(appointmentPayload, null, 2));
    console.log(`[BookService] Notes field value:`, JSON.stringify(appointmentNotes));
    console.log(`[BookService] Notes field type:`, typeof appointmentNotes);
    console.log(`[BookService] assignedUserId:`, staffUserId || "(none)");

    const appointmentResp = await client.post(
      "/calendars/events/appointments",
      appointmentPayload,
      { headers: { Version: "2021-07-28" } }
    );

    console.log(`[BookService] ===== CREATE APPOINTMENT RESPONSE =====`);
    console.log(`[BookService] Status:`, appointmentResp.status);
    console.log(`[BookService] Response:`, JSON.stringify(appointmentResp.data, null, 2));

    const appointmentId =
      appointmentResp.data?.id ||
      appointmentResp.data?.event?.id ||
      appointmentResp.data?.eventId ||
      appointmentResp.data?.appointment?.id ||
      null;

    // GHL has a SEPARATE "Appointment Notes" entity that shows in the UI
    // The "notes" field on the appointment object doesn't display in the GHL calendar view
    // We need to call POST /calendars/appointments/:appointmentId/notes to add visible notes
    if (appointmentId && appointmentNotes) {
      try {
        const notePayload = { body: appointmentNotes };
        console.log(`[BookService] ===== ADDING APPOINTMENT NOTE =====`);
        console.log(`[BookService] Notes API URL: /calendars/appointments/${appointmentId}/notes`);
        console.log(`[BookService] Notes API payload:`, JSON.stringify(notePayload));

        const noteResp = await client.post(
          `/calendars/appointments/${appointmentId}/notes`,
          notePayload,
          { headers: { Version: "2021-07-28" } }
        );
        console.log(`[BookService] Notes API status:`, noteResp.status);
        console.log(`[BookService] Notes API response:`, JSON.stringify(noteResp.data));
      } catch (noteErr: any) {
        // Don't fail the booking if note creation fails, just log it
        console.error(`[BookService] Notes API FAILED:`);
        console.error(`[BookService] Status:`, noteErr?.response?.status);
        console.error(`[BookService] Error:`, JSON.stringify(noteErr?.response?.data || noteErr.message));
      }
    } else {
      console.log(`[BookService] Skipping Notes API: appointmentNotes="${appointmentNotes}", appointmentId="${appointmentId}"`);
    }

    console.log(`[BookService] ===== SUCCESS: ${serviceName} =====`);
    console.log(`[BookService] Appointment ID: ${appointmentId}`);
    console.log(`[BookService] End time: ${endISO}`);

    return {
      success: true,
      appointmentId,
      endTime: endISO,
      bufferEnd: bufferEndISO,
    };
  } catch (err: any) {
    console.error(`[BookService] ===== FATAL ERROR: ${serviceName} =====`);
    console.error(`[BookService] Error message:`, err.message);
    console.error(`[BookService] Stack trace:`, err.stack);
    console.error(`[BookService] Response status:`, err?.response?.status);
    console.error(`[BookService] Response data:`, JSON.stringify(err?.response?.data));

    return {
      success: false,
      error: err?.response?.data?.message || err.message,
    };
  }
}

/**
 * Normalize phone number for booking.
 */
function normalizePhoneForBooking(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return "+" + digits;
  }
  if (digits.length === 10) {
    return "+1" + digits;
  }
  return "+" + digits;
}

/**
 * Format time for voice output.
 */
function formatTimeForVoice(date: Date, tz: string): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  };
  return date.toLocaleTimeString("en-US", options);
}

/**
 * Build a voice-friendly confirmation message.
 */
function buildPackageConfirmation(
  packageName: string,
  appointments: Array<{ service: string; date?: string; start_time?: string }>,
  price: number | null,
  tz: string
): string {
  if (appointments.length === 0) return "";

  // Format the date
  const firstDate = appointments[0].date;
  let dateStr = "";
  if (firstDate) {
    const d = new Date(firstDate + "T12:00:00");
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const dayOfWeek = dayNames[d.getDay()];
    const month = monthNames[d.getMonth()];
    const dayNum = d.getDate();
    const ordinal = getOrdinal(dayNum);
    dateStr = `${dayOfWeek}, ${month} ${dayNum}${ordinal}`;
  }

  // Format service times
  const serviceTimes = appointments.map((a) => {
    const serviceName = a.service.split(" - ")[0]; // Remove duration from service name
    return `${serviceName} at ${a.start_time?.toLowerCase()}`;
  });

  let timeList = "";
  if (serviceTimes.length === 1) {
    timeList = serviceTimes[0];
  } else if (serviceTimes.length === 2) {
    timeList = `${serviceTimes[0]} and ${serviceTimes[1]}`;
  } else {
    timeList = serviceTimes.slice(0, -1).join(", ") + ", and " + serviceTimes[serviceTimes.length - 1];
  }

  // Format price
  let priceStr = "";
  if (price) {
    priceStr = ` Total is ${spellOutPrice(price)}.`;
  }

  return `Your ${packageName} is booked for ${dateStr}. ${timeList}.${priceStr}`;
}

/**
 * Get ordinal suffix for a number.
 */
function getOrdinal(n: number): string {
  if (n > 3 && n < 21) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

/**
 * Spell out a price for voice.
 */
function spellOutPrice(price: number): string {
  const dollars = Math.floor(price);
  const cents = Math.round((price - dollars) * 100);

  if (cents === 0) {
    return `${spellOutNumber(dollars)} dollars`;
  }
  return `${spellOutNumber(dollars)} dollars and ${cents} cents`;
}

/**
 * Spell out a number for voice (simplified).
 */
function spellOutNumber(n: number): string {
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

  if (n < 20) return ones[n];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return tens[t] + (o > 0 ? "-" + ones[o] : "");
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const remainder = n % 100;
    return ones[h] + " hundred" + (remainder > 0 ? " " + spellOutNumber(remainder) : "");
  }
  // For larger numbers, just return the number
  return n.toString();
}

export default router;
