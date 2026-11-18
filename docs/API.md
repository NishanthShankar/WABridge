# WABridge API Reference

Complete developer guide for integrating with the WABridge API.

**Base URL:** `http://localhost:4000/api`

**Authentication:** All routes (except health) require an `X-API-Key` header:

```
X-API-Key: sk_your_key_here
```

**This whole reference as markdown:** `GET /api/docs` (same `X-API-Key`). It also includes the docs of any extensions loaded on the server. Point an agent at it to learn the API:

```bash
curl -H "X-API-Key: sk_..." https://<tenant>.wabridge.co.in/api/docs
```

Only some sections: `GET /api/docs?section=polls,reply-lane` (comma-separated ids; the base URL and auth intro are always included). The ids come from the `##` headings: `GET /api/docs/sections` lists them as `{ "sections": [{ "id", "title", "source", "bytes" }] }`, where `source` is `core` or the extension's package name. An unknown id answers `404 unknown_section` with the list of valid ids.

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

### Send a message to a group

```bash
curl -X POST http://localhost:4000/api/messages \
  -H "X-API-Key: sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "groupId": "120363123456@g.us",
    "content": "Hello group!"
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

## Contact tags

The bridge's own tags on contacts, used to group and filter them (e.g. "VIP"). They live only in the bridge: WhatsApp never sees them. **Not** WhatsApp Business chat labels: those are [Chat lists](#chat-lists) at `/api/lists`.

`/api/contact-tags` is the current name. The old `/api/labels` paths still work the same, and answer with a `Deprecation: true` header pointing to `/api/contact-tags`. Tagging a contact stays at `POST /api/contacts/:id/labels`.

### POST /api/contact-tags

Create a tag.

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

### GET /api/contact-tags

List all tags.

### PUT /api/contact-tags/:id

Update a tag. Returns `404` if not found, `409` if name conflicts.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | 1–50 chars |
| `color` | string \| null | Hex color or `null` to clear |

### DELETE /api/contact-tags/:id

Delete a tag. Returns `{ "deleted": true }` or `404`.

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

## Groups

Sync and browse WhatsApp groups the connected account participates in. Groups are identified by their JID (e.g. `120363123456@g.us`).

### POST /api/groups/sync

Fetch all groups from WhatsApp and upsert into the local database. Call this to discover new groups or refresh metadata.

**Response:**

```json
{
  "synced": 12
}
```

Returns `503` if WhatsApp is not connected.

### GET /api/groups

List synced groups with optional search.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `search` | string | — | Search by group name |
| `limit` | number | 50 | 1–200 |
| `offset` | number | 0 | Pagination offset |

**Response:**

```json
{
  "data": [
    {
      "id": "120363123456@g.us",
      "name": "Project Team",
      "description": "Team chat for Project X",
      "participantCount": 15,
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:00:00.000Z"
    }
  ],
  "total": 12,
  "limit": 50,
  "offset": 0
}
```

### GET /api/groups/:id

Get a single group by JID. Returns `404` if not found.

---

## Messages

### POST /api/messages

Schedule a message or send immediately. Supports both individual contacts and groups.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `contactId` | string (UUID) | One of these | Existing contact ID |
| `phone` | string | is required | Phone number (auto-creates contact if new) |
| `groupId` | string | | Group JID (e.g. `120363123456@g.us`) |
| `name` | string | No | Contact name (used with `phone`) |
| `content` | string | Yes | Message text (min 1 char) |
| `scheduledAt` | string | No | ISO datetime. Omit to send immediately. |
| `mediaUrl` | string (URL) | No | URL to media file |
| `mediaType` | string | If mediaUrl set | `image`, `video`, `audio`, `document`, `sticker` (a WebP image), `videoNote` (a short square MP4, shown as a round video), `voiceNote` (audio shown as a voice message) or `gif` (a short MP4 that loops silently) |
| `location` | object | No | A map pin instead of text: `{latitude, longitude, name?, address?}` |
| `contact` | object or array | No | A contact card instead of text: `{name, phone, org?, email?}`, or up to 10 of them in one message |
| `event` | object | No | A calendar event card: see [Events](#events) |
| `groupInvite` | object | No | An invite card for a group this account is an admin of: `{groupId, text?}` |
| `product` | object | No | Business accounts: a catalog product card. See [Product cards](#product-cards) |
| `reaction` | object | No | React to a message instead of sending one: `{messageId, emoji, fromMe?, participant?}`. `emoji: ""` removes the reaction |
| `viewOnce` | boolean | No | `image`, `video`, `audio`, `voiceNote`: the recipient can open it only once |
| `fileName` | string | No | `document`: the name the recipient sees. Default: the last part of the URL |
| `mimetype` | string | No | `document`, `audio`, `voiceNote`: the file's type. Default: guessed from the file extension |
| `mentions` | string[] | No | Phones or JIDs to @mention. Put `@<number>` in `content` where each should appear |
| `quote` | object | No | Show the message as a reply to another: `{messageId, fromMe?, participant?, text?}`. `text` is what WhatsApp shows inside the quote |

> Provide exactly one of `contactId`, `phone`, or `groupId`. Send one of `mediaUrl`, `location`, `contact`, `event`, `groupInvite`, `product` or `reaction` per message. Like polls, these are stored with their kind in `mediaType` and their fields as JSON in `content`. `viewOnce`, `fileName`, `mimetype`, `mentions` and `quote` are for text and media, and come back in the stored message's `options` (a JSON string). For group messages, the group must be synced first via `POST /api/groups/sync`.

#### Voice notes

`"mediaType": "voiceNote"` shows the audio as a voice message, with the waveform and the microphone icon. Use an **OGG file with Opus audio**: WhatsApp's own format. Other formats are sent as given, but some phones won't play them. Plain `"audio"` shows as an audio file, in any common format (MP3, M4A, OGG).

#### Events

```json
{
  "groupId": "120363123456@g.us",
  "event": {
    "name": "Clinic review call",
    "description": "Monthly review",
    "startAt": "2026-11-20T10:00:00+05:30",
    "endAt": "2026-11-20T10:30:00+05:30",
    "location": { "latitude": 12.9716, "longitude": 77.5946, "name": "City Clinic" },
    "call": "video",
    "extraGuestsAllowed": true
  }
}
```

People answer Going, Maybe or Can't go on the card. Only `name` and `startAt` are required; times need an offset (`+05:30` or `Z`). `call` (`"audio"` or `"video"`) adds a WhatsApp call link to the event. `ref` is your own id for the event. Each answer comes back as an `event.response` webhook, and `GET /api/events` has the totals: see [Events: answers](#events-answers).

#### Group invite cards

`"groupInvite": { "groupId": "120363123456@g.us", "text": "Join the patients group" }` sends a tappable card rather than a bare link. The card is valid for three days. This account must be an admin of the group; otherwise the message fails with that reason.

#### Product cards

For WhatsApp Business accounts. `GET /api/profile/business/catalog` lists the catalog's products in this same shape:

```json
{ "phone": "919876543210", "product": { "productId": "7210983457", "title": "Heartbeat scan", "currency": "INR", "price": 499, "imageUrl": "https://example.com/scan.jpg", "description": "20 minutes", "url": "https://example.com/scan", "body": "As discussed", "footer": "City Clinic" } }
```

`productId`, `title`, `currency`, `price` and `imageUrl` are required.

**Response:** `201`

```json
{
  "id": "msg-uuid",
  "contactId": "contact-uuid",
  "groupId": null,
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
- `404` — Contact or group not found
- `429` — Daily rate limit reached

> If `scheduledAt` is omitted or in the past, the message sends immediately.

### POST /api/messages/bulk

Send up to 500 messages at once. Each item accepts `contactId`, `phone`, or `groupId`.

```json
{
  "messages": [
    { "phone": "919876543210", "content": "Hello A!" },
    { "phone": "919876543211", "content": "Hello B!", "scheduledAt": "2025-03-15T03:30:00.000Z" },
    { "groupId": "120363123456@g.us", "content": "Hello group!" }
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
  "data": [ /* ScheduledMessage objects with contactName, contactPhone, groupName */ ],
  "total": 250
}
```

Each message includes `contactName`, `contactPhone` (for individual messages) and `groupName` (for group messages).

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

## Sent messages: edit, delete, forward

These act on messages that are already in WhatsApp. Name the message in one of two ways:

| Field | Description |
|-------|-------------|
| `chatId` or `phone` + `messageId` | The chat (a JID from a webhook's `chatId`, or a phone number) and the WhatsApp message id: `messageId` from `POST /api/reply`, from a webhook, or `whatsappMessageId` from `GET /api/messages/:id` |
| `scheduledMessageId` | The `id` that `POST /api/messages` returned, once the message has been sent |

None of these count toward the daily cap. Message text is never logged.

### POST /api/messages/edit

Change the text of a message this account sent. WhatsApp allows edits for **15 minutes** after sending. The chat shows it as "Edited".

```bash
curl -X POST http://localhost:4000/api/messages/edit \
  -H "X-API-Key: ..." -H "Content-Type: application/json" \
  -d '{"scheduledMessageId": "58282874-...", "text": "3 studies from QUANTUM assigned to you"}'
```

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | The new text (1-4096 characters) |

Returns `{ "edited": true, "chatId": "...", "messageId": "..." }`. With `scheduledMessageId`, the stored `content` is updated too.

| Error | Status | When |
|-------|--------|------|
| `edit_window_closed` | 409 | Sent more than 15 minutes ago |
| `not_own_message` | 409 | Someone else wrote it |
| `not_text` | 409 | Media or a poll: only text messages can be edited |
| `not_sent` | 409 | `scheduledMessageId` of a message that has not been sent yet (use `PATCH /api/messages/:id`) |

The bridge checks the age and type only when it knows the message (sent or seen in the last 72 hours, or by `scheduledMessageId`). Otherwise the edit is sent and WhatsApp ignores it if it is too late.

### POST /api/messages/delete

Delete a message for everyone ("This message was deleted"). Works for about **two and a half days** after sending.

```bash
curl -X POST http://localhost:4000/api/messages/delete \
  -H "X-API-Key: ..." -H "Content-Type: application/json" \
  -d '{"chatId": "120363000000000001@g.us", "messageId": "3EB0..."}'
```

| Field | Type | Description |
|-------|------|-------------|
| `fromMe` | boolean | Default `true`. `false`: someone else's message in a group where this account is **admin** |
| `participant` | string | With `fromMe: false`: who wrote it (the webhook's `from` phone, or `fromLid`) |

Returns `{ "deleted": true, "chatId": "...", "messageId": "..." }`. Errors: `delete_window_closed` (409), `not_group` (400, `fromMe: false` outside a group). Polls have their own `DELETE /api/polls/:id`.

### POST /api/messages/forward

Forward a recent message to another chat or group. It arrives marked "Forwarded". Media is forwarded without downloading or uploading it again.

```bash
curl -X POST http://localhost:4000/api/messages/forward \
  -H "X-API-Key: ..." -H "Content-Type: application/json" \
  -d '{"chatId": "919876543210@s.whatsapp.net", "messageId": "3EB0...", "toChatId": "120363000000000001@g.us"}'
```

| Field | Type | Description |
|-------|------|-------------|
| `toChatId` or `toPhone` | string | Where to forward it. Exactly one |

Returns `{ "forwarded": true, "chatId": "<destination>", "messageId": "<new message id>" }`.

- Only **recent** messages can be forwarded: those this connection sent or received in the last 72 hours since the server last restarted (at most 2000, held in memory only, never on disk). Others get `404 not_found`.
- A **group** this account is in can always receive a forward. A **1:1 chat** only inside its 24 hour reply window, like `POST /api/reply`; otherwise `409 outside_reply_window`.
- At most 12 forwards per destination chat per minute (`429 too_many_forwards`).

### POST /api/messages/star

Star or unstar a message on this account's phone (only this account sees stars).

```json
{ "chatId": "919876543210@s.whatsapp.net", "messageId": "3EB0...", "star": true }
```

`fromMe` is taken from what the bridge saw; give it (`true` for a message this account sent) when the message is older than 72 hours. Returns `{ "starred": true, "chatId", "messageId" }`.

### POST /api/messages/pin

Pin a message at the top of its chat **for everyone in it**, or unpin it. In a group, only admins can pin unless the group lets everyone edit its settings.

```json
{ "chatId": "120363123456@g.us", "messageId": "3EB0...", "pinned": true, "duration": "7d" }
```

`duration` is `24h`, `7d` (default) or `30d`. `"pinned": false` unpins. As with star, `fromMe` comes from what the bridge saw; for an older message give `fromMe`, and in a group `participant` (who wrote it). Returns `{ "pinned": true, "duration": "7d", "chatId", "messageId" }`.

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

## URLs the bridge downloads

Media (`mediaUrl`, stickers, video notes, Status), group and profile pictures, the business cover photo and webhook deliveries are fetched by the bridge. It only connects to **public internet addresses**: a URL that is not http(s), or whose host is or resolves to a loopback, private, link-local (including cloud metadata), carrier-grade NAT, multicast or reserved address, is refused. This holds on every redirect hop and is checked when connecting, so a hostname that changes its DNS answer can't get around it.

A refused media URL gives `400` on request (literal IP or bad scheme) or fails the send (`send_failed`, or a queued message's `failureReason`) when the hostname resolves to a private address. Self-hosters who serve media from their own network can set the environment variable `WABRIDGE_ALLOW_PRIVATE_URLS=1`.

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

## Webhooks

Register webhook URLs to get notified when a message is received from a specific phone number. Supports text messages, media (images, documents, audio, stickers), and shared locations.

### POST /api/webhooks

Create a webhook.

**Body:**

```json
{
  "phone": "919812345678",
  "url": "https://example.com/webhook",
  "secret": "optional-hmac-secret"
}
```

**Response (201):**

```json
{
  "id": "uuid",
  "phone": "919812345678",
  "url": "https://example.com/webhook",
  "enabled": true,
  "secret": "optional-hmac-secret",
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z"
}
```

### GET /api/webhooks

List all webhooks.

### GET /api/webhooks/:id

Get a single webhook by ID.

### PUT /api/webhooks/:id

Update a webhook. All fields are optional.

**Body:**

```json
{
  "phone": "919812345678",
  "url": "https://example.com/new-url",
  "enabled": false,
  "secret": null
}
```

### DELETE /api/webhooks/:id

Delete a webhook.

### Webhook Payload

When a matching message arrives, WABridge sends a `POST` request to the webhook URL:

```json
{
  "event": "message.received",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "from": "919812345678",
  "messageId": "ABCDEF123456",
  "text": "Hello!",
  "hasMedia": false,
  "rawType": "conversation"
}
```

**With media (image, document, audio, sticker):**

```json
{
  "event": "message.received",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "from": "919812345678",
  "messageId": "ABCDEF123456",
  "text": null,
  "hasMedia": true,
  "rawType": "imageMessage",
  "media": {
    "type": "image",
    "mimetype": "image/jpeg",
    "data": "<base64-encoded file>",
    "filename": null,
    "caption": "Check this out"
  }
}
```

**With a shared location:**

When the sender shares a location pin (or starts sharing live location), the payload includes a `location` object:

```json
{
  "event": "message.received",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "from": "919812345678",
  "messageId": "ABCDEF123456",
  "text": null,
  "hasMedia": false,
  "rawType": "locationMessage",
  "location": {
    "latitude": 12.9716,
    "longitude": 77.5946,
    "isLive": false,
    "name": "Cubbon Park",
    "address": "Kasturba Road, Bengaluru, Karnataka",
    "url": null,
    "comment": null,
    "accuracyInMeters": null,
    "speedInMps": null,
    "degreesClockwiseFromMagneticNorth": null,
    "sequenceNumber": null
  }
}
```

| Field | Description |
|-------|-------------|
| `latitude` / `longitude` | Coordinates in decimal degrees |
| `isLive` | `true` for live location shares |
| `name` / `address` | Place name and address, when the sender picked a named place (otherwise `null`) |
| `url` | Place URL, if WhatsApp attached one |
| `comment` | Caption/comment added by the sender |
| `accuracyInMeters`, `speedInMps`, `degreesClockwiseFromMagneticNorth` | Extra GPS details, mostly present for live locations |
| `sequenceNumber` | Live location update sequence (live locations only) |

`rawType` is `locationMessage` for a pinned location and `liveLocationMessage` for live location. To open the location in Google Maps: `https://maps.google.com/?q={latitude},{longitude}`.

> **Note:** For live location, the webhook fires for the initial share. WhatsApp doesn't reliably forward the ongoing position updates to linked devices, so don't count on a continuous stream.

### Reply Actions

A webhook receiver can ask WABridge to act on the message it was just given, by answering `200` with `Content-Type: application/json` and a body like:

```json
{ "delete": true, "ephemeral": 86400 }
```

| Field | Meaning |
|-------|---------|
| `delete` | `true` removes the incoming message from this account's chat history on all its linked devices ("delete for me"). WhatsApp does not allow deleting someone else's message for everyone, so the sender keeps their copy. |
| `ephemeral` | Sets the chat's disappearing-message timer, in seconds: `0` (off), `86400`, `604800` or `7776000`. With a timer set, later messages in the chat vanish from both sides when it runs out. |

Both are optional. Any other body is ignored. `GET /api/health` lists `"webhook-reply-actions"` under `features` on servers that support this.

### Signature Verification

If a `secret` is configured, WABridge includes an `X-Webhook-Signature` header containing an HMAC-SHA256 hex digest of the request body:

```
X-Webhook-Signature: a1b2c3...
```

Verify on your server:

```js
const crypto = require('crypto');
const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
if (signature !== expected) throw new Error('Invalid signature');
```

> **Note:** Video messages are not included in webhook payloads to avoid oversized requests.

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

---

## Reply lane

### POST /api/reply

Answer a chat that wrote to this account in the last 24 hours, with text, media or a reaction. Sends at once: no queue, no random delay, and it does **not** count toward `rate_limit.daily_cap`. A chat that has not written in 24 hours gets `409 outside_reply_window`; send to it with `POST /api/messages` instead (queued and capped). Per chat, at most 12 units a minute: a message (text, media or poll) costs 1, a reaction 0.25 (so 48 reactions, or 11 messages and 4 reactions). Over that: `429 too_many_replies` with `retryAfterSeconds`. `DELETE /api/polls/:id` and the bridge's own responses to votes don't count. The count is kept in memory and resets on restart. Answers are not stored and their text is never logged.

| Field | Type | Notes |
|---|---|---|
| `chatId` or `phone` | string | Exactly one. `chatId` is the webhook's `chatId` (works for groups and LID senders). |
| `text` | string | Up to 4096 characters. With `mediaUrl` it is the caption (ignored for audio). |
| `mediaUrl` | string | Public http(s) URL of the file. The bridge downloads it and sends it. |
| `mediaType` | `image` \| `video` \| `audio` \| `document` \| `sticker` \| `videoNote` \| `voiceNote` \| `gif` | Required with `mediaUrl`. `sticker`: a WebP image. `videoNote`: a short square MP4, shown as a round video. `voiceNote`: OGG/Opus audio, shown as a voice message. `gif`: a short MP4 that loops. sticker, videoNote, voiceNote and audio have no caption. |
| `viewOnce`, `fileName`, `mimetype` | | As on [`POST /api/messages`](#post-apimessages). |
| `location` | `{latitude, longitude, name?, address?}` | Send a map pin, e.g. a clinic's location. Sent after any `text`. |
| `contact` | `{name, phone, org?, email?}` or an array (up to 10) | Send a contact card, e.g. a doctor's number. Sent after any `text`. |
| `event`, `groupInvite`, `product` | object | An event card, a group invite card or a catalog product card, as on [`POST /api/messages`](#post-apimessages). Sent after any `text`. |
| `quote` | `{messageId, fromMe?, participant?, text?}` | Show the answer as a reply to that message. In groups `participant` is who wrote it. |
| `mentions` | string[] | Phones or JIDs to @mention. Put `@<number>` in `text` where each should show. |
| `reaction` | `{messageId, emoji, fromMe?, participant?}` | React to a message. `emoji: ""` removes the reaction. |
| `poll` | object | Send a poll. Sent on its own, without `text` or `mediaUrl`. See [Polls](#polls). |
| `typing` | boolean | Show "typing…" briefly before the text. Default `true`. |
| `dontSkip` | boolean | ⚠️ Outside the 24 hour window, queue this instead of answering `409`. **Read [Outside the window](#outside-the-window-dontskip-and-forcepoll) first.** |
| `forcePoll` | boolean | ⚠️ Outside the window, send `poll` as a real poll (queued). **Read [Outside the window](#outside-the-window-dontskip-and-forcepoll) first.** |

Give `text`, `mediaUrl`, `poll`, `reaction` or a mix. Media follows the same rules as text: 24 hour window, no delay, not counted toward the daily cap. `GET /api/health` lists `"reply-media"` under `features` on servers that accept media here, and `"reply-poll"` on servers that accept `poll`.

```bash
curl -X POST https://<tenant>.wabridge.co.in/api/reply \
  -H "X-API-Key: sk_..." -H "Content-Type: application/json" \
  -d '{"chatId":"919812345678@s.whatsapp.net","text":"Added: buy milk","quote":{"messageId":"3EB0...","text":"buy milk"}}'
```

Sending an image:

```bash
curl -X POST https://<tenant>.wabridge.co.in/api/reply \
  -H "X-API-Key: sk_..." -H "Content-Type: application/json" \
  -d '{"chatId":"919812345678@s.whatsapp.net","text":"Step 1: open Settings","mediaUrl":"https://example.com/guide/step1.png","mediaType":"image"}'
```

Response: `{ "messageId": "3EB0...", "reactionId": null, "chatId": "919812345678@s.whatsapp.net", "replyWindow": {...} }`.

Every answer, including `409` and `429`, carries the chat's window:

```json
"replyWindow": {
  "open": true,
  "lastInboundAt": "2026-11-18T10:00:00.000Z",
  "closesAt": "2026-11-19T10:00:00.000Z",
  "secondsSinceInbound": 90
}
```

Any message, poll vote, reaction, edit or delete from the chat reopens it. In a group, any member's activity opens it for the whole group.

### Outside the window: `dontSkip` and `forcePoll`

> ⚠️ **Use these carefully, and check with the account's owner before turning them on.**
> They send to people who have not written to this number in the last 24 hours. That is what gets WhatsApp numbers reported and banned: a person who didn't expect the message taps "Block" or "Report", and a few of those can lose the number for good. The 24 hour rule is WABridge's own safety rule, not WhatsApp's, so nothing else stops you. Only use these for people who know this number and expect to hear from it, never for cold lists, and never in a loop over many chats.

Without either flag, a chat outside the window gets `409 outside_reply_window`, as before. Inside the window both flags do nothing: the reply is sent at once as usual.

| Flag | Outside the window |
|---|---|
| `dontSkip: true` | The message goes through the queued route (`POST /api/messages`): a random 2-8 s delay, and it counts toward `rate_limit.daily_cap`. Text and media are sent as they are. A `poll` is sent as a **real poll** if the chat has written to this account before (at any time, same rule as `forcePoll`), and as **numbered text** ("1. A / 2. B / Reply with the number of your choice.") to anyone else. |
| `forcePoll: true` | The `poll` is sent as a **real poll** through the same queue. Votes work as usual (`poll.vote`, `GET /api/polls/:id`). **Only allowed for chats that have written to this account before**, at any time; otherwise `403 force_poll_not_allowed`, so a chat that never wrote is never sent a poll by mistake. Needs `poll`. Use it when you would rather get an error than numbered text. |

When queued:

- `reaction` and `typing` are dropped, and the response lists `reaction` in `dropped`. `quote`, `mentions` and the other send options are kept. A reaction alone can't be queued from here (`409`); `POST /api/messages` takes one.
- The response is `202`:

```json
{ "queued": true, "messageId": null, "scheduledMessageId": "8f1c...", "chatId": "919812345678@s.whatsapp.net",
  "sentAs": "poll", "dropped": [], "replyWindow": { "open": false, ... }, "rateLimit": { ... } }
```

- `sentAs` is `text`, `media`, `poll` or `pollAsText`. `messageId` is `null` because nothing has been sent yet. Follow it with `GET /api/messages/:scheduledMessageId`; once sent, its `whatsappMessageId` is the WhatsApp id (for a poll, the poll id used by `GET /api/polls/:id`). A queued poll shows in `/api/messages` with `mediaType: "poll"` and the poll as JSON in `content`.
- Over the daily cap: `429 daily_cap_reached`. A group must be in the local list (`POST /api/groups/sync`), or `409 group_not_synced`.
- Queued sends don't count toward the per-chat reply limit; they count toward the daily cap instead.

### GET /api/reply/window

The same `replyWindow` without sending anything: `?chatId=` or `?phone=`. Response: `{ "chatId", "replyWindow" }`. Use it to choose between `/api/reply` and `/api/messages` up front. `secondsSinceInbound` under a minute or two means they are very likely looking at the chat, whatever their privacy settings. Keep `messageId`: when the person later replies to this message, the webhook's `quoted.messageId` is this value.

## Chat state: presence and read receipts

What the bridge knows about a chat beyond its messages. `GET /api/health` lists `"reply-window"` and `"chat-presence"` on servers with this.

### GET /api/chats/:id

`:id` is a phone number or JID. Nothing is sent to WhatsApp.

```json
{
  "chatId": "919812345678@s.whatsapp.net",
  "replyWindow": { "open": true, "lastInboundAt": "...", "closesAt": "...", "secondsSinceInbound": 42 },
  "presence": { "presence": "available", "lastSeen": null, "at": "2026-11-18T10:00:40.000Z" },
  "lastRead": { "messageId": "3EB0...", "status": "read", "by": "919812345678", "at": "2026-11-18T10:00:35.000Z" }
}
```

- `presence`: the last one received (`available`, `unavailable`, `composing`, `recording`, `paused`), or `null`. Only arrives for chats being watched (below) and only if their privacy settings show it.
- `lastRead`: the last of our messages they read (`read`) or played (`played`, voice notes), or `null`. Only arrives if they have read receipts on.

Presence and read state are kept in memory: they reset when the server restarts or reconnects.

### GET /api/chats/:id/presence

Ask WhatsApp to send this person's presence, then return the latest one. `?wait=3000` waits up to that many milliseconds (max 5000) for a fresh update. The request is renewed at most once a minute per chat; updates keep arriving for a while after it.

```json
{ "chatId": "919812345678@s.whatsapp.net", "presence": { "presence": "available", "lastSeen": null, "at": "..." }, "fresh": true }
```

`fresh: false` means nothing new came in while waiting. That is common: many people hide their online status, and silence does **not** mean they are away. To decide whether someone is likely watching, prefer `replyWindow.secondsSinceInbound`.

### PATCH /api/chats/:id

Tidy this account's chat list, or set a disappearing-messages timer. Give any of these; the rest stay as they are. `:id` is a phone number, a chat JID or a group JID.

```json
{ "archived": true, "muted": "8h" }
```

| Field | Values | What it does |
|---|---|---|
| `pinned` | `true` / `false` | Pin the chat to the top of the list |
| `archived` | `true` / `false` | Move it to (or out of) Archived |
| `muted` | `"8h"`, `"1w"`, `"always"`, `false` | Mute notifications; `false` unmutes |
| `read` | `true` / `false` | `true` clears the unread badge, `false` marks the chat unread. No read receipt (blue ticks) is sent either way |
| `disappearing` | `"off"`, `"24h"`, `"7d"`, `"90d"` | Disappearing-messages timer. **The other side sees this**: WhatsApp posts "turned on disappearing messages" in the chat. In a group, only admins can change it unless the group allows everyone |
| `limitSharing` | `true` / `false` | WhatsApp's "advanced chat privacy": while on, people in the chat can't export it or have its media saved automatically. **The other side sees this** |

Response: `{ "chatId", "applied": ["archived", "muted"], "failed": [] }`. A change WhatsApp refused is in `failed` with its `error`; if all were refused the answer is `502 not_changed`. Everything except `disappearing` and `limitSharing` only changes how the chat looks on this account's phone and linked devices.

Archive and mark-read work best when the chat had a message since the server last started (the bridge passes WhatsApp the chat's last message, as the phone does).

### POST /api/chats/:id/phone-number

For 1:1 chats where WhatsApp hides phone numbers (the chat shows as a LID or a username). `{ "action": "share" }` shows this account's number to the chat; `{ "action": "request" }` asks the other side for theirs, which they can accept or ignore. Returns `{ "chatId", "action", "messageId" }`.

### PUT /api/chats/disappearing-default

The timer for **new** chats this account starts: `{ "disappearing": "24h" }` (`off`, `24h`, `7d`, `90d`). Existing chats keep theirs.

### Webhooks: `presence.update`, `message.read`

Sent to catch-all webhooks with `allEvents`.

```json
{ "event": "presence.update", "timestamp": "...", "chatId": "919812345678@s.whatsapp.net", "isGroup": false,
  "from": "919812345678", "presence": "composing", "lastSeen": null }
```

```json
{ "event": "message.read", "timestamp": "...", "chatId": "919812345678@s.whatsapp.net", "isGroup": false,
  "from": "919812345678", "messageId": "3EB0...", "status": "read", "readAt": "..." }
```

`message.read` fires once per message and reader for messages this account sent: in 1:1 chats when they open it, in groups for each member who reads it. `status` is `played` for a voice note they listened to.

## Polls

Send a poll with `POST /api/reply` (so the 24 hour window applies; to reach a chat outside it, see `forcePoll` under [Outside the window](#outside-the-window-dontskip-and-forcepoll), and use it carefully). Votes come back decrypted as `poll.vote` webhooks, and the bridge can respond to each vote by itself. `GET /api/health` lists `"poll-votes"` under `features` on servers with this.

```json
{
  "chatId": "919812345678@s.whatsapp.net",
  "poll": {
    "name": "Which slot works?",
    "options": ["Morning", "Afternoon", "Evening"],
    "multiple": false,
    "mode": "lockFirstVote",
    "react": "👍",
    "confirmText": "Got it: {{option}}. This answer is final."
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | The question, up to 255 characters. |
| `options` | string[] | 2 to 12 different choices, up to 100 characters each. |
| `multiple` | boolean | `true` lets people tick any number of options. Default `false` (pick one). |
| `mode` | string | What a vote does. `updateEveryTime` (default), `lockFirstVote` or `deleteAfterVote`. See below. |
| `react` | string \| `false` | Emoji the bridge reacts to the poll with after a vote that counts. Default `👍`. `false` turns it off. Not used by `deleteAfterVote`. |
| `confirmText` | string \| `false` | Message sent after a vote that counts. `{{option}}` becomes the choice (several joined with ", "), `{{poll}}` the question. Default: none, except `deleteAfterVote`, which defaults to `You chose {{option}}`. `false` turns it off. |
| `stealth` | boolean | Privacy: answers are never written to the database or the logs. See [Stealth polls](#stealth-polls). Default `false`. |
| `ref` | string | Your own id for this poll, up to 128 characters. Echoed in `poll.vote`, `poll.deleted` and `poll.delete_failed`, and searchable with `GET /api/polls?ref=`. Use an id, not personal data. |
| `deleteAt` | string | ISO time (with offset) to delete the poll for everyone **if nobody has voted by then**. Must be in the future and within 48 hours: WhatsApp only deletes for everyone for about two days. Checked every 10 seconds. A queued poll that goes out after its `deleteAt` is deleted at the next check. |

The response's `messageId` is the poll's id.

### Modes

WhatsApp always lets people change their vote, and has no setting to stop it. The modes decide what the bridge does about it.

| Mode | Which vote counts | What the bridge does |
|---|---|---|
| `updateEveryTime` | Every vote. The latest one is the person's answer. Removing all ticks clears it. | Reacts (and sends `confirmText` if set) after each vote. Removing the vote removes the reaction. |
| `lockFirstVote` | The first vote only. Later changes are recorded with `note: "locked"` and don't count. | Reacts and sends `confirmText` once, after the first vote. Their phone still shows a changed vote; only the bridge keeps the first. |
| `deleteAfterVote` | The first vote. | Sends `confirmText` (default `You chose {{option}}`), then deletes the poll for everyone, so it can't be changed. Meant for 1:1 chats: in a group, the first voter ends the poll for everyone. |

**Deletes are retried.** If deleting a poll fails (`deleteAfterVote`, `deleteAt`), the bridge tries again after 10 s, 1 min, 5 min, 15 min and 1 h. Each later success sends `poll.deleted`; after the last failure it sends `poll.delete_failed` and stops. A disconnected server waits for the connection without using up tries. `DELETE /api/polls/:id` is not retried: it answers `502` and you decide.

**Multi-choice polls** (`multiple: true`): WhatsApp sends a new vote on every tap. In `lockFirstVote` and `deleteAfterVote` the bridge waits until the person has stopped changing their ticks for 15 seconds, then locks (or deletes). Votes during that time arrive with `note: "settling"`, and one more `poll.vote` with `note: null` arrives when it becomes final. A server restart during those 15 seconds leaves the vote counted but unconfirmed.

### Webhook: `poll.vote`

Sent to the same webhooks as messages from that chat (1:1: the sender's phone webhooks and catch-alls; groups: `allEvents` catch-alls).

```json
{
  "event": "poll.vote",
  "timestamp": "2026-11-18T10:00:00.000Z",
  "from": "919812345678",
  "chatId": "919812345678@s.whatsapp.net",
  "isGroup": false,
  "pushName": "Asha",
  "pollId": "3EB0...",
  "pollName": "Which slot works?",
  "mode": "lockFirstVote",
  "multiple": false,
  "voterPhone": "919812345678",
  "selected": ["Morning"],
  "counted": true,
  "note": null,
  "current": ["Morning"],
  "pollDeleted": false
}
```

- `selected`: what this vote picked (empty when they removed their vote).
- `counted`: whether the mode accepted it.
- `note`: `null` (counts, final), `settling` (multi-choice, still tapping), `locked`, `poll_deleted`, `empty` or `superseded`.
- `current`: what counts for this person now. **Use this as their answer.**
- `ref`: the `ref` you sent the poll with, or `null`.

### Webhooks: `poll.deleted`, `poll.delete_failed`

Sent to the same webhooks as the poll's votes when the bridge deletes a poll **later** than the vote that caused it: at `deleteAt` (`reason: "expired"`), after a retry (`reason: "voted"`), or after a stealth vote was acknowledged (`reason: "voted"`). A delete that happens straight after a vote is reported in that vote's `pollDeleted: true` instead.

```json
{ "event": "poll.deleted", "timestamp": "...", "chatId": "919812345678@s.whatsapp.net", "isGroup": false,
  "pollId": "3EB0...", "pollName": "Which slot works?", "ref": "q-42", "reason": "expired", "attempts": 1 }
```

`poll.delete_failed` has the same fields plus `error`, and means the poll is still on their phone. `GET /api/polls/:id` shows it as `deleteFailedAt`.

Only polls sent after this feature was deployed can be read: a vote is encrypted with a secret the bridge keeps when it sends the poll.

### Stealth polls

For questions whose answers must not be kept (health, money, anything private), send the poll with `"stealth": true`. `GET /api/health` lists `"poll-stealth"` on servers with this.

- **Never written down.** The bridge decrypts each vote in memory, responds as the mode says, and hands the `poll.vote` webhook over. No answer is stored in the database, and no answer appears in the server logs.
- **Held until you acknowledge it.** Each stealth `poll.vote` carries a `voteId` and an `expiresAt`. It is kept in memory only until it is acknowledged:
  - A webhook that answers `2xx` acknowledges it, and it is deleted at once. Retries (2 s, then 10 s) send the same `voteId`.
  - If no webhook took it (none registered, receiver down), fetch it with `GET /api/polls/pending` and acknowledge it with `POST /api/polls/pending/ack`.
  - Unacknowledged votes are deleted after **1 hour**, and all of them are lost if the server restarts. Pick them up promptly.
- **Locks still work.** In `lockFirstVote` and `deleteAfterVote` the bridge keeps one row saying *that* this person voted (with no answer), so later changes are still refused. `updateEveryTime` keeps nothing at all.
- **What you get.** `current` is the answer only on the vote that is final for this person (`counted: true`, `note: null`); on locked, settling and other votes it is `null`, because the bridge no longer knows the earlier answer. Keep the final answer on your side.
- **Results are not available.** `GET /api/polls/:id` returns `"stealth": true`, `"results": null` and `"votes": []`.
- **`deleteAfterVote` waits for you.** The poll is deleted, and `confirmText` sent, only once you acknowledge the vote (webhook `2xx` or `POST /api/polls/pending/ack`). The vote arrives with `"awaitingAck": true`, and `poll.deleted` follows once the poll is gone. If the vote expires unacknowledged, or the server restarts first, the poll stays on their phone and the lock is released: their next change of vote counts as a new vote.
- **Mind the chat itself.** `confirmText` with `{{option}}` writes the answer into the WhatsApp chat, where both phones keep it. Turn it off (`"confirmText": false`) if that matters; `deleteAfterVote` uses it by default.

```json
{ "event": "poll.vote", "pollId": "3EB0...", "stealth": true, "selected": ["Yes"], "counted": true, "note": null,
  "current": ["Yes"], "voteId": "6c1e7a4e-...", "expiresAt": "2026-11-18T11:00:00.000Z", ... }
```

#### GET /api/polls/pending

Stealth votes not yet acknowledged, oldest first. `?pollId=` for one poll. Response: `{ "votes": [ <poll.vote payload>, ... ] }`.

#### POST /api/polls/pending/ack

Body `{ "voteIds": ["6c1e7a4e-...", ...] }` (1 to 500). Deletes them now. Response: `{ "acked": 1, "unknown": 0 }`; `unknown` counts ids that were already gone (acknowledged, expired or lost in a restart).

### GET /api/polls/:id

`:id` is the poll id, or the `scheduledMessageId` a queued poll (`dontSkip` / `forcePoll`) returned. A queued poll that hasn't gone out yet answers `409 not_sent_yet` with its `status`. The response also has `ref`, `votedAt` (when someone last voted, never what), `deleteAt` and `deleteFailedAt`.

The poll, results and every vote received, oldest first.

```json
{
  "id": "3EB0...", "chatId": "919812345678@s.whatsapp.net", "name": "Which slot works?",
  "options": ["Morning", "Afternoon", "Evening"], "multiple": false, "mode": "lockFirstVote",
  "createdAt": "...", "deletedAt": null,
  "results": {
    "tally": { "Morning": 1, "Afternoon": 0, "Evening": 0 },
    "voters": [{ "voter": "5550001@lid", "phone": "919812345678", "selected": ["Morning"], "at": "..." }]
  },
  "votes": [
    { "phone": "919812345678", "selected": ["Morning"], "counted": true, "note": null, "at": "..." },
    { "phone": "919812345678", "selected": ["Evening"], "counted": false, "note": "locked", "at": "..." }
  ]
}
```

### GET /api/polls

Recent polls, newest first, with results (no vote history). Query: `chatId` or `phone` to filter by chat, `ref` for your own id, `limit` (default 20, max 100).

### DELETE /api/polls/:id

Delete the poll for everyone in the chat. `:id` may also be a queued poll's `scheduledMessageId`: if it hasn't gone out yet it is cancelled instead (`{ "deleted": false, "cancelled": true }`). WhatsApp allows this for about 2 days after sending. Votes already received are kept. Reactions on the poll (such as the bridge's 👍) disappear with it (tested 2026-11-18): if the person should keep a record of their answer, send it as a separate message (`confirmText`). Response: `{ "deleted": true, "deletedAt": "..." }`. Deleting an already deleted poll does nothing and returns the same.

## Events: answers

An event card is sent with `event` on [`POST /api/messages`](#post-apimessages) or `POST /api/reply`. When someone taps Going, Maybe or Can't go, the bridge decrypts the answer and keeps each person's latest one.

`GET /api/health` lists `"event-responses"` under `features` on servers that do this. Events sent before that (or by a phone, not through the API) can't be read.

### Webhook: `event.response`

Goes to the same webhooks as messages: a webhook registered for the sender's phone, and, for groups, webhooks with `allEvents`.

```json
{
  "event": "event.response",
  "timestamp": "2026-11-18T17:20:00.000Z",
  "from": "919812345678",
  "fromLid": null,
  "pushName": "Asha",
  "chatId": "120363123456@g.us",
  "isGroup": true,
  "group": { "id": "120363123456@g.us", "name": "Clinic team" },
  "messageId": "3EB0...",
  "eventId": "3EB0A1...",
  "ref": "review-nov",
  "name": "Clinic review call",
  "startAt": "2026-11-20T04:30:00.000Z",
  "endAt": "2026-11-20T05:00:00.000Z",
  "createdAt": "2026-11-18T17:00:00.000Z",
  "response": "going",
  "extraGuests": 1,
  "previousResponse": "maybe",
  "counts": { "going": 4, "notGoing": 1, "maybe": 0, "extraGuests": 1 }
}
```

`response` is `going`, `notGoing` or `maybe`. `previousResponse` is what this person had answered before, or `null` for a first answer. `counts` are the totals after this answer; `counts.extraGuests` adds up the guests of people who are going. `eventId` is the WhatsApp message id of the card.

### GET /api/events/:id

The event with `counts` and `responses`: each person's latest answer as `{ "from", "fromJid", "response", "extraGuests", "at" }`. `:id` is the `eventId`, or the `id` that `POST /api/messages` returned (`409 not_sent_yet` while it is still queued).

### GET /api/events

Recent events, newest first, with `counts` but without `responses`. Filters: `?chatId=` or `?phone=`, `?ref=`, `?limit=` (1-100, default 20).

## Chat lists

The filters above this account's chat list on the phone: WhatsApp's own (Unread, Favourites, Groups, Communities) and custom lists such as "Clients". Lists are **private to this account**: nobody in the chats sees them or is told. They sync to the account's phone and other linked devices. `GET /api/health` lists `"chat-lists"` on servers with this.

| Call | What it does |
|---|---|
| `GET /api/lists` | Every list and the chats in it: `{ synced, lists: [{ id, name, color, builtIn, chats: [{ chatId, phone, isGroup }] }] }` |
| `GET /api/lists/:id` | One list |
| `POST /api/lists/sync` | Fetch every list again from WhatsApp. Needed once for a number linked before this feature (`synced: false`); after that, changes made on the phone arrive by themselves. |
| `POST /api/lists` | `{ "name": "Clients", "color": 0, "chats": ["919812345678", "120363...@g.us"] }` → `201` with the new list. `color` is 0-19 (WhatsApp's palette), `chats` optional. Syncs first if the number never has. `409 name_taken` if a list already has that name. |
| `PATCH /api/lists/:id` | `{ "name"?, "color"? }`: rename or recolour |
| `DELETE /api/lists/:id` | Delete the list. The chats in it are not touched. |
| `POST /api/lists/:id/chats` | `{ "add": [...], "remove": [...] }`: phones or JIDs, 1:1 chats or groups, up to 100 each. Response: `{ results: [{ chat, action, ok, error? }], list }` |

WhatsApp's own lists (`builtIn: true`) fill themselves, so they can't be renamed, deleted or filled here (`409 built_in_list`), and their names can't be reused.

### Webhook: `list.updated`

Sent to catch-all webhooks with `allEvents` whenever a list changes, on the phone or through this API:

```json
{ "event": "list.updated", "timestamp": "...", "change": "chat_added", "listId": "5", "name": "Clients",
  "chatId": "919812345678@s.whatsapp.net", "isGroup": false }
```

`change` is `created`, `edited`, `deleted`, `chat_added` or `chat_removed` (the last two carry `chatId` and `isGroup`). A sync does not fire them for lists that were already there.

### GET /api/groups/:id/participants

Live member list from WhatsApp: `{ id, name, participants: [{ jid, phone, lid, admin, isMe }] }`. `phone` is null when a member hides their number and the LID can't be mapped.

## Webhook events (allEvents)

Create a catch-all webhook (no `phone`) with `"allEvents": true` to also receive group messages and the events below. Webhooks without it get only 1:1 `message.received`, as before.

Every `message.received` now also carries:

```json
{
  "chatId": "120363012345678@g.us",
  "isGroup": true,
  "group": { "id": "120363012345678@g.us", "name": "Flat 4B" },
  "pushName": "Asha",
  "isVoiceNote": false,
  "mentions": [{ "jid": "2384756@lid", "phone": "919812345678", "isMe": true }],
  "botMentioned": true,
  "quoted": { "messageId": "3EB0...", "fromMe": true, "participant": "919000000000", "text": "Added: buy milk" }
}
```

In a group, `from` is the member who wrote. `quoted` is null unless the message replies to another.

Other events (allEvents only): `message.reaction` (`messageId`, `targetMessageId`, `targetFromMe`, `emoji`, null when removed), `message.edited` (`messageId` of the edited message, new `text`), `message.deleted` (`messageId`), `group.joined` (this account was added to a group), `group.participants` (`action`: add, remove, promote, demote, modify; `participants: [{jid, phone, isMe}]`, `author`). Non-message events carry an `eventId` to de-duplicate on.

### Delivery and retries

A delivery that fails (network error, timeout, 429 or 5xx) is retried after 2 s and again after 10 s with the same body and signature. `X-Webhook-Attempt` counts from 1. Receivers must de-duplicate on `messageId` / `eventId`.

### Reply actions

Besides `delete` and `ephemeral`, a receiver's JSON answer may contain `"read": true` to mark the incoming message read (blue ticks).

## Creating and managing groups

### POST /api/groups

Create a group from this account, which becomes its admin. Capped per day (IST) by `groups.create_daily_cap` (default 5); over the cap you get `429 group_cap_reached`. Creating many groups quickly is a strong ban signal.

```json
{ "name": "Flat 4B", "participants": ["+91 98123 45678", "919988776655"], "description": "optional",
  "pictureUrl": "https://example.com/flat4b.jpg",
  "settings": { "membersCanAdd": false, "membersCanEditInfo": false } }
```

`pictureUrl` is optional: a public http(s) image set as the group picture right after creating it. The response then carries `"picture": { "set": true }` or `{ "set": false, "error": "..." }`; a failed picture doesn't undo the group.

`settings` is optional: the same fields as `PATCH /api/groups/:id/settings` below, applied right after the group is created. The response then also carries `"settings": { "applied": [...], "failed": [...] }`. A refused setting doesn't undo the group.

Response `201`:

```json
{
  "id": "120363...@g.us",
  "name": "Flat 4B",
  "participants": [
    { "input": "+91 98123 45678", "jid": "919812345678@s.whatsapp.net", "phone": "919812345678", "status": "added" },
    { "input": "919988776655", "jid": "919988776655@s.whatsapp.net", "phone": "919988776655", "status": "invite_needed" }
  ],
  "inviteLink": "https://chat.whatsapp.com/..."
}
```

`invite_needed` means the person's privacy settings don't let this account add them; send them `inviteLink` instead. `invalid` means the input wasn't a phone or JID.

#### A group with only this account in it

You can create a group whose only member is this account itself, for example as a private test group or to add people later by invite link. `participants` must have at least one entry, so pass this account's own number:

```json
{ "name": "Test group", "participants": ["919800000008"] }
```

The group is created with this account as its only member, as `superadmin` (owner). That entry is reported as `"status": "added"` in the response, even though this account is the creator rather than an added member. It still counts toward `groups.create_daily_cap`. Add people afterwards with `POST /api/groups/:id/participants` or share `inviteLink`.

### POST /api/groups/:id/participants

`{ "add": [...], "remove": [...], "promote": [...], "demote": [...] }` (any of them). Returns the same `participants` shape (`added`, `removed`, `promoted`, `demoted`, `invite_needed`, `invalid`, `failed`) and `inviteLink` when someone needs an invite.

### GET /api/groups/:id/invite

`{ "id", "inviteLink" }`. This account must be an admin of the group.

### DELETE /api/groups/:id/invite

Revoke the invite link: the old one stops working at once. Returns the new one: `{ "id", "revoked": true, "inviteLink": "https://chat.whatsapp.com/..." }`. Admin only.

### GET /api/groups/join?link=...

What an invite link leads to, without joining. `link` is the full link or just its code.

```json
{ "id": "120363...@g.us", "name": "Clinic staff", "description": "Shifts", "size": 12, "createdAt": "...", "joinApprovalRequired": false }
```

`404 invite_not_found` when the link is invalid, revoked or expired.

### POST /api/groups/join

Join a group by invite link: `{ "link": "https://chat.whatsapp.com/AbC..." }`.

- `200 { "id", "joined": true }` once in.
- `202 { "id": null, "joined": false, "pendingApproval": true }` when the group needs an admin to approve: WhatsApp has filed a join request.
- At most 10 joins a day (resets at midnight IST), because joining many groups fast is what spam accounts do: `429 join_cap_reached`.

### POST /api/groups/:id/leave

Leave the group: `{ "id", "left": true }`. The group stays in `GET /api/groups` until the next sync, and sent messages to it stay in the history. If this account is the only admin, WhatsApp makes another member admin.

### GET /api/groups/:id/requests

People waiting to be let in (when `joinApproval` is on). Admin only.

```json
{ "id": "120363...@g.us", "requests": [ { "jid": "1234...@lid", "phone": "919812345678", "method": "invite_link", "requestedAt": "..." } ] }
```

`phone` is `null` when WhatsApp only gives a LID.

### POST /api/groups/:id/requests

```json
{ "approve": ["919812345678"], "reject": ["1234...@lid"] }
```

Phones or JIDs (the `jid` from the list works for LIDs). Each comes back with a `status`: `approved`, `rejected`, `failed` (no such request), `not_found` or `invalid`.

### GET /api/groups/:id/settings

The group's permissions as WhatsApp reports them:

```json
{ "id": "120363...@g.us", "settings": { "membersCanAdd": false, "membersCanEditInfo": false, "adminsOnlyMessages": false, "joinApproval": false } }
```

| Setting | `false` means | `true` means | New WhatsApp groups |
|---|---|---|---|
| `membersCanAdd` | only admins can add members | every member can add | `true` |
| `membersCanEditInfo` | only admins can change the name, photo and description | every member can | `true` |
| `adminsOnlyMessages` | everyone can send messages | only admins can send messages | `false` |
| `joinApproval` | anyone with the link joins at once | an admin approves each join (see `/:id/requests`) | `false` |

### PATCH /api/groups/:id/settings

Change any of the four; the ones left out stay as they are. This account must be an admin of the group.

```json
{ "membersCanAdd": false, "membersCanEditInfo": false }
```

Response: `{ "id", "applied": ["membersCanAdd", "membersCanEditInfo"], "failed": [], "settings": { ...as now } }`. A change WhatsApp refused is listed in `failed` with its `error`; if every change was refused (usually: this account isn't an admin), the answer is `502 settings_not_changed` with the same fields.

`membersCanAdd: false` only holds while the members are not admins: anyone you promote can add people again. People can still join through the invite link.

### PATCH /api/groups/:id

Rename the group and/or change its description.

```json
{ "name": "Flat 4B (2027)", "description": "Rent due on the 5th" }
```

Either field alone is fine. `"description": ""` removes the description. Response: `{ "id", "applied": ["name", "description"], "failed": [] }`. If WhatsApp refused every change, the answer is `502 not_changed` with the same fields. This account must be an admin, unless `membersCanEditInfo` is `true`. Everyone in the group sees "<this number> changed the group name".

### PUT /api/groups/:id/picture

Set the group picture from an image URL.

```json
{ "imageUrl": "https://example.com/flat4b.jpg" }
```

The bridge downloads the image (http or https, a JPEG, PNG or WebP, at most 5 MB) and WhatsApp crops it to a square, so put the subject in the middle. Response: `{ "id", "set": true, "pictureUrl": "https://pps.whatsapp.net/..." }`. Errors: `422 picture_not_set` when the URL isn't a reachable image or is too big, `502 picture_not_set` when WhatsApp refused (usually: not an admin and `membersCanEditInfo` is `false`). The same admin rule applies as for renaming.

### DELETE /api/groups/:id/picture

Remove the group picture. Response: `{ "id", "removed": true }`.

`/api/health` lists `group-create`, `group-settings`, `group-info` and `group-membership` when these exist.

## Profile

How this account appears to everyone it writes to. **Everything here is public**: every chat and customer sees it.

### GET /api/profile

```json
{ "phone": "919812345678", "name": "City Clinic", "about": "Open 9 to 6", "pictureUrl": "https://pps.whatsapp.net/...",
  "isBusiness": true,
  "business": { "description": "Family clinic", "address": "MG Road", "email": "desk@clinic.example", "websites": ["https://clinic.example"],
    "category": "Medical", "hours": { "timezone": "Asia/Kolkata", "days": [ { "day": "mon", "open": "09:00", "close": "18:00" }, { "day": "sun", "mode": "appointmentOnly" } ] } } }
```

`business` is `null` for a personal (non-Business) WhatsApp account.

### PATCH /api/profile

`{ "name": "City Clinic", "about": "Open 9 to 6" }`: either or both. Name up to 25 characters, about up to 139. Response: `{ "applied": [...], "failed": [] }`.

### PUT /api/profile/picture, DELETE /api/profile/picture

Set the account's picture from `{ "imageUrl": "https://..." }` (JPEG, PNG or WebP, at most 5 MB; WhatsApp crops it to a square), or remove it.

### PATCH /api/profile/business

WhatsApp Business accounts only. Give any of these; the rest stay as they are:

| Field | Type | Notes |
|---|---|---|
| `description` | string | Up to 512 characters |
| `address` | string | Up to 256 |
| `email` | string | |
| `websites` | string[] | 1 or 2 http(s) URLs |
| `hours` | `{ timezone, days }` | `timezone` like `"Asia/Kolkata"`. Each day: `{ "day": "mon", "open": "09:00", "close": "18:00" }` or `{ "day": "sun", "mode": "open24h" \| "appointmentOnly" }`. A day left out shows as closed. |

WhatsApp cannot clear a field through this: send a new value instead. Response: `{ "updated": ["description", "hours"], "business": { ...as now } }`.

### PUT /api/profile/business/cover

Set the cover photo from `{ "imageUrl": "https://..." }`. Response: `{ "set": true, "coverPhotoId": "..." }`.

### GET /api/profile/business/catalog

The products of this Business account's catalog: `{ "products": [{ "productId", "title", "description", "currency", "price", "retailerId", "url", "imageUrl", "availability", "hidden" }], "nextCursor" }`. `?limit=` (1-50, default 20) and `?cursor=` page through it. A product here can be sent as a card with `product` on `POST /api/messages`. WhatsApp can be slow to answer for an account with no catalog: after 15 seconds the answer is `504 catalog_timeout`.

## Status

Post a Status (the 24 hour stories) to chosen people. WhatsApp shows it only to people in the audience **who also have this number saved** in their phone.

### POST /api/status

```json
{ "text": "Open this Sunday 10 to 2", "backgroundColor": "#128C7E", "font": 0, "audience": ["919812345678", "919898989898"] }
```

| Field | Type | Notes |
|---|---|---|
| `text` | string | A text Status, or the caption of an image or video. Up to 700 characters |
| `mediaUrl` + `mediaType` | string, `image` \| `video` | An image or video Status from a public URL |
| `backgroundColor`, `font` | `"#RRGGBB"`, 0-5 | Text Status only. Default `#128C7E`, font 0 |
| `audience` | string[] | Phones or JIDs, up to 256 |
| `allContacts` | `true` | Instead of `audience`: everyone in `GET /api/contacts` (up to 256) |

Response `201`: `{ "statusId": "3EB0...", "audienceCount": 2, "invalid": [] }`. `invalid` lists audience entries that weren't phone numbers.

### DELETE /api/status/:statusId

Take the Status down for everyone who could see it. Works for Statuses posted in the last 24 hours since the server last started (the bridge remembers who each went to in memory). Response: `{ "statusId", "deleted": true }`.

## Channels

WhatsApp Channels are one-way broadcasts that anyone can follow. A channel id looks like `120363123456789012@newsletter`.

| Call | What it does |
|---|---|
| `GET /api/channels/lookup?invite=…` | Read a channel from its `https://whatsapp.com/channel/…` link or the code in it |
| `GET /api/channels/:id` | Read a channel by id |
| `POST /api/channels` | Create a channel owned by this account: `{ "name", "description?" }`. At most 2 a day (`429 daily_cap_reached`) |
| `PATCH /api/channels/:id` | Change `name` and/or `description` (owner only) |
| `PUT /api/channels/:id/picture` | Set the picture from `{ "imageUrl" }` (owner only) |
| `DELETE /api/channels/:id/picture` | Remove the picture (owner only) |
| `POST /api/channels/:id/follow` | Follow the channel |
| `DELETE /api/channels/:id/follow` | Unfollow it |
| `POST /api/channels/:id/messages` | Post to a channel this account owns or is an admin of |

A channel reads as `{ "id", "name", "description", "link", "followers", "verified", "role", "muted", "createdAt", "pictureUrl" }`. `role` is this account's part in it: `owner`, `admin`, `subscriber`, or `guest` when it does not follow the channel.

### POST /api/channels/:id/messages

```json
{ "text": "Open this Sunday 10 to 2", "mediaUrl": "https://example.com/poster.jpg", "mediaType": "image" }
```

Text, or an `image` or `video` from a public URL with `text` as its caption. Sent at once, not queued, and not counted toward the daily cap. At most 6 posts per channel per minute (`429 too_many_posts`). Response `201`: `{ "id", "messageId" }`.

## Multiuser tenants

A tenant is either **single-user** (one WhatsApp number, everything above) or **multiuser**: one tenant with many users, each with their own WhatsApp number. Each user has their own API key, database, connection, webhooks, daily cap and group-creation cap, exactly as if they were separate tenants. Needs the multi-tenant plugin.

### Keys

| Key | Looks like | Held by | Can do |
|---|---|---|---|
| Admin key | `admin.api_key` | the server operator | create tenants, set a tenant's `mode` |
| Tenant key | `sk_...` | the tenant's backend | manage its users at `/tenant/users`. **Cannot call `/api/*`.** |
| User key | `uk_...` | whoever acts for that one user | everything under `/api/*`, for that user's number only |

Rules a multiuser tenant always follows (`TENANT_KEY_CHECK` does not relax them):

- `/api/*` and `/ws` only accept a user key. The key alone decides which number the request uses. No parameter, header or path can point a request at another user.
- The subdomain alone grants nothing, and neither does the tenant key: `/api/*` with the tenant key is `403 multiuser_tenant`.
- On `<tenant>.wabridge.co.in`, a user key must belong to a user of that tenant, and `/tenant/users` only accepts that tenant's key.
- A user key is shown once, when the user is created or its key is rotated. Only its SHA-256 hash is stored, so it cannot be read back, by you or by anyone holding the database.
- `GET /api/health` without a key returns just `{ "status": "ok", "mode": "multiuser" }`. With a user key it returns that user's health, as for a tenant.

### Making a tenant multiuser (admin key)

```bash
# new tenant
curl -X POST localhost:4000/admin/tenants -H "X-API-Key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{ "name": "acme", "mode": "multi" }'
# existing tenant
curl -X PATCH localhost:4000/admin/tenants/<tenantId> -H "X-API-Key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{ "mode": "multi" }'
```

Switching a tenant to `multi` takes its own number offline (its session is kept, and comes back if you switch to `single` again; the users then go offline instead). Limit the number of users with tenant config `{ "multiuser": { "max_users": 100 } }` (default 100).

### Managing users (tenant key)

All under `/tenant/users`, with `X-API-Key: sk_...`. A user id from another tenant is a `404`.

| Method | Path | |
|---|---|---|
| `POST` | `/tenant/users` | Create a user. Body: `{ "externalId"?, "label"? }`. `externalId` is your own id for the user, unique per tenant. Response includes `apiKey` (`uk_...`) **once**. |
| `GET` | `/tenant/users` | List users. `?externalId=` finds one. |
| `GET` | `/tenant/users/:id` | One user. |
| `PATCH` | `/tenant/users/:id` | `{ "label"?, "enabled"? }`. Disabling locks the key and takes the number offline; data is kept. |
| `DELETE` | `/tenant/users/:id` | Disable. With `?purge=true`: unlink the device (only if the user is online at that moment) and delete the user, its key and all its data. Cannot be undone. |
| `POST` | `/tenant/users/:id/rotate-key` | New key; the old one stops working at once. |
| `POST` | `/tenant/users/:id/pairing-token` | `{ "ttlSeconds"? }` → `{ token, url, expiresAt }`. `GET url` shows this user's QR (see pairing tokens). The token only ever shows this user's QR. |
| `POST` | `/tenant/users/:id/reconnect` | Drop the linked session and start pairing again. |

A user looks like:

```json
{
  "id": "0b1f...", "externalId": "acct_42", "label": "Asha", "enabled": true,
  "keyPrefix": "uk_Ab3dE", "keyRotatedAt": null,
  "status": "connected", "account": { "phoneNumber": "9198...", "name": "Asha" },
  "createdAt": "...", "updatedAt": "..."
}
```

`status` is `pairing`, `connecting`, `connected`, `disconnected`, `offline` or `disabled`. Errors: `409 external_id_taken`, `409 user_limit_reached` (also when re-enabling a user, and when disabled users pile up to twice the limit: purge them), `409 not_multiuser` (the key belongs to a single-user tenant).

Rotating a key, disabling or purging a user also closes any WebSocket session open with the old key. Tenant names are unique: creating or renaming a tenant to a name in use is `409 name_taken`.

### Acting as a user (user key)

Use any endpoint in this document with the user's key:

```bash
curl -X POST https://acme.wabridge.co.in/api/webhooks -H "X-API-Key: $USER_KEY" -H 'content-type: application/json' \
  -d '{ "url": "https://acme.example.com/wa-hook?user=acct_42", "secret": "...", "allEvents": true }'
```

Webhooks are per user: register one for each user (put your own user id in the URL, or use a secret per user, to tell them apart). The WebSocket takes the user key as `/ws?apiKey=uk_...` or an `X-API-Key` header.

### Typical flow

1. Admin: create the tenant with `"mode": "multi"`; give the `sk_` key to the tenant's backend.
2. Backend: `POST /tenant/users` when one of its users wants to connect WhatsApp; store the returned `uk_` key (encrypted) against that user.
3. Backend: `POST /tenant/users/:id/pairing-token`, show the QR from `url` to that user.
4. Backend: register the user's webhook and call `/api/*` with that user's key.
5. On offboarding: `DELETE /tenant/users/:id?purge=true`.
