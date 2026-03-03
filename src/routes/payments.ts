/**
 * BookNexa AI - Stripe Payment Routes
 * Handles Stripe Connect OAuth, payment settings, and payment intents
 */

import express, { Router, Request, Response } from "express";
import Stripe from "stripe";
import { supabase } from "../supabase";

const router = Router();

// Demo location ID - always uses test keys
const DEMO_LOCATION_ID = "NNFCwckEhjBk90UtMRSp";

// Initialize Stripe instances for test and live modes
const stripeTest = new Stripe(process.env.STRIPE_TEST_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
});

const stripeLive = new Stripe(process.env.STRIPE_LIVE_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
});

// Helper to get correct Stripe instance and keys based on locationId
function getStripeConfig(locationId: string) {
  const isDemo = locationId === DEMO_LOCATION_ID;
  return {
    stripe: isDemo ? stripeTest : stripeLive,
    publishableKey: isDemo
      ? process.env.STRIPE_TEST_PUBLISHABLE_KEY
      : process.env.STRIPE_LIVE_PUBLISHABLE_KEY,
    secretKey: isDemo
      ? process.env.STRIPE_TEST_SECRET_KEY
      : process.env.STRIPE_LIVE_SECRET_KEY,
    clientId: isDemo
      ? process.env.STRIPE_TEST_CLIENT_ID
      : process.env.STRIPE_LIVE_CLIENT_ID,
    webhookSecret: isDemo
      ? process.env.STRIPE_TEST_WEBHOOK_SECRET
      : process.env.STRIPE_LIVE_WEBHOOK_SECRET,
    isTestMode: isDemo,
  };
}

/**
 * GET /api/payments/settings/:locationId
 * Fetch payment settings for a location (called by widget on load)
 * Does NOT return stripe_account_id (security)
 */
