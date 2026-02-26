# BookNexa AI - Agent Prompt for Payment Collection

Add the following sections to your ElevenLabs agent prompt to enable deposit collection during bookings.

## Dynamic Variables Available

The widget passes these dynamic variables to the agent:
- `{{locationId}}` - The business location ID
- `{{conversation_mode}}` - Either 'voice_call' or 'chat'
- `{{language}}` - Current language code (e.g., 'en', 'es', 'ja')
- `{{payments_enabled}}` - 'true' or 'false' whether deposits are required
- `{{deposit_applies_to}}` - 'packages', 'services', or 'both'
- `{{deposit_type}}` - Either 'fixed' or 'percentage'
- `{{deposit_amount}}` - The deposit amount (e.g., '$50' or '25%')
- `{{deposit_threshold_enabled}}` - 'true' or 'false' if only expensive bookings need deposits
- `{{deposit_threshold_amount}}` - Threshold amount (e.g., '$100')

## Prompt Addition for Payment Collection

Add this to your agent's system prompt:

```
## Deposit Collection

When {{payments_enabled}} is 'true', you must collect a deposit to confirm bookings.

The deposit amount is {{deposit_amount}} ({{deposit_type}} rate).

### Payment Flow

1. After gathering all booking details (service, date, time, contact info), inform the customer about the deposit requirement.

2. Use one of these trigger phrases to activate the payment form:
   - "I'll need to collect your deposit to secure your booking"
   - "Let me take your deposit now to confirm your appointment"
   - "To secure your appointment, I'll need to process your deposit"

3. For VOICE calls: When you say a trigger phrase, the chat panel will automatically open with the payment form. Tell the customer:
   - "I've opened the payment form on your screen. Please enter your card details to complete the booking."

4. For CHAT: The payment form appears inline in the chat. Tell the customer:
   - "I've displayed the payment form below. Please enter your card details to complete your deposit."

5. Wait for the customer to complete payment before confirming the booking.

### Example Conversation Flow

Agent: "Perfect! I have you down for a 60-minute Deep Tissue Massage with Sarah on Tuesday at 2pm. The service is $120. To confirm your booking, I'll need to collect your deposit of {{deposit_amount}}."

[Customer agrees]

Agent: "Great! I'll need to collect your deposit to secure your booking. I've opened the payment form for you - please enter your card information to complete the deposit."

[After payment succeeds]

Agent: "Your deposit has been received and your appointment is confirmed! You'll receive a confirmation email shortly. Is there anything else I can help you with?"

### When NOT to Collect Deposits

- If {{payments_enabled}} is 'false', do not mention deposits
- If the customer is only asking questions (not booking)
- If the customer explicitly says they want to pay in person
```

## Trigger Formats

### Option 1: Explicit Trigger with Price and Type (Recommended)

For accurate deposit calculation with percentage-based deposits:

```
[COLLECT_DEPOSIT:PRICE_IN_CENTS:BOOKING_TYPE]
```

Examples:
- `[COLLECT_DEPOSIT:12000:service]` - $120 service, calculates deposit based on settings
- `[COLLECT_DEPOSIT:29900:package]` - $299 package, calculates deposit based on settings

The widget will use the `calculateDeposit()` function which respects:
- `deposit_applies_to` setting (packages, services, or both)
- `deposit_threshold` settings (only require above certain amount)
- `deposit_type` (fixed amount or percentage of price)

### Option 2: Simple Trigger Phrases

Use these phrases to trigger the default deposit amount:
- "I'll need to collect your deposit"
- "Let me secure your booking"
- "To confirm your appointment"
- `[COLLECT_DEPOSIT]` or `[PAYMENT_REQUIRED]`

**Note:** Simple triggers use the default fixed deposit amount and don't calculate percentages.

## Testing

1. Use the demo location ID to test with sandbox/test mode
2. Use test card: 4242 4242 4242 4242 (any future expiry, any CVC)
3. Verify the payment form opens when trigger phrases are used
4. Confirm the agent can see when payment succeeds (via webhook or conversation context)
