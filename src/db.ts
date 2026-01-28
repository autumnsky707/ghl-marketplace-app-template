import { supabase } from "./supabase";
import { Installation, GHLTokenResponse } from "./types";

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
