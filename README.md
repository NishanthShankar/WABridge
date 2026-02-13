# openWA

WhatsApp automation platform for Indian small businesses. Send scheduled messages, manage contacts, and automate recurring communications through a simple API and web dashboard.

Built with [Baileys](https://github.com/WhiskeySockets/Baileys) (no official WhatsApp Business API required).

## Features

- **WhatsApp Bridge** - Connect by scanning a QR code, auto-reconnect with encrypted session persistence
- **Contact Management** - CRUD contacts, labels, CSV/Excel import, birthday tracking
- **Message Scheduling** - Send immediately or schedule for later, bulk send up to 500 messages
- **Recurring Messages** - Daily, weekly, monthly, yearly, and custom interval rules
- **Template Engine** - Reusable message templates with `{{variable}}` substitution
- **Rate Limiting** - Configurable daily cap with random delays to avoid bans
- **Media Attachments** - Send images, videos, audio, and documents
- **Real-time Updates** - WebSocket push for QR codes, connection status, and delivery receipts
- **Web Dashboard** - React UI for managing contacts, messages, and connection status
- **API Key Auth** - Auto-generated API key on first boot, all routes authenticated
- **Security Headers** - HSTS, CSP, X-Frame-Options, and more out of the box

## Prerequisites

- **Node.js** 22+
- **pnpm** 9+
- **Valkey** (or Redis) for the BullMQ job queue

## Quick Start

```bash
# Clone
git clone https://github.com/NishanthShankar/openWA.git
cd openWA

# Install dependencies
pnpm install

# Start Valkey (using Docker)
docker run -d --name valkey -p 6379:6379 valkey/valkey:8.1-alpine

# Start the server
pnpm dev
```

On first boot, openWA will:
1. Generate a config file at `config.yaml` with an encryption key and API key
2. Log your API key to the console - **save this**
3. Start listening on `http://localhost:4000`
4. Open the URL in your browser to scan the WhatsApp QR code

## Configuration

Copy the default config and customize:

```bash
cp apps/server/config.default.yaml config.yaml
```

```yaml
port: 4000
log_level: info

# Auto-generated on first boot if not set
# encryption_key: "..."
# api_key: "..."

whatsapp:
  browser_name: openWA
  mark_online: false

rate_limit:
  daily_cap: 30
  min_delay_ms: 2000
  max_delay_ms: 8000

scheduling:
  default_send_hour: 9
  birthday_message: 'Happy Birthday {{name}}! Wishing you a wonderful day.'
  retention_days: 90

valkey:
  host: localhost
  port: 6379
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENWA_API_KEY` | Override the API key (takes priority over config file) |
| `OPENWA_ENCRYPTION_KEY` | Override the encryption key (takes priority over config file) |
| `OPENWA_CONFIG_PATH` | Custom path to config.yaml |
| `OPENWA_DB_PATH` | Custom path to SQLite database (default: `./data/openwa.db`) |

## Authentication

All `/api/*` routes require an `X-API-Key` header. WebSocket connections require an `apiKey` query parameter.

```bash
# API request
curl -H "X-API-Key: sk_your_key_here" http://localhost:4000/api/health

# WebSocket
wscat -c "ws://localhost:4000/ws?apiKey=sk_your_key_here"
```

The API key is auto-generated on first boot (`sk_` + 32 hex chars) and written to `config.yaml`.

## API

All endpoints are under `/api` and require the `X-API-Key` header.

### Health

```
GET /api/health
```

### Contacts

```
GET    /api/contacts              # List (query: search, labelId, limit, offset)
POST   /api/contacts              # Create
GET    /api/contacts/:id          # Get
PATCH  /api/contacts/:id          # Update
DELETE /api/contacts/:id          # Delete
POST   /api/contacts/import       # CSV/Excel import (multipart/form-data)
```

### Labels

```
GET    /api/labels                # List
POST   /api/labels                # Create
PATCH  /api/labels/:id            # Update
DELETE /api/labels/:id            # Delete
```

### Messages

```
POST   /api/messages              # Schedule a message
POST   /api/messages/bulk         # Bulk schedule (up to 500)
GET    /api/messages              # List (query: status, contactId, limit, offset)
GET    /api/messages/:id          # Get
PATCH  /api/messages/:id          # Edit pending message
PATCH  /api/messages/:id/cancel   # Cancel pending message
POST   /api/messages/:id/retry    # Retry failed message
```

### Recurring Rules

```
POST   /api/messages/recurring           # Create rule
GET    /api/messages/recurring           # List (query: contactId, type, enabled)
GET    /api/messages/recurring/:id       # Get
PATCH  /api/messages/recurring/:id       # Update
DELETE /api/messages/recurring/:id       # Delete
```

### Templates

```
GET    /api/templates             # List
POST   /api/templates             # Create
GET    /api/templates/:id         # Get
PATCH  /api/templates/:id         # Update
DELETE /api/templates/:id         # Delete
```

### Rate Limit

```
GET    /api/rate-limit/status     # Current usage and remaining quota
```

## Docker

```bash
docker compose up -d
```

This starts Valkey and the openWA server. Mount your `config.yaml` and `data/` directory for persistence:

```yaml
volumes:
  - ./data:/app/data
  - ./config.yaml:/app/config.yaml:ro
```

## ngrok Tunnel

To expose your server publicly (e.g., for webhooks), add ngrok config:

```yaml
ngrok:
  authtoken: your_ngrok_authtoken
  domain: your-domain.ngrok-free.app  # optional
```

Install the optional dependency:

```bash
pnpm --filter @openwa/server add @ngrok/ngrok
```

## Project Structure

```
apps/
  server/          # Hono API server + Baileys WhatsApp bridge
  web/             # React dashboard (Vite + Tailwind + shadcn/ui)
packages/
  shared/          # Shared TypeScript types
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| API Server | [Hono](https://hono.dev) |
| WhatsApp | [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) v7 |
| Database | SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| ORM | [Drizzle ORM](https://orm.drizzle.team) |
| Job Queue | [BullMQ](https://bullmq.io) + [Valkey](https://valkey.io) |
| Frontend | React 18 + [Tailwind CSS](https://tailwindcss.com) v4 + [shadcn/ui](https://ui.shadcn.com) |
| Monorepo | [pnpm](https://pnpm.io) workspaces + [Turborepo](https://turbo.build) |

## Security Notes

- `config.yaml` contains your encryption key and API key - **never commit it to git**
- The encryption key protects your WhatsApp session data. Losing it means re-scanning the QR code
- All API routes are authenticated via API key. WebSocket connections require the key as a query parameter
- Rate limiting with random delays helps avoid WhatsApp bans

## License

[MIT](LICENSE)
