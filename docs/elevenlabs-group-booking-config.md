# Sophia ElevenLabs Agent: Group Booking Configuration

Complete guide for configuring Sophia's ElevenLabs agent with group/couples booking tools.

---

## PART A: Tool Definitions

Add these two tools to Sophia's ElevenLabs agent configuration alongside the existing single-person tools.

### Important Configuration Notes

1. **Response Timeout**: Set `response_timeout_secs` to **20 seconds** on both group tools. Group availability checks query multiple therapists and may take longer than single bookings.

2. **Tool Call Sounds**: Enable **Tool Call Sounds** (hold music/typing sounds) on both tools. This prevents dead air while the server processes the request.

3. **Security**: Configure a **Bearer Token** in ElevenLabs Secrets Manager. The token should be validated on the Render server for both endpoints. Add an `Authorization` header with value `Bearer {{secrets.BOOKING_API_TOKEN}}`.

---

### Tool 1: check_group_availability

**Name:** `check_group_availability`

**Description:** Check availability for multiple people booking the same package together (couples massage, group bookings). Returns dates and times where ALL people can be booked on the same day. Use this instead of check_availability when booking for 2 or more people.

**Webhook URL:** `https://booknexaai-oauth.onrender.com/api/calendar/check-group-availability`

**Method:** POST

**Response Timeout:** 20 seconds

**Tool Call Sounds:** Enabled

**Headers:**
| Header | Value |
|--------|-------|
| Content-Type | application/json |
| Authorization | Bearer {{secrets.BOOKING_API_TOKEN}} |

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| locationId | string | Yes | The location ID (use the configured location) |
| package_name | string | Yes | Name of the package to book (e.g., "Serenity Package", "Couples Massage") |
| group_size | number | Yes | Number of people (2, 3, or 4) |
| person_1_name | string | Yes | First person's name |
| person_1_therapist_preference | string | No | "male" or "female" - first person's therapist gender preference |
| person_2_name | string | Yes | Second person's name |
| person_2_therapist_preference | string | No | "male" or "female" - second person's therapist gender preference |
| person_3_name | string | No | Third person's name (if group_size >= 3) |
| person_3_therapist_preference | string | No | "male" or "female" - third person's therapist gender preference |
| person_4_name | string | No | Fourth person's name (if group_size = 4) |
| person_4_therapist_preference | string | No | "male" or "female" - fourth person's therapist gender preference |
| time_preference | string | No | "morning" or "afternoon" |
| requested_date | string | No | Specific date like "tomorrow", "next Tuesday", "February 15" |

**Example Request (2 people):**
```json
{
  "locationId": "NNFCwckEhjBk90UtMRSp",
  "package_name": "Serenity Package",
  "group_size": 2,
  "person_1_name": "John",
  "person_1_therapist_preference": "female",
  "person_2_name": "Jane",
  "person_2_therapist_preference": "male",
  "time_preference": "morning",
  "requested_date": "this Saturday"
}
```

**Example Request (3 people):**
```json
{
  "locationId": "NNFCwckEhjBk90UtMRSp",
  "package_name": "Relaxation Package",
  "group_size": 3,
  "person_1_name": "Alice",
  "person_2_name": "Bob",
  "person_3_name": "Carol",
  "time_preference": "afternoon"
}
```

**Response Fields:**
- `success` (boolean): Whether availability was found for everyone
- `date` (string): The date where everyone can be booked
- `group_slots` (array): Slots for each person showing their services, times, and assigned therapists
- `message` (string): **Human-readable summary to read directly to the customer**

**Example Success Response:**
```json
{
  "success": true,
  "package_name": "Serenity Package",
  "num_people": 2,
  "date": "2026-02-15",
  "group_slots": [...],
  "message": "I have availability for both of you on Saturday, February 15th. John would start at 10 AM with Sarah, and Jane would start at 10 AM with Mike."
}
```

**Example Failure Response:**
```json
{
  "success": false,
  "error": "Could not find availability for Jane with male therapist preference",
  "message": "I couldn't find a time where both of you can be booked together this week. Would you like me to check a different week, or would either of you be flexible on therapist preference?"
}
```

