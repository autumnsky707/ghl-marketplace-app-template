import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import axios from "axios";
import { GHL } from "./ghl";
import { json } from "body-parser";
import { updateCalendarInfo } from "./db";
import calendarRoutes from "./routes/calendar";
import { syncLocation, startPolling } from "./sync";

const path = __dirname + "/ui/dist/";

dotenv.config();
const app: Express = express();
app.use(json({ type: "application/json" }));
app.use(express.static(path));

const ghl = new GHL();
const port = process.env.PORT;

// Settings panel URL for redirect after OAuth
const SETTINGS_PANEL_URL = "https://booknexaai.com/spawidget-settings";

/**
 * OAuth Initiation - Redirects user to GHL's OAuth authorization page
 * Uses the exact URL format required by GHL marketplace
 * URL includes: response_type, redirect_uri, client_id, and scope
 */
app.get("/initiate-auth", (req: Request, res: Response) => {
  const clientId = process.env.GHL_APP_CLIENT_ID;

  if (!clientId) {
    console.error("[OAuth] GHL_APP_CLIENT_ID is not set in environment variables");
    return res.status(500).send("OAuth not configured - missing client_id");
  }

  // Exact URL format for GHL OAuth with properly encoded parameters
  const redirectUri = "https%3A%2F%2Fbooknexaai-oauth.onrender.com%2Fauthorize-handler";
  const scope = "calendars.readonly+calendars.write+calendars%2Fevents.readonly+calendars%2Fevents.write+contacts.readonly+contacts.write+locations.readonly";

  const authUrl = `https://marketplace.leadconnectorhq.com/oauth/chooselocation?response_type=code&redirect_uri=${redirectUri}&client_id=${clientId}&scope=${scope}`;

  console.log(`[OAuth] Initiating auth flow`);
  console.log(`[OAuth] Client ID: ${clientId}`);
  console.log(`[OAuth] Redirect URL: ${authUrl}`);

  res.redirect(authUrl);
});

/**
 * OAuth Authorization Handler
 * 1. Exchange code for tokens (saved to Supabase automatically)
 * 2. Fetch location timezone
 * 3. Fetch calendars and pick the first one
 * 4. Update Supabase with calendar_id + timezone
 * 5. Redirect to GHL
 */
app.get("/authorize-handler", async (req: Request, res: Response) => {
  const { code } = req.query;

  try {
    // Step 1: Exchange code for tokens (persisted to Supabase in ghl.authorizationHandler)
    const tokenData = await ghl.authorizationHandler(code as string);
    const locationId = tokenData.locationId;

    if (!locationId) {
      console.warn("[OAuth] No locationId in token response, skipping calendar setup");
      return res.redirect(`${SETTINGS_PANEL_URL}?connected=true`);
    }

    console.log(`[OAuth] Token exchange successful for location: ${locationId}`);

    // Step 2: Fetch location timezone
    let timezone = "America/New_York"; // default
    try {
      const client = await ghl.requests(locationId);
      const locationResp = await client.get(`/locations/${locationId}`, {
        headers: { Version: "2021-07-28" },
      });
      timezone = locationResp.data?.location?.timezone || timezone;
      console.log(`[OAuth] Location timezone: ${timezone}`);
    } catch (err: any) {
      console.error("[OAuth] Failed to fetch location timezone:", err?.response?.data || err.message);
    }

    // Step 3: Fetch calendars and pick the first one
    let calendarId: string | null = null;
    try {
      const client = await ghl.requests(locationId);
      const calResp = await client.get(`/calendars/?locationId=${locationId}`, {
        headers: { Version: "2021-07-28" },
      });
      const calendars = calResp.data?.calendars || [];
      if (calendars.length > 0) {
        calendarId = calendars[0].id;
        console.log(`[OAuth] Found ${calendars.length} calendar(s), using: ${calendarId}`);
      } else {
        console.warn("[OAuth] No calendars found for location");
      }
    } catch (err: any) {
      console.error("[OAuth] Failed to fetch calendars:", err?.response?.data || err.message);
    }

    // Step 4: Update Supabase with calendar info
    if (calendarId) {
      await updateCalendarInfo(locationId, calendarId, timezone);
    }

    // Step 5: Trigger full calendar sync (runs in background)
    syncLocation(locationId)
      .then((result) => {
        console.log(`[OAuth] Auto-sync complete: ${result.calendars} calendars, ${result.teamMembers} team members`);
      })
      .catch((err) => {
        console.error("[OAuth] Auto-sync failed:", err.message);
      });

    console.log(`[OAuth] Installation complete for ${locationId}`);

    // Redirect to package setup page so client can configure their packages
    // After setup, they can go to the settings panel
    const setupUrl = `https://booknexaai-oauth.onrender.com/setup/packages?locationId=${encodeURIComponent(locationId)}&connected=true`;
    return res.redirect(setupUrl);
  } catch (error: any) {
    console.error("[OAuth] Authorization failed:", error?.response?.data || error.message);
    return res.redirect(`${SETTINGS_PANEL_URL}?error=connection_failed`);
  }
});

