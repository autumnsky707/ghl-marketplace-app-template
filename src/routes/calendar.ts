import { Router, Request, Response } from "express";
import axios from "axios";
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
  const m = parseInt(match[2], 10);
  return h > 12 || (h === 12 && m >= 15);
}

function getSlotMinutes(iso: string): number {
  const match = iso.match(/T(\d{2}):(\d{2})/);
  if (!match) return 0;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function parseTimeToMinutes(timeStr: string): number | null {
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

    // Build services list: prefer synced data, fall back to manual config
    const servicesList = syncedServices.length > 0 ? syncedServices : (info?.services || ["massage", "facial", "body treatment"]);

    return res.json({
      success: true,
      business_name: info?.business_name || "Our Spa",
      services: servicesList,
      staff: staffNames,
      packages: packages.map((p) => ({
        name: p.package_name,
        services: p.services,
        total_duration_minutes: p.total_duration_minutes,
        price: p.price,
        description: p.description,
      })),
      greeting: info?.greeting || "Welcome! How can I help you today?",
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
 * Smart availability check for voice agents with multi-calendar support.
 *
 * Body: { locationId, service_type?, staff_name?, time_preference?, requested_date?, requested_time?, start_after? }
 * Response: { success: true, slots: [{ date, time, label, startTime, staff_name?, calendar_id? }] }
 *
 * When staff_name is provided:
 * - Look up that staff member in synced_team_members
 * - Only check availability on calendars they're assigned to
 * - Return only that staff member's slots
 *
 * When start_after is provided (for multi-service booking):
 * - Only return slots that START at or after this time
 * - Format: ISO timestamp (e.g., "2026-02-06T14:00:00-10:00")
 */
router.post("/check-availability", async (req: Request, res: Response) => {
  try {
    const { locationId, location_id, service_type, staff_name, time_preference, requested_date, requested_time, start_after } = req.body;
    const resolvedLocationId = locationId || location_id;

    if (!resolvedLocationId) {
      return res.status(400).json({ success: false, error: "Missing required field: locationId" });
    }

    const installation = await getInstallation(resolvedLocationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

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

      // If service_type is also provided, filter to calendars that match both
      if (service_type) {
        const syncedCals = await getSyncedCalendarsForService(resolvedLocationId, service_type);
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
        console.log(`[Calendar] Found ${calendarsToCheck.length} calendars for staff "${staff_name}" + service "${service_type}"`);
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
    } else if (service_type) {
      // Service type only - existing logic
      const syncedCals = await getSyncedCalendarsForService(resolvedLocationId, service_type);
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
        console.log(`[Calendar] Found ${calendarsToCheck.length} synced calendars for service "${service_type}"`);
      } else {
        // Fall back to manual service mappings
        const mappings = await getCalendarsForService(resolvedLocationId, service_type);
        if (mappings.length > 0) {
          calendarsToCheck = mappings.map((m) => ({
            calendar_id: m.calendar_id,
            calendar_name: null,
            staff_name: m.staff_name,
            staff_id: null,
          }));
          console.log(`[Calendar] Found ${calendarsToCheck.length} manual mappings for service "${service_type}"`);
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

    // Use the location's configured timezone (fallback to Hawaii)
    const tz = installation.timezone || "Pacific/Honolulu";
    const localNow = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
    const todayStr = localNow.toISOString().split("T")[0];
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

      const slotsUrl = `${process.env.GHL_API_DOMAIN}/calendars/${calendarId}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=${encodeURIComponent(tz)}`;
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
    const dateFilter = requested_date ? parseDateRequest(requested_date) : null;

    // Determine time filter function
    let timeFilterFn: ((slot: string) => boolean) | null = null;
    if (time_preference) {
      const pref = time_preference.toLowerCase();
      timeFilterFn = pref === "morning" ? isSlotMorning : isSlotAfternoon;
    }

    // Target time for sorting (if requested_time is provided)
    const targetMins = requested_time ? parseTimeToMinutes(requested_time) : null;

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

      // If specific time requested, collect ALL matching slots and sort by proximity
      if (targetMins !== null) {
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
            allSlots.push({ date: dateKey, slotInfo, diff });
          }
        }

        // Sort by proximity to requested time
        allSlots.sort((a, b) => a.diff - b.diff);

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

    // Look up calendar settings for duration and buffer (for multi-service booking)
    let slotDuration = 60; // default 60 minutes
    let slotBuffer = 0;    // default 0 minutes buffer
    const syncedCalendar = await getSyncedCalendarById(locationId, resolvedCalendarId);
    if (syncedCalendar) {
      slotDuration = syncedCalendar.slot_duration || 60;
      slotBuffer = syncedCalendar.slot_buffer || 0;
      console.log(`[Calendar] Calendar settings: duration=${slotDuration}min, buffer=${slotBuffer}min`);
    }

    // Allow override via request body
    const durationMinutes = body.duration_minutes || body.durationMinutes || slotDuration;

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
    const startTimeMs = new Date(startTime).getTime();
    // Calculate end time based on duration (from calendar settings or override)
    const endTimeMs = startTimeMs + durationMinutes * 60 * 1000;
    const endISO = new Date(endTimeMs).toISOString();
    // Calculate buffer_end for multi-service booking (when next service can start)
    const bufferEndMs = endTimeMs + slotBuffer * 60 * 1000;
    const bufferEndISO = new Date(bufferEndMs).toISOString();

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

    // 6. Return success with timing info for multi-service booking
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

export default router;
