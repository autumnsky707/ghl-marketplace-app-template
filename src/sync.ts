import axios from "axios";
import { GHL } from "./ghl";
import {
  getInstallation,
  getSyncStatus,
  updateSyncStatus,
  upsertSyncedCalendars,
  clearSyncedData,
  getLocationsNeedingSync,
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

    // Debug: Log raw response structure to find team member field
    if (calendars.length > 0) {
      const sampleCal = calendars[0];
      console.log(`[Sync] Sample calendar keys:`, Object.keys(sampleCal));
      console.log(`[Sync] Sample calendar raw:`, JSON.stringify(sampleCal, null, 2));

      // Check possible field names for team members
      const possibleFields = ['teamMembers', 'team', 'users', 'assignedUsers', 'members', 'staff', 'selectedTeam'];
      for (const field of possibleFields) {
        if ((sampleCal as any)[field]) {
          console.log(`[Sync] Found team data in field "${field}":`, JSON.stringify((sampleCal as any)[field], null, 2));
        }
      }
    }

    // Clear old data and insert new
    await clearSyncedData(locationId);
    const { calendarsCount, teamMembersCount } = await upsertSyncedCalendars(locationId, calendars);

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
