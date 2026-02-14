# WABridge API Reference

Complete developer guide for integrating with the WABridge API.

**Base URL:** `http://localhost:4000/api`

**Authentication:** All routes (except health) require an `X-API-Key` header:

```
X-API-Key: sk_your_key_here
```

---

## Quick Examples

### Send a message immediately

```bash
curl -X POST http://localhost:4000/api/messages \
  -H "X-API-Key: sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "content": "Hello from WABridge!"
  }'
```

### Schedule a message for later

```bash
curl -X POST http://localhost:4000/api/messages \
  -H "X-API-Key: sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "content": "Good morning!",
    "scheduledAt": "2025-03-15T03:30:00.000Z"
  }'
```

### Send a message with an image

```bash
curl -X POST http://localhost:4000/api/messages \
  -H "X-API-Key: sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "content": "Check out this photo!",
    "mediaUrl": "https://example.com/photo.jpg",
    "mediaType": "image"
  }'
```

### Bulk send to multiple contacts

```bash
curl -X POST http://localhost:4000/api/messages/bulk \
  -H "X-API-Key: sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "phone": "919876543210", "content": "Hello A!" },
      { "phone": "919876543211", "content": "Hello B!" },
      { "phone": "919876543212", "content": "Hello C!" }
    ]
  }'
```

---

## Health

### GET /api/health

Check WhatsApp connection status. **No authentication required.**

**Response:**

