import { supabase } from "./supabase";
import {
  Installation,
  GHLTokenResponse,
  BusinessInfo,
  ServiceMapping,
  SyncedCalendar,
  SyncedTeamMember,
  SyncStatus,
  GHLCalendar,
  SpaPackage,
} from "./types";

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

// =============================================================================
// SYNC TABLES
// =============================================================================

const SYNCED_CALENDARS_TABLE = "synced_calendars";
const SYNCED_TEAM_MEMBERS_TABLE = "synced_team_members";
const SYNC_STATUS_TABLE = "sync_status";

/**
 * Get sync status for a location.
 */
export async function getSyncStatus(locationId: string): Promise<SyncStatus | null> {
  const { data, error } = await supabase
    .from(SYNC_STATUS_TABLE)
    .select("*")
    .eq("location_id", locationId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    console.error("[DB] getSyncStatus error:", error);
    return null;
  }

  return data as SyncStatus;
}

/**
 * Update sync status.
 */
export async function updateSyncStatus(
  locationId: string,
  updates: Partial<SyncStatus>
): Promise<void> {
  const { error } = await supabase
    .from(SYNC_STATUS_TABLE)
    .upsert(
      {
        location_id: locationId,
        ...updates,
      },
      { onConflict: "location_id" }
    );

  if (error) {
    console.error("[DB] updateSyncStatus error:", error);
  }
}

/**
 * Get all synced calendars for a location.
 */
export async function getSyncedCalendars(locationId: string): Promise<SyncedCalendar[]> {
  const { data, error } = await supabase
    .from(SYNCED_CALENDARS_TABLE)
    .select("*")
    .eq("location_id", locationId)
    .eq("is_active", true)
    .order("calendar_name");

  if (error) {
    console.error("[DB] getSyncedCalendars error:", error);
    return [];
  }

  return (data || []) as SyncedCalendar[];
}

/**
 * Get a synced calendar by ID.
 */
export async function getSyncedCalendarById(
  locationId: string,
  calendarId: string
): Promise<SyncedCalendar | null> {
  const { data, error } = await supabase
    .from(SYNCED_CALENDARS_TABLE)
    .select("*")
    .eq("location_id", locationId)
    .eq("calendar_id", calendarId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    console.error("[DB] getSyncedCalendarById error:", error);
    return null;
  }

  return data as SyncedCalendar;
}

/**
 * Get synced calendars matching a service name.
 */
export async function getSyncedCalendarsForService(
  locationId: string,
  serviceName: string
): Promise<SyncedCalendar[]> {
  const { data, error } = await supabase
    .from(SYNCED_CALENDARS_TABLE)
    .select("*")
    .eq("location_id", locationId)
    .eq("is_active", true)
    .ilike("calendar_name", `%${serviceName}%`);

  if (error) {
    console.error("[DB] getSyncedCalendarsForService error:", error);
    return [];
  }

  return (data || []) as SyncedCalendar[];
}

/**
 * Get team members for a calendar.
 */
export async function getSyncedTeamMembers(
  locationId: string,
  calendarId?: string
): Promise<SyncedTeamMember[]> {
  let query = supabase
    .from(SYNCED_TEAM_MEMBERS_TABLE)
    .select("*")
    .eq("location_id", locationId);

  if (calendarId) {
    query = query.eq("calendar_id", calendarId);
  }

  const { data, error } = await query.order("priority");

  if (error) {
    console.error("[DB] getSyncedTeamMembers error:", error);
    return [];
  }

  return (data || []) as SyncedTeamMember[];
}

/**
 * Get all unique staff names for a location.
 */
export async function getUniqueStaffNames(locationId: string): Promise<string[]> {
  const members = await getSyncedTeamMembers(locationId);
  const names = new Set<string>();
  for (const m of members) {
    if (m.user_name) names.add(m.user_name);
  }
  return Array.from(names).sort();
}

/**
 * Get calendars assigned to a specific staff member (by name).
 * Performs a case-insensitive partial match on user_name.
 */
export async function getCalendarsForStaffMember(
  locationId: string,
  staffName: string
): Promise<SyncedTeamMember[]> {
  const { data, error } = await supabase
    .from(SYNCED_TEAM_MEMBERS_TABLE)
    .select("*")
    .eq("location_id", locationId)
    .ilike("user_name", `%${staffName}%`);

  if (error) {
    console.error("[DB] getCalendarsForStaffMember error:", error);
    return [];
  }

  return (data || []) as SyncedTeamMember[];
}

/**
 * Get team members by gender for a specific calendar.
 * Used for therapist_preference filtering.
 */
