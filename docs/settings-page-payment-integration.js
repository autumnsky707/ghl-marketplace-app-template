/**
 * BookNexa AI - Settings Page Payment Integration
 * Add this code to the settings page script section
 */

// ========== PAYMENT SETTINGS INTEGRATION ==========
const PAYMENT_API_BASE = 'https://booknexaai-oauth.onrender.com/api/payments';

// Payment settings state
let paymentSettingsLoaded = false;

// DOM Elements for payment settings
const requireDepositsToggle = document.getElementById('requireDepositsToggle');
const applyToPackages = document.getElementById('applyToPackages');
const applyToServices = document.getElementById('applyToServices');
const applyToBoth = document.getElementById('applyToBoth');
const autoRequireToggle = document.getElementById('autoRequireToggle');
const autoRequireAmount = document.getElementById('autoRequireAmount');
const depositTypeFixed = document.getElementById('depositTypeFixed');
const depositTypePercent = document.getElementById('depositTypePercent');
const depositAmountInput = document.getElementById('depositAmountInput');
const unpaidPolicySelect = document.getElementById('unpaidPolicySelect');
const stripeConnectBtn = document.getElementById('stripeConnectBtn');
const stripeStatus = document.getElementById('stripeStatus');

// Load payment settings from Supabase
async function loadPaymentSettings() {
  if (!locationId || paymentSettingsLoaded) return;

  try {
    // Load payment settings
    const settingsResp = await fetch(`${PAYMENT_API_BASE}/settings/${locationId}`);
    const settingsData = await settingsResp.json();

    if (settingsData.success && settingsData.settings) {
      const s = settingsData.settings;

      // Apply to UI
      if (requireDepositsToggle) requireDepositsToggle.checked = s.payments_enabled;

      // Apply to radio buttons
      if (s.apply_to === 'packages' && applyToPackages) applyToPackages.checked = true;
      else if (s.apply_to === 'services' && applyToServices) applyToServices.checked = true;
      else if (applyToBoth) applyToBoth.checked = true;

      if (autoRequireToggle) autoRequireToggle.checked = s.auto_require_above;
      if (autoRequireAmount) autoRequireAmount.value = (s.auto_require_amount / 100).toFixed(0);

      if (s.deposit_type === 'percentage' && depositTypePercent) depositTypePercent.checked = true;
      else if (depositTypeFixed) depositTypeFixed.checked = true;

      if (depositAmountInput) {
        depositAmountInput.value = s.deposit_type === 'percentage'
          ? s.deposit_amount
          : (s.deposit_amount / 100).toFixed(0);
      }

      if (unpaidPolicySelect) unpaidPolicySelect.value = s.unpaid_policy;

      // Toggle visibility of deposit settings
      toggleDepositSettings(s.payments_enabled);

      console.log('[Settings] Payment settings loaded');
    }

    // Check Stripe Connect status
    const connectResp = await fetch(`${PAYMENT_API_BASE}/connect-status/${locationId}`);
    const connectData = await connectResp.json();

    if (connectData.success) {
      updateStripeConnectUI(connectData.isConnected, connectData.accountName);
    }

    paymentSettingsLoaded = true;
  } catch (e) {
    console.error('[Settings] Failed to load payment settings:', e);
  }
}