```json
{
  "status": "connected",
  "uptime": 3600,
  "connectedAt": "2025-01-15T10:00:00.000Z",
  "lastDisconnect": null,
  "reconnectAttempts": 0,
  "account": {
    "phoneNumber": "919876543210",
    "name": "My Business"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `pairing` \| `connecting` \| `connected` \| `disconnected` | Current connection state |
| `uptime` | number | Uptime in seconds |
| `connectedAt` | string \| null | ISO timestamp when connected |
| `lastDisconnect` | object \| null | Last disconnect info (`reason`, `code`, `at`) |
| `reconnectAttempts` | number | Current reconnect attempt count |
| `account` | object \| null | Connected WhatsApp account (`phoneNumber`, `name`) |

---

## Contacts

### POST /api/contacts

Create a contact. If a contact with the same phone already exists, it updates the existing one.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `phone` | string | Yes | Phone number (min 10 chars). Auto-normalized to Indian format. |
| `name` | string | No | Contact name |
| `email` | string | No | Must be valid email |
| `notes` | string | No | Free-text notes |
| `birthday` | string | No | `MM-DD` format (e.g. `"03-15"` for March 15) |
| `birthdayReminderEnabled` | boolean | No | Auto-send birthday message (default: true) |

**Response:** `201`

```json
{
  "id": "a1b2c3d4-...",
  "phone": "919876543210",
  "name": "John",
  "email": null,
  "notes": null,
  "customFields": null,
  "birthday": "03-15",
  "birthdayReminderEnabled": true,
  "labels": [],
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z"
}
```

> Setting a `birthday` auto-creates a yearly recurring rule to send the birthday message.

### GET /api/contacts

List contacts with search and pagination.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `search` | string | — | Search name, phone, or email |
| `label` | string | — | Filter by label ID |
| `page` | number | 1 | Page number (min: 1) |
| `limit` | number | 20 | Items per page (1–100) |

**Response:**

```json
{
  "data": [ /* Contact objects */ ],
  "total": 150,
  "page": 1,
  "pageSize": 20
}
```

### GET /api/contacts/:id

Get a single contact. Returns `404` if not found.

### PUT /api/contacts/:id

Update a contact. All fields are optional. Returns `404` if not found.

| Field | Type | Description |
|-------|------|-------------|
| `phone` | string | Min 10 chars |
| `name` | string | — |
| `email` | string | Valid email |
| `notes` | string | — |
| `birthday` | string \| null | `MM-DD` or `null` to clear |
| `birthdayReminderEnabled` | boolean | — |

### DELETE /api/contacts/:id

Delete a contact. Returns `404` if not found.

```json
{ "deleted": true }
```

### POST /api/contacts/import

Import contacts from CSV or Excel file.

**Content-Type:** `multipart/form-data`

| Field | Type | Description |
|-------|------|-------------|
| `file` | File | CSV, XLSX, or XLS (max 5MB) |

**Recognized columns:**

| Data | Column names accepted |
|------|----------------------|
| Phone (required) | `phone`, `Phone`, `mobile`, `Mobile`, `number`, `Number` |
| Name | `name`, `Name` |
| Email | `email`, `Email` |
| Notes | `notes`, `Notes`, `note`, `Note` |

Any other columns are stored as `customFields` JSON on the contact.

**Response:**

```json
{
  "imported": 45,
  "skipped": 2,
  "errors": [
    "Row 3: empty phone number",
    "Row 12: Invalid phone number format"
  ]
}
```

> Duplicate phone numbers update the existing contact instead of creating a new one.

### POST /api/contacts/:id/labels

Assign labels to a contact.

```json
{ "labelIds": ["label-uuid-1", "label-uuid-2"] }
```

**Response:** `{ "assigned": 2 }`

### DELETE /api/contacts/:id/labels/:labelId

Remove a label from a contact.

**Response:** `{ "removed": true }`

---

## Labels

### POST /api/labels

Create a label.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | 1–50 characters. Must be unique. |
| `color` | string | No | Hex color (e.g. `"#FF0000"`) |

**Response:** `201`

```json
{
  "id": "a1b2c3d4-...",
  "name": "VIP",
  "color": "#FF0000",
  "createdAt": "2025-01-15T10:00:00.000Z"
}
```

Returns `409` if the name already exists.

### GET /api/labels

List all labels. Returns an array of Label objects.

### PUT /api/labels/:id

Update a label. Returns `404` if not found, `409` if name conflicts.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | 1–50 chars |
| `color` | string \| null | Hex color or `null` to clear |

### DELETE /api/labels/:id

Delete a label. Returns `{ "deleted": true }` or `404`.

---

## Templates

Templates support `{{variable}}` substitution. Variables are extracted automatically.

**Available variables:** `{{name}}`, `{{phone}}`, `{{email}}`, `{{customFields.fieldName}}`

### POST /api/templates

Create a template.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | 1–100 chars. Must be unique. |
| `body` | string | Yes | Template body with `{{variables}}` |

**Response:** `201`

```json
{
  "id": "a1b2c3d4-...",
  "name": "Welcome",
  "body": "Hello {{name}}, welcome aboard!",
  "variables": ["name"],
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z"
}
```

Returns `409` if the name already exists.

### GET /api/templates

List all templates. Returns an array of Template objects.

### GET /api/templates/:id

Get a single template. Returns `404` if not found.

### PUT /api/templates/:id

Update a template. Returns `404` if not found, `409` if name conflicts.

### DELETE /api/templates/:id

Delete a template. Returns `{ "deleted": true }` or `404`.

### POST /api/templates/:id/preview

Preview a template rendered with a contact's data.

```json
{ "contactId": "contact-uuid" }
```

**Response:**

```json
{
  "rendered": "Hello John, welcome aboard!",
  "unresolvedVariables": []
}
```

---

## Messages

### POST /api/messages

Schedule a message or send immediately.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `contactId` | string (UUID) | One of these | Existing contact ID |
| `phone` | string | is required | Phone number (auto-creates contact if new) |
| `name` | string | No | Contact name (used with `phone`) |
| `content` | string | Yes | Message text (min 1 char) |
| `scheduledAt` | string | No | ISO datetime. Omit to send immediately. |
| `mediaUrl` | string (URL) | No | URL to media file |
| `mediaType` | string | If mediaUrl set | `image`, `video`, `audio`, or `document` |

**Response:** `201`

```json
{
  "id": "msg-uuid",
  "contactId": "contact-uuid",
  "content": "Hello!",
  "scheduledAt": "2025-01-15T10:00:00.000Z",
  "status": "pending",
  "mediaUrl": null,
  "mediaType": null,
  "attempts": 0,
  "sentAt": null,
  "deliveredAt": null,
  "failedAt": null,
  "failureReason": null,
  "createdAt": "2025-01-15T09:00:00.000Z",
  "updatedAt": "2025-01-15T09:00:00.000Z",
  "rateLimit": {
    "sentToday": 5,
    "dailyCap": 30,
    "remaining": 25,
    "resetAt": "2025-01-15T18:30:00.000Z",
    "warningThreshold": 24
  }
}
```

**Errors:**
- `404` — Contact not found
- `429` — Daily rate limit reached

> If `scheduledAt` is omitted or in the past, the message sends immediately.

### POST /api/messages/bulk

Send up to 500 messages at once.

```json
{
  "messages": [
    { "phone": "919876543210", "content": "Hello A!" },
    { "phone": "919876543211", "content": "Hello B!", "scheduledAt": "2025-03-15T03:30:00.000Z" }
  ]
}
```

**Response:** `201`

```json
{
  "scheduled": [ /* ScheduledMessage objects */ ],
  "failed": [
    { "index": 2, "error": "Contact not found" }
  ],
  "rateLimit": { "sentToday": 10, "dailyCap": 30, "remaining": 20, "..." : "..." }
}
```

### GET /api/messages

List messages with filters.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | — | `pending`, `sent`, `delivered`, `failed`, or `cancelled` |
| `contactId` | string | — | Filter by contact UUID |
| `phone` | string | — | Filter by phone number (comma-separated for multiple) |
| `phoneMode` | string | `include` | `include` = show only these, `exclude` = hide these |
| `limit` | number | 50 | 1–200 |
| `offset` | number | 0 | Pagination offset |

**Response:**

```json
{
  "data": [ /* ScheduledMessage objects */ ],
  "total": 250
}
```

**Phone filter examples:**

```bash
# Show only messages to this number
curl -H "X-API-Key: ..." "http://localhost:4000/api/messages?phone=919876543210&phoneMode=include"