---

### Tool 2: book_group

**Name:** `book_group`

**Description:** Book a package for multiple people (couples, groups) in one call. Creates appointments for ALL people together. If any booking fails, all are cancelled automatically. Use this instead of book_appointment when booking for 2 or more people.

**Webhook URL:** `https://booknexaai-oauth.onrender.com/api/calendar/book-group`

**Method:** POST

**Response Timeout:** 20 seconds

**Tool Call Sounds:** Enabled

**Headers:**
| Header | Value |
|--------|-------|
| Content-Type | application/json |
| Authorization | Bearer {{secrets.BOOKING_API_TOKEN}} |

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| locationId | string | Yes | The location ID (use the configured location) |
| package_name | string | Yes | Name of the package to book |
| group_size | number | Yes | Number of people (2, 3, or 4) |
| person_1_name | string | Yes | First person's full name |
| person_1_email | string | Yes | First person's email address |
| person_1_phone | string | Yes | First person's phone number |
| person_1_therapist_preference | string | No | "male" or "female" |
| person_2_name | string | Yes | Second person's full name |
| person_2_email | string | Yes | Second person's email address |
| person_2_phone | string | Yes | Second person's phone number |
| person_2_therapist_preference | string | No | "male" or "female" |
| person_3_name | string | No | Third person's full name (if group_size >= 3) |
| person_3_email | string | No | Third person's email address (if group_size >= 3) |
| person_3_phone | string | No | Third person's phone number (if group_size >= 3) |
| person_3_therapist_preference | string | No | "male" or "female" |
| person_4_name | string | No | Fourth person's full name (if group_size = 4) |
| person_4_email | string | No | Fourth person's email address (if group_size = 4) |
| person_4_phone | string | No | Fourth person's phone number (if group_size = 4) |
| person_4_therapist_preference | string | No | "male" or "female" |
| time_preference | string | No | "morning" or "afternoon" |
| selected_date | string | No | The date to book (from check_group_availability results) |
| requested_time | string | No | Specific start time like "10:00 AM" |

**Example Request (2 people):**
```json
{
  "locationId": "NNFCwckEhjBk90UtMRSp",
  "package_name": "Serenity Package",
  "group_size": 2,
  "person_1_name": "John Smith",
  "person_1_email": "john@example.com",
  "person_1_phone": "555-123-4567",
  "person_1_therapist_preference": "female",
  "person_2_name": "Jane Smith",
  "person_2_email": "jane@example.com",
  "person_2_phone": "555-987-6543",
  "person_2_therapist_preference": "male",
  "time_preference": "morning",
  "selected_date": "2026-02-15"
}
```

**Response Fields:**
- `success` (boolean): Whether all bookings were created
- `bookings` (array): Confirmation for each person with appointment IDs, times, and therapists
- `message` (string): **Human-readable confirmation to read directly to the customer**

**Example Success Response:**
```json
{
  "success": true,
  "package_name": "Serenity Package",
  "num_people": 2,
  "date": "2026-02-15",
  "bookings": [...],
  "message": "Your Serenity Package has been booked for 2 people on Saturday, February 15th. John starts at 10 AM with Sarah, and Jane starts at 10 AM with Mike. Confirmation emails have been sent to both of you. See you soon!"
}
```

**Example Failure Response:**
```json
{
  "success": false,
  "error": "Failed to book Swedish Massage for Jane: slot no longer available",
  "message": "I'm sorry, while I was processing the booking, that time slot became unavailable. All bookings have been cancelled. Would you like me to check for another available time?"
}
```

---

## PART B: Prompt Rules for Group Booking

Add these rules to Sophia's system prompt:

