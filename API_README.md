# Scheduling API

Base URL: `http://localhost:4000/api`

## Schedule a Message

**POST /messages**

Schedule a message for immediate or future delivery. You can specify a recipient by `contactId` (existing contact) or `phone` (auto-creates a nameless contact if not found).

**Body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| contactId | string (UUID) | One of contactId or phone | Existing contact ID |
| phone | string | One of contactId or phone | Phone number (Indian format: 10-digit, with/without +91) |
| name | string | No | Name for auto-created contact (saved for future use) |
| content | string | Yes | Message text |
| scheduledAt | string (ISO 8601) | No | When to send. Omit for immediate delivery |
| mediaUrl | string (URL) | No | URL of media attachment |
| mediaType | string | No | Media type: `image`, `video`, `audio`, or `document` (required if mediaUrl set) |

**Examples:**

Send immediately to existing contact:
```bash
curl -X POST http://localhost:4000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"contactId":"784212e1-843e-4eb2-9267-7456315db412","content":"Hello!"}'
```

Send immediately to phone number (auto-creates contact):
```bash
curl -X POST http://localhost:4000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"phone":"9876543210","content":"Hello!"}'
```

Schedule for later:
```bash
curl -X POST http://localhost:4000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"phone":"9876543210","content":"Hello!","scheduledAt":"2026-02-12T10:00:00.000Z"}'
```

## List Messages

**GET /messages**

Query params: `status` (pending|sent|delivered|failed|cancelled), `contactId`, `limit` (default 50), `offset` (default 0)

```bash
curl 'http://localhost:4000/api/messages?status=pending&limit=10'
```

## Get Single Message

**GET /messages/:id**

```bash
curl http://localhost:4000/api/messages/MESSAGE_ID
```

## Edit Pending Message

**PATCH /messages/:id**

Body: `{ "content"?: string, "scheduledAt"?: string, "mediaUrl"?: string|null, "mediaType"?: string|null }` (at least one required)

```bash
curl -X PATCH http://localhost:4000/api/messages/MESSAGE_ID \
  -H 'Content-Type: application/json' \
  -d '{"content":"Updated message","scheduledAt":"2026-02-13T10:00:00.000Z"}'
```

## Cancel Pending Message

**PATCH /messages/:id/cancel**

```bash
curl -X PATCH http://localhost:4000/api/messages/MESSAGE_ID/cancel
```

## Retry Failed Message

**POST /messages/:id/retry**

```bash
curl -X POST http://localhost:4000/api/messages/MESSAGE_ID/retry
```

## Bulk Schedule Messages

**POST /messages/bulk**

Schedule up to 500 messages in a single call. Each item can target by `contactId` or `phone`, and optionally include a `name` for auto-created contacts.

**Body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| messages | array | Yes | Array of message items (1-500) |
| messages[].contactId | string (UUID) | One of contactId or phone | Existing contact ID |
| messages[].phone | string | One of contactId or phone | Phone number |
| messages[].name | string | No | Name for auto-created contact |
| messages[].content | string | Yes | Message text |
| messages[].scheduledAt | string (ISO 8601) | No | When to send. Omit for immediate |
| messages[].mediaUrl | string (URL) | No | URL of media attachment |
| messages[].mediaType | string | No | Media type: `image`, `video`, `audio`, or `document` |

**Response:** `{ scheduled: [...], failed: [{ index, error }], rateLimit? }`

**Examples:**

Bulk send to multiple phone numbers:
```bash
curl -X POST http://localhost:4000/api/messages/bulk \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      {"phone":"9876543210","name":"Rahul","content":"Hello Rahul!"},
      {"phone":"9123456789","name":"Priya","content":"Hello Priya!"},
      {"phone":"9988776655","content":"Hello!","scheduledAt":"2026-02-12T10:00:00.000Z"}
    ]
  }'
```

Bulk send to existing contacts:
```bash
curl -X POST http://localhost:4000/api/messages/bulk \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      {"contactId":"UUID_1","content":"Campaign message A"},
      {"contactId":"UUID_2","content":"Campaign message B"}
    ]
  }'
```

---

## Recurring Rules API

### Create Recurring Rule

**POST /messages/recurring**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| contactId | string (UUID) | One of contactId or phone | Existing contact ID |
| phone | string | One of contactId or phone | Phone number |
| name | string | No | Name for auto-created contact |
| type | string | Yes | daily, weekly, monthly, yearly, custom |
| content | string | Yes | Message template (supports {{name}}, {{phone}}) |
| sendHour | number (0-23) | No | Hour in IST (default: config value) |
| sendMinute | number (0-59) | No | Minute (default: 0) |
| dayOfWeek | number (0-6) | No | For weekly (0=Sun) |
| dayOfMonth | number (1-31) | No | For monthly |
| intervalDays | number | No | For custom type |
| endDate | string (ISO 8601) | No | When to stop |
| maxOccurrences | number | No | Max sends before auto-disable |
| mediaUrl | string (URL) | No | URL of media attachment |
| mediaType | string | No | Media type: `image`, `video`, `audio`, or `document` |

```bash
curl -X POST http://localhost:4000/api/messages/recurring \
  -H 'Content-Type: application/json' \
  -d '{"phone":"9876543210","type":"daily","content":"Good morning!","sendHour":9}'
```

### List Recurring Rules

**GET /messages/recurring**

Query params: `contactId`, `type`, `enabled` (true|false), `limit`, `offset`

```bash
curl 'http://localhost:4000/api/messages/recurring?enabled=true'
```

### Get Single Rule

**GET /messages/recurring/:id**

```bash
curl http://localhost:4000/api/messages/recurring/RULE_ID
```

### Update Rule

**PATCH /messages/recurring/:id**

```bash
curl -X PATCH http://localhost:4000/api/messages/recurring/RULE_ID \
  -H 'Content-Type: application/json' \
  -d '{"content":"Updated message","enabled":false}'
```

### Delete (Disable) Rule

**DELETE /messages/recurring/:id**

```bash
curl -X DELETE http://localhost:4000/api/messages/recurring/RULE_ID
```

---

## Rate Limit

### Check Rate Limit Status

**GET /rate-limit/status**

```bash
curl http://localhost:4000/api/rate-limit/status
```

Returns: `{ sentToday, dailyCap, remaining, resetAt, warningThreshold }`

---

## Notes

- Phone numbers are normalized to Indian E.164 format (+91XXXXXXXXXX)
- When using `phone` instead of `contactId`, a contact is auto-created if the number doesn't exist (include `name` to save it on the contact)
- Rate limiting is enforced for immediate sends (not future scheduled)
- All timestamps are ISO 8601 / UTC
- Daily rate limit resets at midnight IST (UTC+5:30)
