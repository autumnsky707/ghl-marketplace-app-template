import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import { GHL } from "./ghl";
import { json } from "body-parser";
import { updateCalendarInfo } from "./db";
import calendarRoutes from "./routes/calendar";

const path = __dirname + "/ui/dist/";

dotenv.config();
const app: Express = express();
app.use(json({ type: "application/json" }));
app.use(express.static(path));

const ghl = new GHL();
const port = process.env.PORT;

// Settings panel URL for redirect after OAuth
const SETTINGS_PANEL_URL = "https://booknexaai.com/widget-settings";

/**
 * OAuth Initiation - Redirects user to GHL's OAuth authorization page
 * Uses the exact URL format required by GHL marketplace
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

    console.log(`[OAuth] Installation complete for ${locationId}`);
  } catch (error: any) {
    console.error("[OAuth] Authorization failed:", error?.response?.data || error.message);
  }

  // Redirect back to settings panel with connected=true
  res.redirect(`${SETTINGS_PANEL_URL}?connected=true`);
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

app.listen(port, () => {
  console.log(`GHL app listening on port ${port}`);
});
