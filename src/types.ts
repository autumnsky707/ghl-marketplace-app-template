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
  locationId: string;
  startDate: string;  // ISO date string, e.g. "2026-02-01"
  endDate: string;
  timezone?: string;
}

export interface BookAppointmentRequest {
  locationId: string;
  contactId: string;
  startTime: string;       // ISO 8601 datetime
  endTime: string;
  title?: string;
  appointmentStatus?: string;
  assignedUserId?: string;
  notes?: string;
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
