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

/**
 * POST /api/calendar/free-slots
 * Check available time slots for a calendar.
 *
 * Body: { locationId, startDate, endDate, timezone? }
 */
router.post("/free-slots", async (req: Request, res: Response) => {
  try {
    const { locationId, startDate, endDate, timezone } = req.body as FreeSlotsRequest;

    if (!locationId || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: locationId, startDate, endDate",
      });
    }

    const installation = await getInstallation(locationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    if (!installation.calendar_id) {
      return res.status(400).json({ success: false, error: "No calendar configured for this location" });
    }

    const tz = timezone || installation.timezone || "America/New_York";

    // Convert dates to Unix milliseconds for GHL API
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();

    const slotsUrl = `/calendars/${installation.calendar_id}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=${encodeURIComponent(tz)}`;

    console.log("[Calendar] ===== FREE SLOTS REQUEST =====");
    console.log("[Calendar] URL:", slotsUrl);
    console.log("[Calendar] calendarId:", installation.calendar_id);
    console.log("[Calendar] startDate:", startDate, "->", startMs);
    console.log("[Calendar] endDate:", endDate, "->", endMs);
    console.log("[Calendar] timezone:", tz);

    const client = await ghl.requests(locationId);
    const resp = await client.get(slotsUrl, {
      headers: { Version: "2021-07-28" },
    });

    // Log raw GHL response to see exactly what slots are returned
    const rawData = resp.data;
    console.log("[Calendar] ===== FREE SLOTS RAW RESPONSE =====");
    console.log("[Calendar] Response keys:", Object.keys(rawData));

    // Log each date and its slots to identify weekend slots
    const slots = rawData?.slots || rawData;
    if (typeof slots === "object" && slots !== null) {
      const dateKeys = Object.keys(slots).sort();
      console.log(`[Calendar] Dates returned: ${dateKeys.length}`);
      for (const dateKey of dateKeys) {
        const daySlots = slots[dateKey];
        const slotCount = Array.isArray(daySlots) ? daySlots.length : "N/A";
        const dayOfWeek = new Date(dateKey).toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
        const isWeekend = ["Saturday", "Sunday"].includes(dayOfWeek);
        console.log(`[Calendar]   ${dateKey} (${dayOfWeek})${isWeekend ? " *** WEEKEND ***" : ""}: ${slotCount} slots`);
        if (isWeekend && Array.isArray(daySlots) && daySlots.length > 0) {
          console.log(`[Calendar]   ^^^ WEEKEND SLOTS RETURNED BY GHL:`, JSON.stringify(daySlots.slice(0, 3)));
        }
      }
    } else {
      console.log("[Calendar] Raw response (not object):", JSON.stringify(rawData).slice(0, 500));
    }

    return res.json({
      success: true,
      data: rawData,
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
 * GET /api/calendar/business-hours
 * Fetch the calendar's availability schedule and return it formatted for speech.
 *
 * Query: ?locationId=xxx or ?calendarId=xxx&locationId=xxx
 */
router.get("/business-hours", async (req: Request, res: Response) => {
  try {
    const locationId = req.query.locationId as string;
    const calendarIdParam = req.query.calendarId as string | undefined;

    if (!locationId) {
      return res.status(400).json({ success: false, error: "Missing required query param: locationId" });
    }

    const installation = await getInstallation(locationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    const calId = calendarIdParam || installation.calendar_id;
    if (!calId) {
      return res.status(400).json({ success: false, error: "No calendar configured for this location" });
    }

    const client = await ghl.requests(locationId);

    // Fetch the calendar object which contains openHours
    console.log(`[Calendar] Fetching business hours for calendar: ${calId}`);
    const calResp = await client.get(`/calendars/${calId}`, {
      headers: { Version: "2021-07-28" },
    });

    const calData = calResp.data?.calendar || calResp.data;
    console.log("[Calendar] ===== CALENDAR RAW RESPONSE =====");
    console.log("[Calendar] Top-level keys:", Object.keys(calResp.data || {}));
    console.log("[Calendar] calData keys:", Object.keys(calData || {}));
    console.log("[Calendar] Full calData:", JSON.stringify(calData, null, 2).slice(0, 2000));

    // openHours on the calendar object is often an empty {} -- hours
    // live on the team member's user schedule instead.
    let openHours: OpenHoursEntry[] = Array.isArray(calData?.openHours)
      ? calData.openHours
      : [];

    // If no hours on calendar, look up the team member's schedule
    if (openHours.length === 0) {
      const teamMembers: any[] = calData?.teamMembers || [];
      const userId = teamMembers[0]?.userId;

      if (userId) {
        console.log(`[Calendar] No openHours on calendar, fetching schedule for userId: ${userId}`);
        try {
          // List schedules filtered by location and userId
          const schedResp = await client.get(
            `/calendars/schedules?locationId=${locationId}&userId=${userId}`,
            { headers: { Version: "2021-07-28" } }
          );
          const schedules = schedResp.data?.schedules || schedResp.data?.data || [];
          console.log(`[Calendar] Found ${Array.isArray(schedules) ? schedules.length : 0} schedule(s)`);

          if (Array.isArray(schedules) && schedules.length > 0) {
            const schedule = schedules[0];
            console.log("[Calendar] Schedule:", JSON.stringify(schedule, null, 2).slice(0, 2000));

            openHours = Array.isArray(schedule?.openHours)
              ? schedule.openHours
              : Array.isArray(schedule?.rules)
                ? schedule.rules
                : [];
          }
        } catch (schedErr: any) {
          console.error("[Calendar] Schedule lookup failed:", schedErr?.response?.status, schedErr?.response?.data || schedErr.message);
        }
      }

      // Fallback: try the event-calendar schedule endpoint
      if (openHours.length === 0) {
        try {
          const ecResp = await client.get(`/calendars/schedules/event-calendar/${calId}`, {
            headers: { Version: "2021-07-28" },
          });
          const ecData = ecResp.data?.data || ecResp.data?.schedule || ecResp.data;
          console.log("[Calendar] Event-calendar schedule:", JSON.stringify(ecData, null, 2).slice(0, 2000));

          openHours = Array.isArray(ecData?.openHours)
            ? ecData.openHours
            : Array.isArray(ecData?.rules)
              ? ecData.rules
              : [];
        } catch (ecErr: any) {
          console.error("[Calendar] Event-calendar schedule failed:", ecErr?.response?.status, ecErr?.response?.data || ecErr.message);
        }
      }
    }

    if (openHours.length === 0) {
      return res.json({
        success: true,
        formatted: "Business hours are not configured for this calendar.",
        raw: [],
      });
    }

    const formatted = formatBusinessHoursForSpeech(openHours);

    return res.json({
      success: true,
      formatted,
      raw: openHours,
    });
  } catch (error: any) {
    console.error("[Calendar] business-hours error:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data?.message || error.message,
    });
  }
});

// --- Business hours formatting helpers ---

interface OpenHoursEntry {
  daysOfTheWeek: number[];
  hours: { openHour: number; openMinute: number; closeHour: number; closeMinute: number }[];
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  if (minute === 0) return `${h} ${period}`;
  const m = minute.toString().padStart(2, "0");
  return `${h}:${m} ${period}`;
}

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

function formatBusinessHoursForSpeech(openHours: OpenHoursEntry[]): string {
  const parts: string[] = [];

  for (const entry of openHours) {
    const dayRange = formatDayRange(entry.daysOfTheWeek);
    const timeRanges = entry.hours.map(
      (h) => `${formatTimeForSpeech(h.openHour, h.openMinute)} to ${formatTimeForSpeech(h.closeHour, h.closeMinute)}`
    );
    parts.push(`${dayRange}, ${timeRanges.join(" and ")}`);
  }

  return parts.join(". ");
}

/**
 * POST /api/calendar/book
 * Create or upsert a GHL contact, then book an appointment.
 *
 * Body: { locationId, calendarId?, startTime, customerName, customerEmail, customerPhone?, title?, notes? }
 */
router.post("/book", async (req: Request, res: Response) => {
  try {
    const {
      locationId,
      calendarId,
      startTime,
      customerName,
      customerEmail,
      customerPhone,
      serviceType,
      therapistPreference,
      occasion,
      title,
      notes,
    } = req.body as BookAppointmentRequest;

    if (!locationId || !startTime || !customerName || !customerEmail) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: locationId, startTime, customerName, customerEmail",
      });
    }

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