/**
 * Reconnect endpoint - Re-establishes OAuth connection for a location
 * 1. Calls GHL /oauth/reconnect to get a new authorization code
 * 2. Exchanges code for tokens
 * 3. Saves tokens to Supabase
 */
app.get("/reconnect", async (req: Request, res: Response) => {
  const locationId = "NNFCwckEhjBk90UtMRSp";
  const clientKey = "69781ba5abd7383fdc8d8d30-mkyfiexk";
  const clientSecret = process.env.GHL_APP_CLIENT_SECRET;

  if (!clientSecret) {
    console.error("[Reconnect] GHL_APP_CLIENT_SECRET is not set");
    return res.status(500).json({ success: false, error: "Missing client secret" });
  }

  try {
    console.log(`[Reconnect] Starting reconnect for location: ${locationId}`);

    // Step 1: Call /oauth/reconnect to get authorization code
    const reconnectResp = await axios.post(
      "https://services.leadconnectorhq.com/oauth/reconnect",
      {
        clientKey,
        clientSecret,
        locationId,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const authorizationCode = reconnectResp.data?.authorizationCode;
    if (!authorizationCode) {
      console.error("[Reconnect] No authorizationCode in response:", reconnectResp.data);
      return res.status(400).json({ success: false, error: "No authorization code returned", data: reconnectResp.data });
    }

    console.log(`[Reconnect] Got authorization code, exchanging for tokens...`);

    // Step 2: Exchange code for tokens (uses the same handler as normal OAuth)
    const tokenData = await ghl.authorizationHandler(authorizationCode);

    console.log(`[Reconnect] Token exchange successful for location: ${tokenData.locationId}`);

    // Step 3: Fetch and update calendar info
    let timezone = "America/New_York";
    let calendarId: string | null = null;

    try {
      const client = await ghl.requests(locationId);
      const locationResp = await client.get(`/locations/${locationId}`, {
        headers: { Version: "2021-07-28" },
      });
      timezone = locationResp.data?.location?.timezone || timezone;
    } catch (err: any) {
      console.error("[Reconnect] Failed to fetch timezone:", err?.response?.data || err.message);
    }

    try {
      const client = await ghl.requests(locationId);
      const calResp = await client.get(`/calendars/?locationId=${locationId}`, {
        headers: { Version: "2021-07-28" },
      });
      const calendars = calResp.data?.calendars || [];
      if (calendars.length > 0) {
        calendarId = calendars[0].id;
      }
    } catch (err: any) {
      console.error("[Reconnect] Failed to fetch calendars:", err?.response?.data || err.message);
    }

    if (calendarId) {
      await updateCalendarInfo(locationId, calendarId, timezone);
    }

    console.log(`[Reconnect] Reconnection complete for ${locationId}`);

    return res.json({
      success: true,
      message: "Reconnection successful",
      locationId: tokenData.locationId,
      calendarId,
      timezone,
    });
  } catch (error: any) {
    console.error("[Reconnect] Failed:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data?.message || error.message,
      details: error?.response?.data,
    });
  }
});

// Mount calendar API routes
app.use("/api/calendar", calendarRoutes);

// SSO decryption
app.post("/decrypt-sso", async (req: Request, res: Response) => {
  const { key } = req.body || {};
  if (!key) {
    return res.status(400).send("Please send valid key");
  }
  try {
    const data = ghl.decryptSSOData(key);
    res.send(data);
  } catch (error) {
    res.status(400).send("Invalid Key");
    console.log(error);
  }
});

// Webhook handler
app.post("/example-webhook-handler", async (req: Request, res: Response) => {
  console.log(req.body);
  res.sendStatus(200);
});

// Serve frontend
app.get("/", function (req, res) {
  res.sendFile(path + "index.html");
});

// Package setup page (self-service for clients)
app.get("/setup/packages", function (req, res) {
  res.sendFile(__dirname + "/setup-packages.html");
});

// Staff setup page (gender assignment for therapist preferences)
app.get("/setup/staff", function (req, res) {
  res.sendFile(__dirname + "/setup-staff.html");
});

app.listen(port, () => {
  console.log(`GHL app listening on port ${port}`);

  // Start polling for calendar sync every 10 minutes
  startPolling(10 * 60 * 1000);
});