router.get("/settings/:locationId", async (req: Request, res: Response) => {
  const { locationId } = req.params;

  try {
    // Use SELECT * so new columns (like deposits_required) are automatically included
    const { data, error } = await supabase
      .from("payment_settings")
      .select("*")
      .eq("location_id", locationId)
      .single();

    if (error && error.code !== "PGRST116") {
      // PGRST116 = no rows found
      console.error("[Payments] Error fetching settings:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    // Build settings from data, stripping sensitive fields (stripe_account_id)
    // NOTE: deposit_amount defaults to 0 - business MUST configure their own amount
    const defaults = {
      payments_enabled: false,
      deposits_required: false,
      pay_ahead_enabled: false,
      apply_to: "both",
      auto_require_above: false,
      auto_require_amount: 0,
      deposit_type: "fixed",
      deposit_amount: 0,
      unpaid_policy: "dont_confirm",
      spa_phone: null,
      current_promotions: null,
    };

    const settings = data
      ? {
          payments_enabled: data.payments_enabled ?? false,
          deposits_required: data.deposits_required ?? false,
          pay_ahead_enabled: data.pay_ahead_enabled ?? false,
          apply_to: data.apply_to ?? "both",
          auto_require_above: data.auto_require_above ?? false,
          auto_require_amount: data.auto_require_amount ?? 0,
          deposit_type: data.deposit_type ?? "fixed",
          deposit_amount: data.deposit_amount ?? 0,
          unpaid_policy: data.unpaid_policy ?? "dont_confirm",
          spa_phone: data.spa_phone ?? null,
          current_promotions: data.current_promotions ?? null,
        }
      : defaults;

    // Add test mode flag for widget to show banner
    const { isTestMode } = getStripeConfig(locationId);

    return res.json({
      success: true,
      settings: {
        ...settings,
        isTestMode,
      },
    });
  } catch (error: any) {
    console.error("[Payments] Settings fetch error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/payments/settings
 * Save payment settings for a location (called by settings page)
 */
router.post("/settings", async (req: Request, res: Response) => {
  const {
    locationId,
    payments_enabled,
    deposits_required,
    apply_to,
    auto_require_above,
    auto_require_amount,
    deposit_type,
    deposit_amount,
    unpaid_policy,
    pay_ahead_enabled,
    spa_phone,
    current_promotions,
  } = req.body;

  if (!locationId) {
    return res.status(400).json({ success: false, error: "Missing locationId" });
  }

  try {
    const { error } = await supabase.from("payment_settings").upsert(
      {
        location_id: locationId,
        payments_enabled: payments_enabled ?? false,
        deposits_required: deposits_required ?? false,
        apply_to: apply_to ?? "both",
        auto_require_above: auto_require_above ?? false,
        auto_require_amount: auto_require_amount ?? 0,
        deposit_type: deposit_type ?? "fixed",
        deposit_amount: deposit_amount ?? 0,
        unpaid_policy: unpaid_policy ?? "dont_confirm",
        pay_ahead_enabled: pay_ahead_enabled ?? false,
        spa_phone: spa_phone ?? null,
        current_promotions: current_promotions ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "location_id" }
    );

    if (error) {
      console.error("[Payments] Error saving settings:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    console.log(`[Payments] Settings saved for location: ${locationId}`);
    return res.json({ success: true });
  } catch (error: any) {
    console.error("[Payments] Settings save error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/payments/connect-status/:locationId
 * Check if a location has connected their Stripe account
 */
router.get("/connect-status/:locationId", async (req: Request, res: Response) => {
  const { locationId } = req.params;

  try {
    const { data, error } = await supabase
      .from("payment_settings")
      .select("stripe_account_id")
      .eq("location_id", locationId)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("[Payments] Error checking connect status:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    const isConnected = !!(data?.stripe_account_id);

    // If connected, get account details
    let accountName = null;
    if (isConnected && data.stripe_account_id) {
      try {
        const { stripe } = getStripeConfig(locationId);
        const account = await stripe.accounts.retrieve(data.stripe_account_id);
        accountName = account.business_profile?.name || account.email || "Connected Account";
      } catch (e) {
        console.error("[Payments] Error fetching account details:", e);
      }
    }

    return res.json({
      success: true,
      isConnected,
      accountName,
    });
  } catch (error: any) {
    console.error("[Payments] Connect status error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/stripe/connect
 * Initiate Stripe Connect OAuth flow
 */
router.get("/stripe/connect", async (req: Request, res: Response) => {
  const { locationId } = req.query;

  if (!locationId) {
    return res.status(400).send("Missing locationId");
  }

  // Get the correct client ID based on location (test vs live)
  const { clientId, isTestMode } = getStripeConfig(locationId as string);
  if (!clientId) {
    console.error("[Stripe] Missing STRIPE_TEST_CLIENT_ID or STRIPE_LIVE_CLIENT_ID");
    return res.status(500).send("Stripe Connect not configured");
  }

  const redirectUri = `${process.env.RENDER_URL || "https://booknexaai-oauth.onrender.com"}/api/payments/stripe/connect/callback`;

  // Build Stripe Connect OAuth URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "read_write",
    redirect_uri: redirectUri,
    state: locationId as string, // Pass locationId in state to retrieve after callback
  });

  const connectUrl = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;

  console.log(`[Stripe] Initiating Connect OAuth for location: ${locationId} (${isTestMode ? 'TEST' : 'LIVE'} mode)`);
  res.redirect(connectUrl);
});

/**
 * GET /api/payments/stripe/connect/callback
 * Handle Stripe Connect OAuth callback
 */
router.get("/stripe/connect/callback", async (req: Request, res: Response) => {
  const { code, state: locationId, error, error_description } = req.query;

  // Handle OAuth errors
  if (error) {
    console.error(`[Stripe] OAuth error: ${error} - ${error_description}`);
    return res.redirect(
      `https://booknexaai.com/spawidget-settings-page?stripe_error=${encodeURIComponent(error_description as string || error as string)}`
    );
  }

  if (!code || !locationId) {
    return res.redirect(
      "https://booknexaai.com/spawidget-settings-page?stripe_error=missing_params"
    );
  }

  try {
    const { stripe, isTestMode } = getStripeConfig(locationId as string);

    // Exchange authorization code for connected account ID
    const response = await stripe.oauth.token({
      grant_type: "authorization_code",
      code: code as string,
    });

    const stripeAccountId = response.stripe_user_id;

    if (!stripeAccountId) {
      throw new Error("No stripe_user_id in response");
    }

    console.log(`[Stripe] Connected account ${stripeAccountId} for location ${locationId}`);

    // Save to Supabase — also set payments_enabled since Stripe is now connected
    const { error: dbError } = await supabase.from("payment_settings").upsert(
      {
        location_id: locationId,
        stripe_account_id: stripeAccountId,
        payments_enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "location_id" }
    );

    if (dbError) {
      console.error("[Stripe] Error saving account to database:", dbError);
      throw new Error("Failed to save Stripe account");
    }

    // Redirect back to settings page with success
    return res.redirect(
      `https://booknexaai.com/spawidget-settings-page?stripe_connected=true`
    );
  } catch (error: any) {
    console.error("[Stripe] Connect callback error:", error.message);
    return res.redirect(
      `https://booknexaai.com/spawidget-settings-page?stripe_error=${encodeURIComponent(error.message)}`
    );
  }
});

/**
 * POST /api/payments/stripe/disconnect
 * Disconnect Stripe account from a location
 */
router.post("/stripe/disconnect", async (req: Request, res: Response) => {
  const { locationId } = req.body;

  if (!locationId) {
    return res.status(400).json({ success: false, error: "Missing locationId" });
  }

  try {
    // Remove stripe_account_id from database
    const { error } = await supabase
      .from("payment_settings")
      .update({
        stripe_account_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("location_id", locationId);

    if (error) {
      console.error("[Stripe] Error disconnecting:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    console.log(`[Stripe] Disconnected account for location: ${locationId}`);
    return res.json({ success: true });
  } catch (error: any) {
    console.error("[Stripe] Disconnect error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/payments/create-intent
 * Create a PaymentIntent for collecting a deposit
 */
router.post("/create-intent", async (req: Request, res: Response) => {
  const { locationId, amount, customerEmail, bookingDetails } = req.body;

  if (!locationId || !amount) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: locationId, amount",
    });
  }

  try {
    // Get Stripe config for this location
    const { stripe, publishableKey, isTestMode } = getStripeConfig(locationId);

    // Get the connected account ID for this location
    const { data: settings, error: dbError } = await supabase
      .from("payment_settings")
      .select("stripe_account_id")
      .eq("location_id", locationId)
      .single();

    if (dbError && dbError.code !== "PGRST116") {
      console.error("[Payments] Error fetching stripe account:", dbError);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    // For demo/test mode without connected account, create payment directly
    // For live mode, require connected account
    const stripeAccountId = settings?.stripe_account_id;

    if (!isTestMode && !stripeAccountId) {
      return res.status(400).json({
        success: false,
        error: "Business has not connected their Stripe account",
      });
    }

    // Build PaymentIntent params
    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: Math.round(amount), // Amount in cents
      currency: "usd",
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        locationId,
        bookingDetails: JSON.stringify(bookingDetails || {}),
      },
    };

    // Add receipt email if provided
    if (customerEmail) {
      intentParams.receipt_email = customerEmail;
    }

    // Create PaymentIntent
    let paymentIntent: Stripe.PaymentIntent;

    if (stripeAccountId) {
      // Connected account - funds go directly to business
      paymentIntent = await stripe.paymentIntents.create(intentParams, {
        stripeAccount: stripeAccountId,
      });
    } else {
      // Test mode without connected account - for demo purposes
      paymentIntent = await stripe.paymentIntents.create(intentParams);
    }

    console.log(
      `[Payments] Created PaymentIntent ${paymentIntent.id} for $${(amount / 100).toFixed(2)} (${isTestMode ? "TEST" : "LIVE"})`
    );

    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      publishableKey,
      isTestMode,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error: any) {
    console.error("[Payments] Create intent error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/payments/webhook
 * Handle Stripe webhook events
 */
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"];

    if (!sig) {
      return res.status(400).send("Missing stripe-signature header");
    }

    // Try both webhook secrets (test and live)
    let event: Stripe.Event | null = null;
    let isTestEvent = false;

    // Try test webhook secret first
    if (process.env.STRIPE_TEST_WEBHOOK_SECRET) {
      try {
        event = stripeTest.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_TEST_WEBHOOK_SECRET
        );
        isTestEvent = true;
      } catch (e) {
        // Not a test webhook, try live
      }
    }

    // Try live webhook secret
    if (!event && process.env.STRIPE_LIVE_WEBHOOK_SECRET) {
      try {
        event = stripeLive.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_LIVE_WEBHOOK_SECRET
        );
        isTestEvent = false;
      } catch (e) {
        console.error("[Webhook] Signature verification failed");
        return res.status(400).send("Webhook signature verification failed");
      }
    }

    if (!event) {
      return res.status(400).send("Could not verify webhook signature");
    }

    console.log(`[Webhook] Received ${event.type} (${isTestEvent ? "TEST" : "LIVE"})`);

    // Handle specific events
    switch (event.type) {
      case "payment_intent.succeeded":
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log(
          `[Webhook] Payment succeeded: ${paymentIntent.id} for $${(paymentIntent.amount / 100).toFixed(2)}`
        );
        // The widget handles booking finalization after payment success
        // This webhook is for logging/backup purposes
        break;

      case "payment_intent.payment_failed":
        const failedIntent = event.data.object as Stripe.PaymentIntent;
        console.log(
          `[Webhook] Payment failed: ${failedIntent.id} - ${failedIntent.last_payment_error?.message}`
        );
        break;

      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }

    return res.json({ received: true });
  }
);


// ========================================
// DEPOSIT SETTINGS ENDPOINTS (for setup page)
// ========================================

/**
 * GET /api/payments/deposit-settings
 * Get global deposit settings (formatted for setup page)
 */
router.get("/deposit-settings", async (req: Request, res: Response) => {
  const { locationId } = req.query;

  if (!locationId) {
    return res.status(400).json({ success: false, error: "Missing locationId" });
  }

  try {
    const { data, error } = await supabase
      .from("payment_settings")
      .select("*")
      .eq("location_id", locationId)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("[Deposits] Error fetching settings:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    // Map to format expected by setup page / settings panel
    // Use deposits_required column (separate from payments_enabled which tracks Stripe connection)
    const settings = data ? {
      requireDeposits: data.deposits_required ?? data.payments_enabled ?? false,
      payAheadEnabled: data.pay_ahead_enabled ?? false,
      applyTo: data.apply_to,
      autoThresholdEnabled: data.auto_require_above,
      autoThresholdAmount: (data.auto_require_amount || 0) / 100, // Convert cents to dollars
      defaultType: data.deposit_type,
      defaultAmountFixed: data.deposit_type === 'fixed' ? (data.deposit_amount || 0) / 100 : 0,
      defaultAmountPercent: data.deposit_type === 'percentage' ? data.deposit_amount : 25,
      notPaidAction: data.unpaid_policy,
      spaPhone: data.spa_phone,
      currentPromotions: data.current_promotions
    } : {
      requireDeposits: false,
      payAheadEnabled: false,
      applyTo: 'both',
      autoThresholdEnabled: false,
      autoThresholdAmount: 100,
      defaultType: 'fixed',
      defaultAmountFixed: 50,
      defaultAmountPercent: 25,
      notPaidAction: 'dont_confirm',
      spaPhone: null,
      currentPromotions: null
    };

    return res.json({ success: true, settings });
  } catch (error: any) {
    console.error("[Deposits] Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/payments/deposit-settings
 * Save global deposit settings from the settings panel / demo page
 * Maps frontend depositSettings object to payment_settings DB columns
 */
router.post("/deposit-settings", async (req: Request, res: Response) => {
  const { locationId, settings } = req.body;

  if (!locationId || !settings) {
    return res.status(400).json({ success: false, error: "Missing locationId or settings" });
  }

  try {
    // Map frontend deposit settings to database columns
    const depositAmount = settings.defaultType === 'fixed'
      ? Math.round((settings.defaultAmountFixed || 0) * 100) // dollars → cents
      : (settings.defaultAmountPercent || 0); // percentage stored as-is

    const updateData: Record<string, any> = {
      location_id: locationId,
      deposits_required: !!settings.requireDeposits,
      pay_ahead_enabled: !!settings.payAheadEnabled,
      auto_require_above: !!settings.autoThresholdEnabled,
      auto_require_amount: Math.round((settings.autoThresholdAmount || 0) * 100), // dollars → cents
      deposit_type: settings.defaultType || 'fixed',
      deposit_amount: depositAmount,
      updated_at: new Date().toISOString(),
    };

    // Also save phone and promotions if provided
    if (settings.spaPhone !== undefined) {
      updateData.spa_phone = settings.spaPhone;
    }
    if (settings.currentPromotions !== undefined) {
      updateData.current_promotions = settings.currentPromotions;
    }

    const { error } = await supabase
      .from("payment_settings")
      .upsert(updateData, { onConflict: "location_id" });

    if (error) {
      console.error("[Deposits] Error saving settings:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    console.log(`[Deposits] Settings saved for location: ${locationId}`, {
      deposits_required: updateData.deposits_required,
      deposit_type: updateData.deposit_type,
      deposit_amount: updateData.deposit_amount,
      pay_ahead_enabled: updateData.pay_ahead_enabled,
    });

    return res.json({ success: true });
  } catch (error: any) {
    console.error("[Deposits] Save error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/payments/deposit-overrides
 * Get per-package deposit overrides
 */
router.get("/deposit-overrides", async (req: Request, res: Response) => {
  const { locationId } = req.query;

  if (!locationId) {
    return res.status(400).json({ success: false, error: "Missing locationId" });
  }

  try {
    const { data, error } = await supabase
      .from("package_deposit_overrides")
      .select("*")
      .eq("location_id", locationId);

    if (error) {
      console.error("[Deposits] Error fetching overrides:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    return res.json({ success: true, overrides: data || [] });
  } catch (error: any) {
    console.error("[Deposits] Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/payments/deposit-overrides
 * Save per-package deposit override
 */
router.post("/deposit-overrides", async (req: Request, res: Response) => {
  const { locationId, packageId, override } = req.body;

  if (!locationId || !packageId) {
    return res.status(400).json({ success: false, error: "Missing locationId or packageId" });
  }

  try {
    const { error } = await supabase
      .from("package_deposit_overrides")
      .upsert({
        location_id: locationId,
        package_id: packageId,
        override_enabled: override?.override_enabled ?? false,
        require_deposit: override?.require_deposit ?? true,
        deposit_type: override?.deposit_type ?? 'fixed',
        deposit_amount_fixed: Math.round((override?.deposit_amount_fixed || 50) * 100), // Convert to cents
        deposit_amount_percent: override?.deposit_amount_percent ?? 25,
        not_paid_action: override?.not_paid_action ?? 'hold_24h',
        updated_at: new Date().toISOString()
      }, { onConflict: "location_id,package_id" });

    if (error) {
      console.error("[Deposits] Error saving override:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    console.log(`[Deposits] Override saved for package: ${packageId}`);
    return res.json({ success: true });
  } catch (error: any) {
    console.error("[Deposits] Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
