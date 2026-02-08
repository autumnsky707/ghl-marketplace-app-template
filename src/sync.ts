import axios from "axios";
import { GHL } from "./ghl";
import {
  getInstallation,
  getSyncStatus,
  updateSyncStatus,
  upsertSyncedCalendars,
  clearSyncedData,
  getLocationsNeedingSync,
  getExistingGenders,
} from "./db";
import { GHLCalendarResponse } from "./types";

const ghl = new GHL();

/**
 * Sync calendars from GHL for a location.
 * Returns counts of synced calendars and team members.
 */
export async function syncLocation(
  locationId: string
): Promise<{ success: boolean; calendars: number; teamMembers: number; error?: string }> {
  console.log(`[Sync] Starting sync for location: ${locationId}`);

  try {
    // Check if sync is already in progress
    const status = await getSyncStatus(locationId);
    if (status?.sync_in_progress) {
      console.log(`[Sync] Sync already in progress for ${locationId}, skipping`);
      return { success: false, calendars: 0, teamMembers: 0, error: "Sync already in progress" };
    }

    // Mark sync as in progress
    await updateSyncStatus(locationId, { sync_in_progress: true, error_message: null });

    // Get installation for access token
    const installation = await getInstallation(locationId);
    if (!installation) {
      await updateSyncStatus(locationId, {
        sync_in_progress: false,
        error_message: "Installation not found",
      });
      return { success: false, calendars: 0, teamMembers: 0, error: "Installation not found" };
    }

    // Fetch calendars from GHL
    const calendarsUrl = `${process.env.GHL_API_DOMAIN}/calendars/?locationId=${locationId}`;
    let resp;

    try {
      resp = await axios.get<GHLCalendarResponse>(calendarsUrl, {
        headers: {
          Authorization: `Bearer ${installation.access_token}`,
          Version: "2021-07-28",
        },
      });
    } catch (err: any) {
      // If 401, try refreshing token
      if (err?.response?.status === 401) {
        console.log(`[Sync] Token expired for ${locationId}, refreshing...`);
        const client = await ghl.requests(locationId);
        resp = await client.get<GHLCalendarResponse>(calendarsUrl, {
          headers: { Version: "2021-07-28" },
        });
      } else {
        throw err;
      }
    }

    const calendars = resp.data?.calendars || [];
    console.log(`[Sync] Fetched ${calendars.length} calendars for ${locationId}`);

    // Collect all unique userIds from team members across all calendars
    const userIds = new Set<string>();
    for (const cal of calendars) {
      const calAny = cal as any;
      const teamMembers = cal.teamMembers || calAny.team || calAny.users || calAny.assignedUsers || calAny.members || calAny.staff || calAny.selectedTeam || [];
      for (const tm of teamMembers) {
        const userId = tm.userId || tm.user_id || tm.id;
        if (userId) userIds.add(userId);
      }
    }

    console.log(`[Sync] Found ${userIds.size} unique team members, fetching user details...`);

    // Fetch ALL users for this location in one API call
    const userDetailsMap = new Map<string, { name: string; email: string }>();
    const client = await ghl.requests(locationId);

    try {
      console.log(`[Sync] Fetching users from GET /users/?locationId=${locationId}`);
      const usersResp = await client.get(`/users/?locationId=${locationId}`, {
        headers: { Version: "2021-07-28" },
      });

      console.log(`[Sync] Users API response:`, JSON.stringify(usersResp.data, null, 2));

      // Extract users array from response
      const users = usersResp.data?.users || usersResp.data || [];

      if (Array.isArray(users)) {
        for (const user of users) {
          const userId = user.id || user.userId;
          if (!userId) continue;

          const name = user.name ||
                       (user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : null) ||
                       user.firstName ||
                       user.lastName ||
                       null;
          const email = user.email || null;

          if (name) {
            userDetailsMap.set(userId, { name, email });
            console.log(`[Sync] User ${userId}: ${name} (${email})`);
          }
        }
      }

      console.log(`[Sync] Loaded ${userDetailsMap.size} users from location`);
    } catch (err: any) {
      console.log(`[Sync] Users API failed:`, err?.response?.status || err.message);
      if (err?.response?.data) {
        console.log(`[Sync] Error response:`, JSON.stringify(err.response.data, null, 2));
      }
    }

    // Preserve existing gender values before clearing
    const existingGenders = await getExistingGenders(locationId);

    // Clear old data and insert new (with preserved genders)
    await clearSyncedData(locationId);
    const { calendarsCount, teamMembersCount } = await upsertSyncedCalendars(locationId, calendars, userDetailsMap, existingGenders);

    console.log(`[Sync] Sync complete for ${locationId}: ${calendarsCount} calendars, ${teamMembersCount} team members`);

    return { success: true, calendars: calendarsCount, teamMembers: teamMembersCount };
  } catch (error: any) {
    const errorMsg = error?.response?.data?.message || error.message || "Unknown error";
    console.error(`[Sync] Sync failed for ${locationId}:`, errorMsg);

    await updateSyncStatus(locationId, {
      sync_in_progress: false,
      error_message: errorMsg,
    });

    return { success: false, calendars: 0, teamMembers: 0, error: errorMsg };
  }
}

/**
 * Run sync for all locations that need it.
 * Respects rate limits by staggering requests.
 */
export async function syncAllLocations(): Promise<void> {
  const locations = await getLocationsNeedingSync(10); // 10 minutes stale threshold

  if (locations.length === 0) {
    console.log("[Sync] No locations need syncing");
    return;
  }

  console.log(`[Sync] Starting sync for ${locations.length} locations`);

  // Process in batches to respect rate limits (100 req/10 sec)
  // Each sync makes 1 API call, so we can do ~50 per batch with margin
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 2000; // 2 seconds between batches

  for (let i = 0; i < locations.length; i += BATCH_SIZE) {
    const batch = locations.slice(i, i + BATCH_SIZE);

    // Sync batch in parallel
    await Promise.all(batch.map((locId) => syncLocation(locId)));

    // Delay before next batch
    if (i + BATCH_SIZE < locations.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  console.log(`[Sync] Completed sync for ${locations.length} locations`);
}

// Polling interval reference
let pollingInterval: NodeJS.Timeout | null = null;

/**
 * Start the polling system.
 * Runs syncAllLocations every intervalMs.
 */
export function startPolling(intervalMs: number = 10 * 60 * 1000): void {
  if (pollingInterval) {
    console.log("[Sync] Polling already running");
    return;
  }

  console.log(`[Sync] Starting polling every ${intervalMs / 1000} seconds`);

  // Run immediately
  syncAllLocations().catch((err) => console.error("[Sync] Polling error:", err));

  // Then run on interval
  pollingInterval = setInterval(() => {
    syncAllLocations().catch((err) => console.error("[Sync] Polling error:", err));
  }, intervalMs);
}

/**
 * Stop the polling system.
 */
export function stopPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log("[Sync] Polling stopped");
  }
}