export async function getTeamMembersByGender(
  locationId: string,
  calendarId: string,
  gender: "male" | "female"
): Promise<SyncedTeamMember[]> {
  const { data, error } = await supabase
    .from(SYNCED_TEAM_MEMBERS_TABLE)
    .select("*")
    .eq("location_id", locationId)
    .eq("calendar_id", calendarId)
    .eq("gender", gender)
    .order("priority");

  if (error) {
    console.error("[DB] getTeamMembersByGender error:", error);
    return [];
  }

  return (data || []) as SyncedTeamMember[];
}

/**
 * Update team member gender.
 */
export async function updateTeamMemberGender(
  locationId: string,
  odMember: string,
  gender: "male" | "female" | null
): Promise<boolean> {
  const { error } = await supabase
    .from(SYNCED_TEAM_MEMBERS_TABLE)
    .update({ gender })
    .eq("location_id", locationId)
    .eq("id", odMember);

  if (error) {
    console.error("[DB] updateTeamMemberGender error:", error);
    return false;
  }

  return true;
}

/**
 * Get all unique team members for a location (deduplicated by user_id).
 */
export async function getUniqueTeamMembers(
  locationId: string
): Promise<SyncedTeamMember[]> {
  const { data, error } = await supabase
    .from(SYNCED_TEAM_MEMBERS_TABLE)
    .select("*")
    .eq("location_id", locationId)
    .order("user_name");

  if (error) {
    console.error("[DB] getUniqueTeamMembers error:", error);
    return [];
  }

  // Deduplicate by user_id, keeping first occurrence
  const seen = new Set<string>();
  const unique: SyncedTeamMember[] = [];
  for (const member of (data || []) as SyncedTeamMember[]) {
    if (!seen.has(member.user_id)) {
      seen.add(member.user_id);
      unique.push(member);
    }
  }

  return unique;
}

/**
 * Clear all synced data for a location.
 */
export async function clearSyncedData(locationId: string): Promise<void> {
  await supabase
    .from(SYNCED_TEAM_MEMBERS_TABLE)
    .delete()
    .eq("location_id", locationId);

  await supabase
    .from(SYNCED_CALENDARS_TABLE)
    .delete()
    .eq("location_id", locationId);
}

/**
 * Upsert synced calendars and team members from GHL API response.
 */
export async function upsertSyncedCalendars(
  locationId: string,
  calendars: GHLCalendar[]
): Promise<{ calendarsCount: number; teamMembersCount: number }> {
  let calendarsCount = 0;
  let teamMembersCount = 0;

  for (const cal of calendars) {
    // Upsert calendar
    const calendarRow: Partial<SyncedCalendar> = {
      location_id: locationId,
      calendar_id: cal.id,
      calendar_name: cal.name,
      calendar_type: cal.calendarType || "unknown",
      slot_duration: cal.slotDuration || 60,
      slot_buffer: cal.slotBuffer || 0,
      open_hours: cal.openHours || null,
      is_active: cal.isActive !== false,
      raw_data: cal,
      synced_at: new Date().toISOString(),
    };

    const { error: calError } = await supabase
      .from(SYNCED_CALENDARS_TABLE)
      .upsert(calendarRow, { onConflict: "location_id,calendar_id" });

    if (calError) {
      console.error("[DB] upsertSyncedCalendars calendar error:", calError);
    } else {
      calendarsCount++;
    }

    // Upsert team members - check multiple possible field names
    const calAny = cal as any;
    const teamMembers = cal.teamMembers || calAny.team || calAny.users || calAny.assignedUsers || calAny.members || calAny.staff || calAny.selectedTeam || [];

    console.log(`[DB] Calendar "${cal.name}" team members field check: teamMembers=${!!cal.teamMembers}, team=${!!calAny.team}, users=${!!calAny.users}, assignedUsers=${!!calAny.assignedUsers}, found ${teamMembers.length} members`);

    if (teamMembers && teamMembers.length > 0) {
      for (const tm of teamMembers) {
        // Handle different field name conventions
        const userId = tm.userId || tm.user_id || tm.id;
        const userName = tm.name || tm.userName || tm.user_name || tm.firstName || null;
        const userEmail = tm.email || tm.userEmail || tm.user_email || null;
        const isPrimary = tm.isPrimary || tm.is_primary || tm.primary || false;
        const priority = Math.floor(Number(tm.priority || tm.order || 0));

        if (!userId) {
          console.log(`[DB] Skipping team member with no userId:`, JSON.stringify(tm));
          continue;
        }

        const memberRow: Partial<SyncedTeamMember> = {
          location_id: locationId,
          calendar_id: cal.id,
          user_id: userId,
          user_name: userName,
          user_email: userEmail,
          is_primary: isPrimary,
          priority: priority,
          synced_at: new Date().toISOString(),
        };

        const { error: tmError } = await supabase
          .from(SYNCED_TEAM_MEMBERS_TABLE)
          .upsert(memberRow, { onConflict: "location_id,calendar_id,user_id" });

        if (tmError) {
          console.error("[DB] upsertSyncedCalendars team member error:", tmError);
        } else {
          teamMembersCount++;
        }
      }
    }
  }

  // Update sync status
  await updateSyncStatus(locationId, {
    last_sync_at: new Date().toISOString(),
    sync_in_progress: false,
    error_message: null,
    calendars_count: calendarsCount,
    team_members_count: teamMembersCount,
  });

  console.log(`[DB] Synced ${calendarsCount} calendars, ${teamMembersCount} team members for ${locationId}`);

  return { calendarsCount, teamMembersCount };
}

