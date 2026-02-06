import { supabase } from "./supabase";
import { Installation, GHLTokenResponse, BusinessInfo, ServiceMapping } from "./types";

const TABLE = "ghl_installations";

/**
 * Upsert an installation record after OAuth token exchange.
 */
export async function upsertInstallation(data: GHLTokenResponse): Promise<void> {
  const resourceId = data.locationId || data.companyId;
  if (!resourceId) {
    throw new Error("No locationId or companyId in token response");
  }

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  const { error } = await supabase
    .from(TABLE)
    .upsert(
      {
        location_id: resourceId,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_expires_at: expiresAt,
        scope: data.scope || null,
        user_type: data.userType || null,
        company_id: data.companyId || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "location_id" }
    );

  if (error) {
    console.error("[DB] upsertInstallation error:", error);
    throw error;
  }

  console.log(`[DB] Upserted installation for ${resourceId}`);
}

/**
 * Get full installation record by location ID.
 */
export async function getInstallation(locationId: string): Promise<Installation | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("location_id", locationId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // not found
    console.error("[DB] getInstallation error:", error);
    throw error;
  }

  return data as Installation;
}

/**
 * Get the access token for a resource.
 */
export async function getAccessToken(resourceId: string): Promise<string | null> {
  const row = await getInstallation(resourceId);
  return row?.access_token || null;
}

/**
 * Get the refresh token for a resource.
 */
export async function getRefreshToken(resourceId: string): Promise<string | null> {
  const row = await getInstallation(resourceId);
  return row?.refresh_token || null;
}

/**
 * Update tokens after a refresh.
 */
export async function updateTokens(
  resourceId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number
): Promise<void> {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  const { error } = await supabase
    .from(TABLE)
    .update({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("location_id", resourceId);

  if (error) {
    console.error("[DB] updateTokens error:", error);
    throw error;
  }

  console.log(`[DB] Tokens refreshed for ${resourceId}`);
}

/**
 * Check if a token is expired or will expire within 5 minutes.
 */
export function isTokenExpired(expiresAt: string): boolean {
  const BUFFER_MS = 5 * 60 * 1000; // 5 minutes
  return new Date(expiresAt).getTime() - BUFFER_MS < Date.now();
}

/**
 * Update calendar ID and timezone after OAuth install.
 */
export async function updateCalendarInfo(
  locationId: string,
  calendarId: string,
  timezone: string
): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({
      calendar_id: calendarId,
      timezone: timezone,
      updated_at: new Date().toISOString(),
    })
    .eq("location_id", locationId);

  if (error) {
    console.error("[DB] updateCalendarInfo error:", error);
    throw error;
  }

  console.log(`[DB] Updated calendar info for ${locationId}: calendar=${calendarId}, tz=${timezone}`);
}

/**
 * Get business info for a location.
 */
export async function getBusinessInfo(locationId: string): Promise<BusinessInfo | null> {
  const installation = await getInstallation(locationId);
  if (!installation) return null;

  if (!installation.business_name) return null;

  return {
    business_name: installation.business_name,
    services: installation.services || [],
    greeting: installation.greeting || `Welcome to ${installation.business_name}`,
  };
}

/**
 * Update business info for a location.
 */
export async function updateBusinessInfo(
  locationId: string,
  businessName: string,
  services: string[],
  greeting: string
): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({
      business_name: businessName,
      services: services,
      greeting: greeting,
      updated_at: new Date().toISOString(),
    })
    .eq("location_id", locationId);

  if (error) {
    console.error("[DB] updateBusinessInfo error:", error);
    throw error;
  }

  console.log(`[DB] Updated business info for ${locationId}: ${businessName}`);
}

const SERVICE_MAPPINGS_TABLE = "service_mappings";

/**
 * Get all service mappings for a location.
 */
export async function getServiceMappings(locationId: string): Promise<ServiceMapping[]> {
  const { data, error } = await supabase
    .from(SERVICE_MAPPINGS_TABLE)
    .select("*")
    .eq("location_id", locationId);

  if (error) {
    console.error("[DB] getServiceMappings error:", error);
    return [];
  }

  return (data || []) as ServiceMapping[];
}

/**
 * Get calendars that offer a specific service.
 */
export async function getCalendarsForService(
  locationId: string,
  serviceName: string
): Promise<ServiceMapping[]> {
  const { data, error } = await supabase
    .from(SERVICE_MAPPINGS_TABLE)
    .select("*")
    .eq("location_id", locationId)
    .ilike("service_name", `%${serviceName}%`);

  if (error) {
    console.error("[DB] getCalendarsForService error:", error);
    return [];
  }

  return (data || []) as ServiceMapping[];
}

/**
 * Get all unique staff/calendars for a location.
 */
export async function getStaffCalendars(locationId: string): Promise<ServiceMapping[]> {
  const { data, error } = await supabase
    .from(SERVICE_MAPPINGS_TABLE)
    .select("*")
    .eq("location_id", locationId);

  if (error) {
    console.error("[DB] getStaffCalendars error:", error);
    return [];
  }

  // Dedupe by calendar_id
  const seen = new Set<string>();
  const unique: ServiceMapping[] = [];
  for (const row of (data || []) as ServiceMapping[]) {
    if (!seen.has(row.calendar_id)) {
      seen.add(row.calendar_id);
      unique.push(row);
    }
  }

  return unique;
}

/**
 * Upsert a service mapping.
 */
export async function upsertServiceMapping(mapping: ServiceMapping): Promise<void> {
  const { error } = await supabase
    .from(SERVICE_MAPPINGS_TABLE)
    .upsert(
      {
        location_id: mapping.location_id,
        service_name: mapping.service_name.toLowerCase(),
        calendar_id: mapping.calendar_id,
        staff_name: mapping.staff_name,
      },
      { onConflict: "location_id,service_name,calendar_id" }
    );

  if (error) {
    console.error("[DB] upsertServiceMapping error:", error);
    throw error;
  }

  console.log(`[DB] Upserted service mapping: ${mapping.service_name} → ${mapping.staff_name}`);
}

/**
 * Delete all service mappings for a location.
 */
export async function deleteServiceMappings(locationId: string): Promise<void> {
  const { error } = await supabase
    .from(SERVICE_MAPPINGS_TABLE)
    .delete()
    .eq("location_id", locationId);

  if (error) {
    console.error("[DB] deleteServiceMappings error:", error);
    throw error;
  }
}

/**
 * Delete a specific service mapping by ID.
 */
export async function deleteServiceMappingById(id: string): Promise<void> {
  const { error } = await supabase
    .from(SERVICE_MAPPINGS_TABLE)
    .delete()
    .eq("id", id);

  if (error) {
    console.error("[DB] deleteServiceMappingById error:", error);
    throw error;
  }
}

/**
 * Bulk set service mappings for a location (replaces all existing).
 */
export async function setServiceMappings(
  locationId: string,
  mappings: Array<{ service_name: string; calendar_id: string; staff_name: string }>
): Promise<void> {
  // Delete existing
  await deleteServiceMappings(locationId);

  // Insert new
  if (mappings.length > 0) {
    const rows = mappings.map((m) => ({
      location_id: locationId,
      service_name: m.service_name.toLowerCase(),
      calendar_id: m.calendar_id,
      staff_name: m.staff_name,
    }));

    const { error } = await supabase.from(SERVICE_MAPPINGS_TABLE).insert(rows);

    if (error) {
      console.error("[DB] setServiceMappings error:", error);
      throw error;
    }
  }

  console.log(`[DB] Set ${mappings.length} service mappings for ${locationId}`);
}