# Show all messages EXCEPT to this number
curl -H "X-API-Key: ..." "http://localhost:4000/api/messages?phone=919876543210&phoneMode=exclude"

# Filter by multiple numbers
curl -H "X-API-Key: ..." "http://localhost:4000/api/messages?phone=919876543210,919876543211"
```

### GET /api/messages/:id

Get a single message. Returns `404` if not found.

### PATCH /api/messages/:id

Edit a **pending** message. At least one field required.

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | New message text |
| `scheduledAt` | string | New schedule time (ISO datetime) |
| `mediaUrl` | string \| null | New media URL or `null` to remove |
| `mediaType` | string \| null | Required if `mediaUrl` is set |

Returns `404` if message not found or not in `pending` status.

### PATCH /api/messages/:id/cancel

Cancel a **pending** message. Returns the updated message with `status: "cancelled"`.

Returns `404` if message not found or not in `pending` status.

### POST /api/messages/:id/retry

Retry a **failed** message. Resets status to `pending` and schedules immediate send.

Returns `404` if message not found or not in `failed` status.

---

## Recurring Rules

Recurring rules automatically create and send messages on a schedule.

### POST /api/messages/recurring

Create a recurring rule.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `contactId` | string (UUID) | One of these | Existing contact ID |
| `phone` | string | is required | Phone number |
| `name` | string | No | Contact name (used with `phone`) |
| `type` | string | Yes | See types below |
| `content` | string | Yes | Message text |
| `sendHour` | number | No | Hour to send, 0–23 IST (default: config value) |
| `sendMinute` | number | No | Minute to send, 0–59 (default: 0) |
| `dayOfWeek` | number | For `weekly` | 0=Sun, 1=Mon, ..., 6=Sat |
| `dayOfMonth` | number | For `monthly`/`yearly` | 1–31 |
| `month` | number | For `yearly` | 1–12 |
| `intervalDays` | number | For `custom` | Every N days |
| `endDate` | string | No | ISO datetime to stop |
| `maxOccurrences` | number | No | Stop after N sends |
| `mediaUrl` | string | No | Media URL |
| `mediaType` | string | If mediaUrl set | `image`, `video`, `audio`, or `document` |

**Recurring types:**

| Type | Required fields | Example |
|------|----------------|---------|
| `daily` | None | Every day at 9:00 AM |
| `weekly` | `dayOfWeek` | Every Monday at 9:00 AM |
| `monthly` | `dayOfMonth` | 1st of every month (days > 28 use last day) |
| `yearly` | `dayOfMonth`, `month` | March 15 every year |
| `custom` | `intervalDays` | Every 3 days |
| `birthday` | — | Auto-created from contact birthday |

**Response:** `201` — RecurringRule object

**Example — weekly reminder every Monday at 10:30 AM:**

```bash
curl -X POST http://localhost:4000/api/messages/recurring \
  -H "X-API-Key: sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "919876543210",
    "type": "weekly",
    "content": "Weekly check-in: how are things going?",
    "sendHour": 10,
    "sendMinute": 30,
    "dayOfWeek": 1
  }'
