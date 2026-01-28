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

    const client = await ghl.requests(locationId);
    const resp = await client.get(
      `/calendars/${installation.calendar_id}/free-slots?startDate=${startMs}&endDate=${endMs}&timezone=${encodeURIComponent(tz)}`,
      { headers: { Version: "2021-07-28" } }
    );

    return res.json({
      success: true,
      data: resp.data,
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
 * POST /api/calendar/book
 * Book an appointment.
 *
 * Body: { locationId, contactId, startTime, endTime, title?, appointmentStatus?, assignedUserId?, notes? }
 */
router.post("/book", async (req: Request, res: Response) => {
  try {
    const {
      locationId,
      contactId,
      startTime,
      endTime,
      title,
      appointmentStatus,
      assignedUserId,
      notes,
    } = req.body as BookAppointmentRequest;

    if (!locationId || !contactId || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: locationId, contactId, startTime, endTime",
      });
    }

    const installation = await getInstallation(locationId);
    if (!installation) {
      return res.status(404).json({ success: false, error: "Installation not found" });
    }

    if (!installation.calendar_id) {
      return res.status(400).json({ success: false, error: "No calendar configured for this location" });
    }

    const client = await ghl.requests(locationId);
    const resp = await client.post(
      "/calendars/events/appointments",
      {
        calendarId: installation.calendar_id,
        locationId,
        contactId,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        title: title || "Appointment",
        appointmentStatus: appointmentStatus || "confirmed",
        assignedUserId: assignedUserId || undefined,
        notes: notes || undefined,
      },
      { headers: { Version: "2021-07-28" } }
    );

    return res.json({
      success: true,
      data: resp.data,
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
