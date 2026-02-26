# BookNexa AI - Agent Prompt for Payment Collection

Add the following sections to your ElevenLabs agent prompt to enable deposit collection during bookings.

## Dynamic Variables Available

The widget passes these dynamic variables to the agent:
- `{{locationId}}` - The business location ID
- `{{conversation_mode}}` - Either 'voice_call' or 'chat'
- `{{language}}` - Current language code (e.g., 'en', 'es', 'ja')
- `{{payments_enabled}}` - 'true' or 'false' whether deposits are required
- `{{deposit_type}}` - Either 'fixed' or 'percentage'
- `{{deposit_amount}}` - The deposit amount (e.g., '$50' or '20%')

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

## Alternative: Explicit Trigger Tags

For more precise control, you can have the agent use explicit trigger tags:

```
When you're ready to collect the deposit, include [COLLECT_DEPOSIT] in your message.
The payment form will automatically appear.

Example: "Let me secure your appointment. [COLLECT_DEPOSIT] Please enter your card details in the payment form that just appeared."
```

## Testing

1. Use the demo location ID to test with sandbox/test mode
2. Use test card: 4242 4242 4242 4242 (any future expiry, any CVC)
3. Verify the payment form opens when trigger phrases are used
4. Confirm the agent can see when payment succeeds (via webhook or conversation context)