/**
 * Get all location IDs that need syncing.
 */
export async function getLocationsNeedingSync(maxAgeMinutes: number = 10): Promise<string[]> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

  // Get all installations
  const { data: installations, error: instError } = await supabase
    .from(TABLE)
    .select("location_id");

  if (instError || !installations) {
    console.error("[DB] getLocationsNeedingSync error:", instError);
    return [];
  }

  const locationIds = installations.map((i: any) => i.location_id);

  // Get sync status for all
  const { data: statuses } = await supabase
    .from(SYNC_STATUS_TABLE)
    .select("location_id, last_sync_at, sync_in_progress")
    .in("location_id", locationIds);

  const statusMap = new Map<string, { last_sync_at: string | null; sync_in_progress: boolean }>();
  for (const s of (statuses || [])) {
    statusMap.set(s.location_id, s);
  }

  // Find locations needing sync
  const needsSync: string[] = [];
  for (const locId of locationIds) {
    const status = statusMap.get(locId);
    if (!status) {
      // Never synced
      needsSync.push(locId);
    } else if (status.sync_in_progress) {
      // Already syncing, skip
      continue;
    } else if (!status.last_sync_at || status.last_sync_at < cutoff) {
      // Stale sync
      needsSync.push(locId);
    }
  }

  return needsSync;
}

// =============================================================================
// SPA PACKAGES
// =============================================================================

const SPA_PACKAGES_TABLE = "spa_packages";

/**
 * Get all packages for a location.
 */
export async function getPackages(locationId: string): Promise<SpaPackage[]> {
  const { data, error } = await supabase
    .from(SPA_PACKAGES_TABLE)
    .select("*")
    .eq("location_id", locationId)
    .eq("is_active", true)
    .order("package_name");

  if (error) {
    console.error("[DB] getPackages error:", error);
    return [];
  }

  return (data || []) as SpaPackage[];
}

/**
 * Get a package by name (case-insensitive partial match).
 */
export async function getPackageByName(
  locationId: string,
  packageName: string
): Promise<SpaPackage | null> {
  const { data, error } = await supabase
    .from(SPA_PACKAGES_TABLE)
    .select("*")
    .eq("location_id", locationId)
    .eq("is_active", true)
    .ilike("package_name", `%${packageName}%`);

  if (error) {
    console.error("[DB] getPackageByName error:", error);
    return null;
  }

  // Return first match (or null if no matches)
  return (data && data.length > 0) ? data[0] as SpaPackage : null;
}

/**
 * Get a package by ID.
 */
export async function getPackageById(id: string): Promise<SpaPackage | null> {
  const { data, error } = await supabase
    .from(SPA_PACKAGES_TABLE)
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    console.error("[DB] getPackageById error:", error);
    return null;
  }

  return data as SpaPackage;
}

/**
 * Create or update a package.
 */
export async function upsertPackage(pkg: Partial<SpaPackage>): Promise<SpaPackage | null> {
  const { data, error } = await supabase
    .from(SPA_PACKAGES_TABLE)
    .upsert(
      {
        location_id: pkg.location_id,
        package_name: pkg.package_name,
        services: pkg.services,
        total_duration_minutes: pkg.total_duration_minutes || null,
        price: pkg.price || null,
        description: pkg.description || null,
        is_active: pkg.is_active !== false,
      },
      { onConflict: "location_id,package_name" }
    )
    .select()
    .single();

  if (error) {
    console.error("[DB] upsertPackage error:", error);
    return null;
  }

  console.log(`[DB] Upserted package: ${pkg.package_name}`);
  return data as SpaPackage;
}

/**
 * Delete a package by ID (soft delete - sets is_active to false).
 */
export async function deletePackage(id: string): Promise<boolean> {
  const { error } = await supabase
    .from(SPA_PACKAGES_TABLE)
    .update({ is_active: false })
    .eq("id", id);

  if (error) {
    console.error("[DB] deletePackage error:", error);
    return false;
  }

  console.log(`[DB] Deleted package: ${id}`);
  return true;
}

/**
 * Hard delete a package by ID.
 */
export async function hardDeletePackage(id: string): Promise<boolean> {
  const { error } = await supabase
    .from(SPA_PACKAGES_TABLE)
    .delete()
    .eq("id", id);

  if (error) {
    console.error("[DB] hardDeletePackage error:", error);
    return false;
  }

  return true;
}