// Save payment settings to Supabase
async function savePaymentSettings() {
  if (!locationId) return;

  // Get apply_to value
  let applyTo = 'both';
  if (applyToPackages?.checked) applyTo = 'packages';
  else if (applyToServices?.checked) applyTo = 'services';

  // Get deposit type
  const depositType = depositTypePercent?.checked ? 'percentage' : 'fixed';

  // Get deposit amount (convert to cents if fixed)
  let depositAmount = parseInt(depositAmountInput?.value || '50');
  if (depositType === 'fixed') {
    depositAmount = depositAmount * 100; // Convert dollars to cents
  }

  const settings = {
    locationId,
    payments_enabled: requireDepositsToggle?.checked || false,
    apply_to: applyTo,
    auto_require_above: autoRequireToggle?.checked || false,
    auto_require_amount: (parseInt(autoRequireAmount?.value || '0') * 100), // Convert to cents
    deposit_type: depositType,
    deposit_amount: depositAmount,
    unpaid_policy: unpaidPolicySelect?.value || 'hold_24h'
  };

  try {
    const resp = await fetch(`${PAYMENT_API_BASE}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    const data = await resp.json();

    if (data.success) {
      console.log('[Settings] Payment settings saved');
      showSaveSuccess();
    } else {
      console.error('[Settings] Failed to save:', data.error);
      showSaveError(data.error);
    }
  } catch (e) {
    console.error('[Settings] Save error:', e);
    showSaveError('Network error');
  }
}

// Toggle deposit settings visibility
function toggleDepositSettings(enabled) {
  const depositSettings = document.getElementById('depositSettingsContent');
  if (depositSettings) {
    depositSettings.style.display = enabled ? 'block' : 'none';
  }
}

// Update Stripe Connect UI
function updateStripeConnectUI(isConnected, accountName) {
  if (!stripeConnectBtn) return;

  if (isConnected) {
    stripeConnectBtn.classList.add('connected');
    stripeConnectBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
      Connected
    `;
    if (stripeStatus) {
      stripeStatus.textContent = accountName || 'Stripe account connected';
      stripeStatus.classList.add('connected');
    }
  } else {
    stripeConnectBtn.classList.remove('connected');
    stripeConnectBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-2h2v2zm0-4H9V7h2v5z"/></svg>
      Connect with Stripe
    `;
    if (stripeStatus) {
      stripeStatus.textContent = 'Connect your Stripe account to receive payments';
      stripeStatus.classList.remove('connected');
    }
  }
}

// Handle Stripe Connect button click
function handleStripeConnect() {
  if (!locationId) {
    alert('Please connect your GHL account first');
    return;
  }

  // Check if already connected - if so, offer to disconnect
  if (stripeConnectBtn?.classList.contains('connected')) {
    if (confirm('Disconnect your Stripe account? You will no longer be able to collect deposits.')) {
      disconnectStripe();
    }
  } else {
    // Redirect to Stripe Connect OAuth
    window.location.href = `https://booknexaai-oauth.onrender.com/api/payments/stripe/connect?locationId=${encodeURIComponent(locationId)}`;
  }
}

// Disconnect Stripe account
async function disconnectStripe() {
  try {
    const resp = await fetch(`${PAYMENT_API_BASE}/stripe/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId })
    });
    const data = await resp.json();

    if (data.success) {
      updateStripeConnectUI(false, null);
      console.log('[Settings] Stripe disconnected');
    }
  } catch (e) {
    console.error('[Settings] Disconnect error:', e);
  }
}

// Show save success indicator
function showSaveSuccess() {
  // Add a brief "Saved!" indicator
  const indicator = document.createElement('div');
  indicator.className = 'save-indicator';
  indicator.textContent = 'Settings saved!';
  indicator.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#28a745;color:white;padding:12px 20px;border-radius:8px;font-size:14px;z-index:9999;';
  document.body.appendChild(indicator);
  setTimeout(() => indicator.remove(), 2000);
}

// Show save error
function showSaveError(message) {
  const indicator = document.createElement('div');
  indicator.className = 'save-indicator error';
  indicator.textContent = 'Error: ' + message;
  indicator.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#dc3545;color:white;padding:12px 20px;border-radius:8px;font-size:14px;z-index:9999;';
  document.body.appendChild(indicator);
  setTimeout(() => indicator.remove(), 3000);
}

// Check for Stripe Connect callback params
function checkStripeCallback() {
  const urlParams = new URLSearchParams(window.location.search);

  if (urlParams.get('stripe_connected') === 'true') {
    // Reload settings to show connected state
    paymentSettingsLoaded = false;
    loadPaymentSettings();
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  if (urlParams.get('stripe_error')) {
    alert('Stripe connection failed: ' + urlParams.get('stripe_error'));
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// ========== EVENT LISTENERS ==========

// Require Deposits toggle
if (requireDepositsToggle) {
  requireDepositsToggle.addEventListener('change', () => {
    toggleDepositSettings(requireDepositsToggle.checked);
    savePaymentSettings();
  });
}

// Apply to radio buttons
[applyToPackages, applyToServices, applyToBoth].forEach(radio => {
  if (radio) radio.addEventListener('change', savePaymentSettings);
});

// Auto-require toggle and amount
if (autoRequireToggle) autoRequireToggle.addEventListener('change', savePaymentSettings);
if (autoRequireAmount) autoRequireAmount.addEventListener('change', savePaymentSettings);

// Deposit type radio buttons
if (depositTypeFixed) depositTypeFixed.addEventListener('change', savePaymentSettings);
if (depositTypePercent) depositTypePercent.addEventListener('change', savePaymentSettings);

// Deposit amount
if (depositAmountInput) depositAmountInput.addEventListener('change', savePaymentSettings);

// Unpaid policy select
if (unpaidPolicySelect) unpaidPolicySelect.addEventListener('change', savePaymentSettings);

// Stripe Connect button
if (stripeConnectBtn) stripeConnectBtn.addEventListener('click', handleStripeConnect);

// ========== INITIALIZE ==========

// Load settings when page loads (call this after locationId is available)
// Add to your existing init code:
// loadPaymentSettings();
// checkStripeCallback();
