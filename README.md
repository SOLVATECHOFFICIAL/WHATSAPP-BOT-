# SOLVATECH BOT

SOLVATECH BOT is an enterprise-grade WhatsApp Multi-Device automation platform and bot management suite. It features automated pairing code handshakes, isolated multi-tenant session storage, resilient automatic socket reconnection with live timestamp logging, real-time device battery telemetry, permanent WhatsApp number locking, Google Firebase Authentication, and a Super Admin Command Center.

---

## 🌟 Key Features

### 1. Automatic Bot Reconnection & Stability Engine
- **Resilient Connection Recovery**: Automatically recovers from intermittent network drops, server restarts, and WhatsApp socket resets.
- **Handshake Auto-Recovery (Status 515)**: Handles Baileys `restartRequired` / 515 status codes instantly after initial pairing without dropping user state.
- **Exponential Backoff**: Schedules reconnection attempts intelligently (1.5s up to 60s) to prevent socket thrashing and WhatsApp rate limits.
- **Real-Time Timestamped Telemetry**: Records exact timestamps (ISO & localized), status badges, disconnect codes, and resolution messages in a dedicated dashboard log.
- **Instant Manual Reconnect**: Users and admins can trigger immediate re-synchronization with a single click.

### 2. Device Battery Telemetry
- **Live Battery Monitoring**: Captures device battery percentage, charging state (AC/USB vs. Battery Power), and power-saving modes directly from active WhatsApp Web socket stanzas.
- **Status Widget & Dashboard Bento**: Visual battery health bar with dynamic warnings for low (<25%) and critical (<15%) levels.

### 3. Multi-Tenant Session Isolation & Permanent Number Lock
- **One User per WhatsApp Number**: Enforces 1-to-1 account binding. Once a phone number is linked to a Google UID, other accounts cannot bind or steal that number unless wiped/released by the Super Admin.
- **Firestore Session Persistence**: Encrypted session credentials (`creds.json`) are synchronized to Google Cloud Firestore, surviving container redeployments and ephemeral volume wipes.

### 4. Super Admin Command Center
- **Account & Number Management**: Full search, filtering, and inspection of all linked WhatsApp phone numbers and user accounts.
- **Wiping & Overwriting Permissions**: Allows the Super Admin to unlink numbers, overwrite corrupted sessions, or release locks.
- **Auditing**: Every administrative action is recorded in immutable Firestore audit logs.

### 5. Automated Protection & Command Suite
- **Group Protection**: `.antilink on/off`, `.antibot on/off`, `.anti`. Automatically deletes prohibited triggers and removes non-admin offenders when the bot is admin.
- **Media & OCR Tools**: `.read` (image OCR), `.sticker` (convert photo/video to WhatsApp sticker), `.antisticker` (sticker to media), `.vv` (view-once media retrieval).
- **Administration & Moderation**: `.tagall`, `.tagadmin`, `.kick`, `.add`, `.promote`, `.demote`, `.lock`, `.unlock`, `.ping`, `.alive`, `.menu`.
- **Sequential Message Queue**: Ensures atomic, non-blocking message processing per chat so intensive tasks never delay incoming commands.

---

## 🚀 API Endpoints

The backend exposes authenticated REST endpoints:

- `GET /bot-api/status`: Returns current WhatsApp connection state, bot number, battery status, and reconnection statistics.
- `GET /bot-api/reconnect-logs`: Returns dedicated circular buffer logs (up to 50 recent events) with timestamps, event types, and diagnostics.
- `POST /bot-api/reconnect`: Triggers an immediate manual reconnection attempt.
- `POST /bot-api/pair`: Requests a new 8-digit pairing code for an international phone number (e.g. `2349012345678`).
- `POST /bot-api/disconnect`: Disconnects the active socket and safely flushes local session files.
- `GET /bot-api/license/status`: Retrieves subscription status and expiry countdown.
- `POST /bot-api/license/redeem`: Redeems a 30-day/annual activation license key.

---

## 💻 Local Development & Deployment

### Local Setup
```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`.

### Deploy to Railway / Render / Cloud Run
1. Set the following environment variables:
   - `PORT`: `3000` (or host assigned port)
   - `BOT_DATA_DIR`: `/app/runtime` (mount a persistent volume here)
2. Build command: `npm install`
3. Start command: `npm run serve` (or `node index.js`)
4. Health check path: `/bot-api/status`

---

## 🔒 Security & Privacy
- All session credentials and key-pairs are isolated per user directory.
- The repository `.gitignore` ensures that runtime sessions, keys, and tokens are never committed to version control.
- Admin routes are locked strictly to authorized Super Admin Google accounts.