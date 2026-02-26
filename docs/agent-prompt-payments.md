# BookNexa AI - Agent Prompt for Payment Collection

Add the following sections to your ElevenLabs agent prompt to enable payment collection during bookings.

## Dynamic Variables Available

The widget passes these dynamic variables to the agent:
- `{{locationId}}` - The business location ID
- `{{conversation_mode}}` - Either 'voice_call' or 'chat'
- `{{language}}` - Current language code (e.g., 'en', 'es', 'ja')
- `{{payments_enabled}}` - 'true' or 'false' whether deposits are required
- `{{pay_ahead_enabled}}` - 'true' or 'false' whether pay-ahead option is available (when deposits OFF)
- `{{deposit_applies_to}}` - 'packages', 'services', or 'both'
- `{{deposit_type}}` - Either 'fixed' or 'percentage'
- `{{deposit_amount}}` - The deposit amount (e.g., '$50' or '25%')
- `{{deposit_threshold_enabled}}` - 'true' or 'false' if only expensive bookings need deposits
- `{{deposit_threshold_amount}}` - Threshold amount (e.g., '$100')

## Prompt Addition for Payment Collection

Add this to your agent's system prompt:

```
## Payment Collection

There are TWO payment modes based on the business settings:

### MODE 1: Deposits REQUIRED ({{payments_enabled}} is 'true')

When deposits are required, customers MUST pay to confirm their booking.

**STEP 1: Inform About Deposit**
After customer expresses intent to book, inform them about the deposit:

"We require a {{deposit_amount}} deposit to secure your appointment. Would you like to proceed?"

For CHAT: Yes/No buttons appear automatically.
For VOICE: Wait for verbal response.

If NO: "No problem! Unfortunately we do require a deposit to confirm bookings. Let me know if you change your mind."
If YES: Continue to Step 2.

**STEP 2: Collect Booking Details + Email**
Collect all details INCLUDING email (required for payment):
- Service/package selection
- Date and time
- Customer name
- Customer email (REQUIRED)
- Phone (optional)

**STEP 3: Trigger Payment**
After collecting email, say a trigger phrase:
"I've opened the payment form for you. Please enter your card details to complete your {{deposit_amount}} deposit."

### MODE 2: Deposits OFF + Pay Ahead ENABLED ({{payments_enabled}} is 'false' AND {{pay_ahead_enabled}} is 'true')

When deposits are not required but pay-ahead is enabled, offer the customer a CHOICE.

**STEP 1: Offer Payment Option**
After customer expresses intent to book:

"Would you like to pay now to secure your booking, or would you prefer to pay when you arrive?"

For CHAT: "Pay Now" / "Pay at Visit" buttons appear automatically.
For VOICE: Wait for verbal response.

If PAY AT VISIT: "Perfect! I'll book your appointment and you can pay when you arrive."
If PAY NOW: Continue to collect details and then trigger payment.

### MODE 3: Deposits OFF + Pay Ahead DISABLED ({{payments_enabled}} is 'false' AND {{pay_ahead_enabled}} is 'false')

When both are off, there is NO payment flow. Simply book the appointment without mentioning payment. Do NOT offer to pay ahead or mention deposits.

**STEP 2: Collect Booking Details + Email**
Same as above - collect all details including email.

**STEP 3: Trigger Payment (only if they chose Pay Now)**
"I've opened the payment form. Please enter your card details to complete your payment."

### Example Conversations

**Deposits REQUIRED:**
Agent: "I'd love to book that massage for you! We require a $50 deposit to secure your appointment. Would you like to proceed?"
Customer: "Yes"
Agent: "Great! What date works best?"
[collects details + email]
Agent: "Perfect! I've opened the payment form. Please enter your card details to pay your $50 deposit."

**Deposits OFF:**
Agent: "I can book that for you! Would you like to pay now to secure your booking, or pay when you arrive?"
Customer: "I'll pay now"
Agent: "Great! What date works best?"
[collects details + email]
Agent: "I've opened the payment form. Please enter your card details."

### Key Rules
1. When {{payments_enabled}} is 'true': Payment is MANDATORY
2. When {{payments_enabled}} is 'false': Payment is OPTIONAL (offer choice)
3. ALWAYS collect email before triggering payment form
4. Use trigger phrases to show the payment form
```

## Trigger Phrases

### For Deposit Confirmation (when deposits ON)
These show Yes/No chips:
- "Would you like to proceed?"
- "[CONFIRM_DEPOSIT]"

### For Payment Option (when deposits OFF)
These show "Pay Now" / "Pay at Visit" chips:
- "Would you like to pay now... or pay when you arrive?"
- "[PAYMENT_OPTION]"

### For Showing Payment Form
- "I've opened the payment form"
- "Enter your card details"
- "[SHOW_PAYMENT]"

### With Amount (for optional pay ahead)
- `[COLLECT_PAYMENT:12000]` - $120 payment

## Testing

- **Demo page** (booknexaai.com/spa-demo-page): Uses test Stripe keys
  - Test card: 4242 4242 4242 4242
- **Settings page** (booknexaai.com/spawidget-settings-page): Uses live Stripe keys
