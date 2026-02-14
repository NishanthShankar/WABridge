# WABridge

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

## Prerequisites

You need three things installed before starting:

| Requirement | Why | Install |
|-------------|-----|---------|
| **Node.js 22+** | Runs the server | [nodejs.org](https://nodejs.org) or `brew install node@22` |
| **pnpm 9+** | Package manager | `npm install -g pnpm` |
| **Docker** | Runs Valkey (the job queue) | [docker.com](https://www.docker.com/products/docker-desktop/) |

## Getting Started

### Step 1: Clone and install

```bash
git clone https://github.com/NishanthShankar/WABridge.git
cd WABridge
pnpm install
```

### Step 2: Start Valkey

WABridge uses [Valkey](https://valkey.io) (a Redis fork) to manage the message queue. Start it with Docker:

```bash
docker run -d --name valkey -p 6379:6379 valkey/valkey:8.1-alpine
```

> Valkey must be running before you start the server. If the server can't connect to Valkey, it will crash.

### Step 3: Build the web dashboard

```bash
pnpm build
```

This compiles the React dashboard. The server serves it automatically from `http://localhost:4000`. If you skip this step, the server still works (API and WhatsApp) but you'll see a plain status page instead of the dashboard.

### Step 4: Start the server

```bash
pnpm dev
```

### Step 5: First boot — what happens automatically

On first boot, WABridge does everything for you:

1. **Creates `config.yaml`** in the project root with an auto-generated encryption key and API key
2. **Creates `./data/openwa.db`** — the SQLite database (migrations run automatically)
3. **Prints your API key** to the console — look for a line like:
   ```
   Auto-generated API key -- save this for client access
   sk_da629bef0046a61e214d9e03ffba28e8
   ```
   **Save this key.** You need it for all API requests and to log into the dashboard.
4. **Starts listening** on `http://localhost:4000`

### Step 6: Connect WhatsApp

1. Open `http://localhost:4000` in your browser
2. Enter your API key to log in
3. Scan the QR code with WhatsApp on your phone (Settings > Linked Devices > Link a Device)
4. Once connected, the QR code disappears and you'll see "Connected"

> You only need to scan the QR code once. WABridge encrypts and persists your session. It auto-reconnects on restart.

### Step 7: Send your first message

```bash
curl -X POST http://localhost:4000/api/messages \
  -H "X-API-Key: sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"phone": "919876543210", "content": "Hello from WABridge!"}'
```

That's it. The message sends immediately. To schedule for later, add `"scheduledAt": "2025-01-15T09:00:00Z"`.

## Configuration

WABridge auto-generates `config.yaml` on first boot. You can also create it manually:

```bash
cp apps/server/config.default.yaml config.yaml
```

```yaml
port: 4000
log_level: info

# Auto-generated on first boot — don't change unless you know what you're doing
# encryption_key: "..."
# api_key: "..."

whatsapp:
  browser_name: openWA
  mark_online: false

rate_limit:
  daily_cap: 30               # Max messages per day (increase with caution)
  min_delay_ms: 2000          # Minimum random delay between sends (ms)
  max_delay_ms: 8000          # Maximum random delay between sends (ms)

scheduling:
  default_send_hour: 9        # Default hour for recurring messages (IST, 24h)
  birthday_message: 'Happy Birthday {{name}}! Wishing you a wonderful day.'
  retention_days: 90           # Auto-delete sent messages after N days (0 = keep forever)

valkey:
  host: localhost
  port: 6379
```

### Environment Variables

These override config file values. Useful for Docker deployments.

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENWA_API_KEY` | Override the API key | Auto-generated |
| `OPENWA_ENCRYPTION_KEY` | Override the encryption key | Auto-generated |
| `OPENWA_CONFIG_PATH` | Path to config.yaml | `./config.yaml` |
| `OPENWA_DB_PATH` | Path to SQLite database | `./data/openwa.db` |

## Authentication

All `/api/*` routes require an `X-API-Key` header. WebSocket connections require an `apiKey` query parameter.

```bash
# API request
curl -H "X-API-Key: sk_your_key_here" http://localhost:4000/api/health

# WebSocket
wscat -c "ws://localhost:4000/ws?apiKey=sk_your_key_here"
```

The web dashboard prompts for the API key on first visit and stores it in the browser.

## API

Full API documentation with request/response examples: **[docs/API.md](docs/API.md)**

Quick overview of all endpoints:

```
GET    /api/health                       # Connection status (no auth required)

POST   /api/contacts                     # Create contact
GET    /api/contacts                     # List (search, label, page, limit)
GET    /api/contacts/:id                 # Get
PUT    /api/contacts/:id                 # Update
DELETE /api/contacts/:id                 # Delete
POST   /api/contacts/import              # CSV/Excel import

GET    /api/labels                       # List
POST   /api/labels                       # Create
PUT    /api/labels/:id                   # Update
DELETE /api/labels/:id                   # Delete

POST   /api/messages                     # Send or schedule a message
POST   /api/messages/bulk                # Bulk send (up to 500)
GET    /api/messages                     # List (status, phone, phoneMode, limit, offset)
GET    /api/messages/:id                 # Get
PATCH  /api/messages/:id                 # Edit pending message
PATCH  /api/messages/:id/cancel          # Cancel pending
POST   /api/messages/:id/retry           # Retry failed

POST   /api/messages/recurring           # Create recurring rule
GET    /api/messages/recurring            # List
GET    /api/messages/recurring/:id       # Get
PATCH  /api/messages/recurring/:id       # Update
DELETE /api/messages/recurring/:id       # Delete

GET    /api/templates                    # List
POST   /api/templates                    # Create
GET    /api/templates/:id                # Get
PUT    /api/templates/:id                # Update
DELETE /api/templates/:id                # Delete

GET    /api/rate-limit/status            # Daily usage and remaining quota
```

## Docker Deployment

For production, use Docker Compose:

```bash
docker compose up -d
```

This starts both Valkey and WABridge. Data persists across restarts via mounted volumes:

```yaml
volumes:
  - ./data:/app/data            # SQLite database + WhatsApp session
  - ./config.yaml:/app/config.yaml:ro   # Config (read-only)
```

> Run the server once locally first to generate `config.yaml`, then copy it to your Docker host.

## Exposing Publicly (Cloudflare Tunnel)

To access WABridge from the internet (e.g., from a home server or Mac Mini), use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). It's free and requires no port forwarding.

**Quick tunnel** (random URL, changes on restart):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:4000
```

**Named tunnel** (stable URL, free, requires Cloudflare account + domain):

```bash
cloudflared tunnel login
cloudflared tunnel create wabridge
cloudflared tunnel --url http://localhost:4000 wabridge
```

## Important Files

After setup, these files are created in the project root:

| File | What it is | Back it up? |
|------|-----------|-------------|
| `config.yaml` | Encryption key, API key, all settings | **Yes** |
| `data/openwa.db` | SQLite database (contacts, messages, WhatsApp session) | **Yes** |
| `data/openwa.db-wal` | SQLite write-ahead log (auto-managed) | Included with db |

> **Never commit `config.yaml` to git** — it contains your encryption key and API key. It's already in `.gitignore`.

> **Don't lose your encryption key** — it encrypts your WhatsApp session. Losing it means you'll need to re-scan the QR code.

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

## License

[MIT](LICENSE)