```

### GET /api/messages/recurring

List recurring rules.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `contactId` | string | — | Filter by contact UUID |
| `type` | string | — | Filter by type |
| `enabled` | string | — | `"true"` or `"false"` |
| `limit` | number | 50 | 1–200 |
| `offset` | number | 0 | Pagination offset |

### GET /api/messages/recurring/:id

Get a single rule. Returns `404` if not found.

### PATCH /api/messages/recurring/:id

Update a rule. All fields optional.

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | New message text |
| `sendHour` | number | 0–23 |
| `sendMinute` | number | 0–59 |
| `dayOfWeek` | number | 0–6 |
| `dayOfMonth` | number | 1–31 |
| `month` | number | 1–12 |
| `intervalDays` | number | Min 1 |
| `endDate` | string \| null | ISO datetime or `null` to clear |
| `maxOccurrences` | number \| null | Or `null` to clear |
| `enabled` | boolean | Toggle rule on/off |
| `mediaUrl` | string \| null | — |
| `mediaType` | string \| null | — |

### DELETE /api/messages/recurring/:id

Disable a recurring rule (soft delete). Returns `404` if not found.

---

## Rate Limit

### GET /api/rate-limit/status

Get current daily usage.

**Response:**

```json
{
  "sentToday": 12,
  "dailyCap": 30,
  "remaining": 18,
  "resetAt": "2025-01-16T18:30:00.000Z",
  "warningThreshold": 24
}
```

The counter resets at midnight IST daily.

---

## WebSocket

Real-time events for connection status, QR codes, and message delivery.

### Connecting

```
ws://localhost:4000/ws?apiKey=sk_your_key_here
```

### JavaScript example

```javascript
const ws = new WebSocket(`ws://localhost:4000/ws?apiKey=${apiKey}`);

ws.onmessage = (event) => {
  const { type, data } = JSON.parse(event.data);

  switch (type) {
    case 'status':
      // data: ConnectionHealth object (same as GET /api/health)
      console.log('Status:', data.status);
      break;

    case 'qr':
      // data: string (QR code data for rendering)
      console.log('Scan QR code');
      break;

    case 'message:sent':
      // data: { messageId, contactId, sentAt }
      console.log('Sent:', data.messageId);
      break;

    case 'message:failed':
      // data: { messageId, error, failedAt }
      console.log('Failed:', data.messageId, data.error);
      break;

    case 'message:status':
      // data: { messageId, status, at }
      console.log('Status update:', data.messageId, data.status);
      break;

    case 'rate-limit:warning':
      // data: { sentToday, cap, remaining }
      console.log('Warning:', data.remaining, 'messages left');
      break;

    case 'rate-limit:reached':
      // data: { sentToday, cap, resetAt }
      console.log('Limit reached, resets at', data.resetAt);
      break;
  }
};
```

### Events

| Event | Data | When |
|-------|------|------|
| `status` | `ConnectionHealth` | On connect + on status change |
| `qr` | `string` | When QR code is generated for pairing |
| `message:sent` | `{ messageId, contactId, sentAt }` | Message delivered to WhatsApp |
| `message:failed` | `{ messageId, error, failedAt }` | Message send failed |
| `message:status` | `{ messageId, status, at }` | Generic status update |
| `rate-limit:warning` | `{ sentToday, cap, remaining }` | Approaching daily cap (default: 80%) |
| `rate-limit:reached` | `{ sentToday, cap, resetAt }` | Daily cap reached |

---

## Error Responses

All errors return:

```json
{
  "error": "Human-readable error message"
}
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request — invalid body or params |
| `401` | Unauthorized — missing or invalid API key |
| `404` | Not found |
| `409` | Conflict — duplicate name (labels, templates) |
| `429` | Rate limit reached |
| `500` | Server error |

---

## Phone Number Format

WABridge normalizes all phone numbers to Indian format:

| Input | Stored as |
|-------|-----------|
| `9876543210` | `919876543210` |
| `09876543210` | `919876543210` |
| `+919876543210` | `919876543210` |
| `919876543210` | `919876543210` |

When filtering by phone (e.g. `GET /api/messages?phone=9876543210`), the number is normalized before lookup — so any format works.

---

## Pagination

**Contacts** use page-based pagination:

```
GET /api/contacts?page=2&limit=20
```

Response includes `page`, `pageSize`, and `total`.

**Messages and recurring rules** use offset-based pagination:

```
GET /api/messages?offset=100&limit=50
GET /api/messages/recurring?offset=0&limit=50
```

Response includes `total` for calculating pages client-side.
