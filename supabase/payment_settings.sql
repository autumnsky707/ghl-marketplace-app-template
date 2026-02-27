-- BookNexa AI - Payment Settings Table
-- Run this SQL in your Supabase SQL Editor

-- Create payment_settings table
CREATE TABLE IF NOT EXISTS payment_settings (
  location_id TEXT PRIMARY KEY,
  stripe_account_id TEXT,
  payments_enabled BOOLEAN DEFAULT FALSE,
  apply_to TEXT DEFAULT 'both' CHECK (apply_to IN ('packages', 'services', 'both')),
  auto_require_above BOOLEAN DEFAULT FALSE,
  auto_require_amount INTEGER DEFAULT 0,
  deposit_type TEXT DEFAULT 'fixed' CHECK (deposit_type IN ('fixed', 'percentage')),
  deposit_amount INTEGER DEFAULT 0,
  unpaid_policy TEXT DEFAULT 'hold_24h' CHECK (unpaid_policy IN ('hold_24h', 'keep_unpaid', 'dont_confirm')),
  pay_ahead_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on location_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_payment_settings_location ON payment_settings(location_id);

-- Add RLS (Row Level Security) policies
ALTER TABLE payment_settings ENABLE ROW LEVEL SECURITY;

-- Policy to allow the service role full access (for server-side operations)
CREATE POLICY "Service role has full access to payment_settings"
  ON payment_settings
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Add comment for documentation
COMMENT ON TABLE payment_settings IS 'Stores per-business payment/deposit settings for BookNexa AI widget';
COMMENT ON COLUMN payment_settings.location_id IS 'GHL location ID - primary key';
COMMENT ON COLUMN payment_settings.stripe_account_id IS 'Connected Stripe account ID from Stripe Connect OAuth';
COMMENT ON COLUMN payment_settings.payments_enabled IS 'Whether deposits are required for this business';
COMMENT ON COLUMN payment_settings.apply_to IS 'What booking types require deposits: packages, services, or both';
COMMENT ON COLUMN payment_settings.auto_require_above IS 'Whether to only require deposits above a threshold';
COMMENT ON COLUMN payment_settings.auto_require_amount IS 'Threshold amount in cents for auto-require';
COMMENT ON COLUMN payment_settings.deposit_type IS 'fixed = flat amount, percentage = % of service price';
COMMENT ON COLUMN payment_settings.deposit_amount IS 'Deposit amount: cents if fixed, whole number if percentage';
COMMENT ON COLUMN payment_settings.unpaid_policy IS 'What happens if deposit not paid: hold_24h, keep_unpaid, dont_confirm';

-- ========================================
-- Per-Package Deposit Overrides Table
-- ========================================
CREATE TABLE IF NOT EXISTS package_deposit_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  override_enabled BOOLEAN DEFAULT FALSE,
  require_deposit BOOLEAN DEFAULT TRUE,
  deposit_type TEXT DEFAULT 'fixed' CHECK (deposit_type IN ('fixed', 'percentage')),
  deposit_amount_fixed INTEGER DEFAULT 5000,
  deposit_amount_percent INTEGER DEFAULT 25,
  not_paid_action TEXT DEFAULT 'hold_24h' CHECK (not_paid_action IN ('hold_24h', 'keep_unpaid', 'dont_confirm')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(location_id, package_id)
);

CREATE INDEX IF NOT EXISTS idx_package_overrides_location ON package_deposit_overrides(location_id);

ALTER TABLE package_deposit_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role has full access to package_deposit_overrides"
  ON package_deposit_overrides FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE package_deposit_overrides IS 'Per-package deposit settings that override global settings';

-- ========================================
-- MIGRATION: Add pay_ahead_enabled column
-- Run this if you already have the payment_settings table
-- ========================================
-- ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS pay_ahead_enabled BOOLEAN DEFAULT FALSE;