```
## GROUP BOOKING RULES

### GROUP DETECTION
If the customer mentions ANY other person being booked in the same request, it's a group booking. This includes:
- "I want to book for me and my husband"
- "We need appointments for two people"
- "Couples massage"
- "Can I book for myself and a friend?"
- "I'm booking for me and my mom"
- "We're a group of three"

The specific words don't matter. If there's more than one person being booked in the same call, use the group booking tools. Always assume same day, same time unless told otherwise.

### SCHEDULING PRIORITY FOR GROUPS
When booking for multiple people, follow this priority:

**First choice: PARALLEL (same time, different therapists)**
Both people start at the same time with different therapists. This is what customers expect when they book together.
Example: "I have you both starting at 10 AM — you'll be with Sarah and your husband will be with Mike."

**Second choice: STAGGERED (same day, back to back)**
If parallel isn't possible because only one therapist is available for a service, book them back to back on the same day. Person A starts first, Person B starts right after Person A finishes.
ALWAYS explain this to the customer: "I can get you both in on Tuesday — you'd start at 9 AM and your friend would start right after at 12:30 PM. Does that work?"

**Last resort: DIFFERENT DAYS**
Only suggest different days if there is absolutely no way to fit both on the same day.
ALWAYS explain why and get explicit approval BEFORE booking: "Unfortunately, the only availability I'm seeing is Wednesday for you and Thursday for your friend. Would you like me to book those, or would you prefer to look at a different week when you can both come together?"

NEVER book two people on different days without telling the customer first and getting their okay. The default assumption is ALWAYS same day, same time.

### USE THE GROUP TOOLS
When booking for 2+ people:
- ALWAYS use check_group_availability (not check_availability)
- ALWAYS use book_group (not book_appointment)
- ONE check call, ONE book call — that's it
- NEVER call single-person tools multiple times for a group booking

### READING RESPONSES
The tool responses include a `message` field with a human-readable sentence. Read this directly to the customer — it's already formatted for conversation.

### COLLECTING INFORMATION FOR GROUPS
For each person in the group, you need:
1. Their name
2. Their email address
3. Their phone number
4. Their therapist gender preference (optional — ask "Does anyone have a preference for a male or female therapist?")

Collect this efficiently. For couples, you can say: "I'll need contact info for both of you. Can I start with the first person's name and email?"
```

---

## PART C: Group Booking Call Flow

Add this flow guidance to the prompt:

```
## GROUP BOOKING CALL FLOW

When a customer wants to book for multiple people, follow this flow:

### Step 1: Confirm it's a group booking
"Perfect, I'd be happy to help you book for [number] people!"

### Step 2: Get the package/services
"What package or services are you interested in?"

### Step 3: Get time preference
"Do you prefer morning or afternoon appointments?"

### Step 4: Get therapist preferences
"Does anyone have a preference for a male or female therapist?"
(This is optional — if they don't have preferences, that's fine)

### Step 5: Check group availability (ONE tool call)
Call check_group_availability with all the information gathered.
Read the `message` field from the response directly to the customer.

### Step 6: Confirm the date
"Would you like me to book that for you?"

### Step 7: Collect contact info for everyone
"I'll need the name, email, and phone number for each person."
Collect efficiently — don't make them repeat information.

### Step 8: Book everyone (ONE tool call)
Call book_group with all the people's information.

### Step 9: Confirm all bookings
Read the `message` field from the response directly to the customer.

### IMPORTANT
- A group booking should take about the same time as a single booking
- No bouncing around trying different days
- No booking people on wrong days
- No multiple tool calls — one check, one book
- Keep it smooth and efficient
- Read the `message` field from responses — it's ready for conversation
```

---

## Summary

| Scenario | Tools to Use |
|----------|--------------|
| Single person booking | check_availability → book_appointment |
| 2+ people booking together | check_group_availability → book_group |

The single-person tools remain unchanged. Group tools are additive — use them when booking for multiple people in the same call.

---

## Security Configuration

### ElevenLabs Secrets Manager

1. Go to ElevenLabs Agent Settings → Secrets Manager
2. Add a new secret named `BOOKING_API_TOKEN`
3. Set the value to a secure random string (e.g., generate with `openssl rand -hex 32`)

### Render Server Validation

Add this middleware to validate the token on both group endpoints:

```typescript
// In your server code, validate the Authorization header
const expectedToken = process.env.BOOKING_API_TOKEN;
const authHeader = req.headers.authorization;
if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
  return res.status(401).json({ success: false, error: "Unauthorized" });
}
```

Add `BOOKING_API_TOKEN` to your Render environment variables with the same value you set in ElevenLabs.
