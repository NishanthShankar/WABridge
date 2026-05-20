# WABridge API Documentation

**Base URL:** `https://hercare.wabridge.co.in/api`
**WebSocket:** `wss://hercare.wabridge.co.in/ws?apiKey=YOUR_API_KEY`

## Authentication

All API endpoints require the `X-API-Key` header.

```
X-API-Key: your-api-key
```

---

## Health & Status

### `GET /health`

Check WhatsApp connection status and server health.

**Response:**
```json
{
  "status": "connected",
  "uptime": 3600,
  "connectedAt": "2026-03-10T10:00:00.000Z",
  "account": {
    "phoneNumber": "919876543210",
    "name": "Hercare"
  }
}
```

---

## Messages

### `POST /messages`

Schedule a message (immediate or future).

**Body:**
```json
{
  "to": "+919876543210",
  "content": "Hello!",
  "scheduledAt": "2026-03-12T10:00:00.000Z",
  "mediaUrl": "https://example.com/image.jpg",
  "mediaType": "image"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Phone number (E.164) or group JID |
| `content` | string | Yes | Message text |
| `scheduledAt` | string | No | ISO-8601 datetime. Omit for immediate send |
| `mediaUrl` | string | No | URL of media attachment |
| `mediaType` | string | No | `image`, `video`, `audio`, or `document` |

**Response (201):**
```json
{
  "id": "msg-uuid",
  "contactId": "contact-uuid",
  "content": "Hello!",
  "status": "pending",
  "scheduledAt": "2026-03-12T10:00:00.000Z",
  "createdAt": "2026-03-10T10:00:00.000Z"
}
```

### `GET /messages`

List messages with filters.

| Query Param | Type | Description |
|-------------|------|-------------|
| `status` | string | `pending`, `sent`, `failed`, `cancelled` |
| `contactId` | string | Filter by contact UUID |
| `page` | number | Page number (default: 1) |
| `limit` | number | Results per page (default: 50) |

### `GET /messages/:id`

Get a single message by ID.

### `PATCH /messages/:id`

Edit a pending message.

**Body:**
```json
{
  "content": "Updated message",
  "scheduledAt": "2026-03-13T10:00:00.000Z",
  "mediaUrl": "https://example.com/new-image.jpg",
  "mediaType": "image"
}
```

### `PATCH /messages/:id/cancel`

Cancel a pending message.

### `POST /messages/:id/retry`

Retry a failed message.

---

## Bulk Messages

### `POST /messages/bulk`

Schedule up to 500 messages at once.

**Body:**
```json
{
  "messages": [
    { "to": "+919876543210", "content": "Hello!" },
    { "to": "+919876543211", "content": "Hi there!" }
  ],
  "scheduledAt": "2026-03-12T10:00:00.000Z"
}
```

> Messages are sent with random 2–8s delays to avoid WhatsApp bans.

---

## Recurring Messages

### `POST /messages/recurring`

Create a recurring message rule.

**Body:**
```json
{
  "to": "+919876543210",
  "content": "Weekly reminder: {{name}}, your appointment is tomorrow!",
  "templateId": "template-uuid",
  "type": "weekly",
  "daysOfWeek": [1, 3, 5],
  "time": "09:00",
  "startDate": "2026-03-10",
  "endDate": "2026-06-10",
  "maxOccurrences": 50
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Phone number or group JID |
| `content` | string | Yes* | Message text (supports `{{name}}`, `{{phone}}` variables) |
| `templateId` | string | No | Use a template instead of inline content |
| `type` | string | Yes | `daily`, `weekly`, `monthly`, `yearly`, `custom` |
| `daysOfWeek` | number[] | No | 0=Sun, 1=Mon ... 6=Sat (for `weekly`) |
| `dayOfMonth` | number | No | 1–31 (for `monthly`) |
| `intervalMinutes` | number | No | Custom interval in minutes (for `custom`) |
| `time` | string | Yes | Time in `HH:mm` format (IST) |
| `startDate` | string | No | ISO date to start |
| `endDate` | string | No | ISO date to stop |
| `maxOccurrences` | number | No | Auto-disable after N sends |

### `GET /messages/recurring`

List recurring rules.

| Query Param | Type | Description |
|-------------|------|-------------|
| `active` | boolean | Filter active/inactive rules |
| `page` | number | Page number |
| `limit` | number | Results per page |

### `GET /messages/recurring/:id`

Get a single recurring rule.

### `PATCH /messages/recurring/:id`

Update a recurring rule.

### `DELETE /messages/recurring/:id`

Delete/disable a recurring rule.

---

## Contacts

### `POST /contacts`

Create or upsert a contact.

**Body:**
```json
{
  "phone": "+919876543210",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "birthday": "03-15",
  "notes": "VIP patient",
  "labels": ["label-uuid-1", "label-uuid-2"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `phone` | string | Yes | E.164 format (`+91XXXXXXXXXX`) |
| `name` | string | No | Display name |
| `email` | string | No | Email address |
| `birthday` | string | No | `MM-DD` format (enables auto-reminders) |
| `notes` | string | No | Free-text notes |
| `labels` | string[] | No | Label UUIDs to assign |

### `GET /contacts`

List contacts.

| Query Param | Type | Description |
|-------------|------|-------------|
| `search` | string | Search by name or phone |
| `label` | string | Filter by label ID |
| `page` | number | Page number (default: 1) |
| `limit` | number | Results per page (default: 50) |

### `GET /contacts/:id`

Get a single contact with labels.

### `PUT /contacts/:id`

Update a contact.

### `DELETE /contacts/:id`

Delete a contact.

### `POST /contacts/:id/labels`

Assign labels to a contact.

**Body:**
```json
{ "labelIds": ["label-uuid-1", "label-uuid-2"] }
```

### `DELETE /contacts/:id/labels/:labelId`

Remove a label from a contact.

### `POST /contacts/import`

Bulk import contacts from CSV or Excel file (max 5MB).

**Body:** `multipart/form-data` with `file` field.

CSV format:
```
phone,name,email,birthday,notes
+919876543210,Jane Doe,jane@example.com,03-15,VIP
```

---

## Labels

### `POST /labels`

Create a label.

**Body:**
```json
{ "name": "VIP", "color": "#FF5733" }
```

### `GET /labels`

List all labels.

### `PUT /labels/:id`

Update a label.

### `DELETE /labels/:id`

Delete a label.

---

## Templates

### `POST /templates`

Create a message template with variable support.

**Body:**
```json
{
  "name": "appointment-reminder",
  "content": "Hi {{name}}, your appointment is on {{date}} at {{time}}."
}
```

### `GET /templates`

List all templates.

### `GET /templates/:id`

Get a single template.

### `PUT /templates/:id`

Update a template.

### `DELETE /templates/:id`

Delete a template.

### `POST /templates/:id/preview`

Preview a template with variable substitution.

**Body:**
```json
{
  "contactId": "contact-uuid",
  "variables": { "date": "March 15", "time": "2:00 PM" }
}
```

---

## Groups

### `POST /groups/sync`

Sync WhatsApp groups from the connected account.

### `GET /groups`

List synced groups.

| Query Param | Type | Description |
|-------------|------|-------------|
| `search` | string | Search by group name |
| `page` | number | Page number |
| `limit` | number | Results per page |

### `GET /groups/:id`

Get a single group by JID.

---

## Rate Limits

### `GET /rate-limit/status`

Check current rate limit usage.

**Response:**
```json
{
  "sentToday": 25,
  "dailyCap": 30,
  "remaining": 5,
  "resetAt": "2026-03-11T00:00:00.000Z",
  "warning": true
}
```

> Default daily cap: 30 messages. Resets at midnight IST.

---

## WebSocket

Connect for real-time events:

```
wss://hercare.wabridge.co.in/ws?apiKey=YOUR_API_KEY
```

### Events

| Event | Description |
|-------|-------------|
| `qr` | QR code for WhatsApp pairing |
| `connected` | WhatsApp session established |
| `disconnected` | WhatsApp session lost |
| `message.sent` | Message delivered successfully |
| `message.failed` | Message delivery failed |
| `message.received` | Incoming message received |

**Example payload:**
```json
{
  "event": "message.sent",
  "data": {
    "id": "msg-uuid",
    "to": "+919876543210",
    "status": "sent",
    "sentAt": "2026-03-10T10:00:05.000Z"
  }
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Description of the error"
}
```

| Status | Meaning |
|--------|---------|
| 400 | Validation error (bad request body) |
| 401 | Invalid or missing API key |
| 404 | Resource not found |
| 409 | Conflict (e.g. duplicate label name) |
| 429 | Daily rate limit exceeded |
| 500 | Internal server error |
| 503 | WhatsApp not connected |

---

## Notes

- **Phone numbers** must be in E.164 format: `+91XXXXXXXXXX`
- **Timezone**: All scheduling uses IST (Asia/Kolkata)
- **Rate limiting**: Messages are sent with random 2–8 second delays to avoid WhatsApp detection
- **Media types**: `image`, `video`, `audio`, `document`
- **Template variables**: Use `{{variable}}` syntax — `{{name}}` and `{{phone}}` are auto-filled from contact data
