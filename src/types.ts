export interface Installation {
  location_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string; // ISO 8601 timestamp
  calendar_id: string | null;
  timezone: string | null;
  scope: string | null;
  user_type: string | null;
  company_id: string | null;
}

export interface GHLTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  userType: string;
  companyId?: string;
  locationId?: string;
}

export interface FreeSlotsRequest {
  // Required - accepts both camelCase and snake_case
  locationId?: string;
  location_id?: string;

  // New simplified params (server auto-calculates dates)
  time_preference?: "morning" | "afternoon" | "any";  // morning = before 12pm, afternoon = 12pm+
  duration_minutes?: number;  // how far ahead to search (converted to days)

  // Legacy params (still supported for backwards compatibility)
  startDate?: string;  // ISO date string, e.g. "2026-02-01"
  endDate?: string;

  timezone?: string;
}

export interface BookAppointmentRequest {
  // Accepts both camelCase and snake_case for all fields
  locationId?: string;
  location_id?: string;
  calendarId?: string;
  calendar_id?: string;
  startTime?: string;        // ISO 8601 datetime
  start_time?: string;
  customerName?: string;
  customer_name?: string;
  customerEmail?: string;
  customer_email?: string;
  customerPhone?: string;
  customer_phone?: string;
  serviceType?: string;          // e.g. "Deep Tissue Massage"
  service_type?: string;
  therapistPreference?: string;  // e.g. "Female"
  therapist_preference?: string;
  occasion?: string;             // e.g. "Birthday"
  title?: string;
  notes?: string;
  action?: string;  // Ignored - sent by ElevenLabs
}

export interface CancelAppointmentRequest {
  locationId: string;
  eventId: string;
}

export interface RescheduleAppointmentRequest {
  locationId: string;
  eventId: string;
  startTime: string;
  endTime: string;
}
