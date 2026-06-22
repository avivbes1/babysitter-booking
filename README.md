# Babysitter Booking Microservice

A lightweight HTTP service that manages babysitter availability broadcasts via WhatsApp. Part of a family home-automation stack.

## What it does

1. **Broadcast** — when a booking is requested (via API), sends an availability offer to all active babysitters over WhatsApp
2. **Inbound routing** — receives babysitter replies (via the voice server `/inbound` webhook) and classifies them using Claude Haiku (accept / decline / opt-out / question)
3. **Fill logic** — first-accept-wins: when a sitter accepts, all other pending offers are superseded and the master family group is notified
4. **Expiry + reminders** — a 1-minute cron checks: 2h before start, expire open bookings that weren't filled; send a reminder to the confirmed sitter

## Architecture

```
[Family admin DM]
      │ POST /bookings
      ▼
  babysitter-booking (port 3002)
      │ outbound: POST /send-message (voice server, with x-shared-token)
      ▼
  Tudat voice server (port 3001)
      │ WhatsApp
      ▼
  Babysitters

  Babysitters reply → WhatsApp
      │
  Tudat voice server → POST /inbound (babysitter-booking)
      │
  handleInbound → LLM classify → fill / decline / opt-out
      │
  sendToMaster → family master group
```

## API

### `POST /bookings`
Create a booking and broadcast to all active sitters.

Headers: `x-shared-token: <SHARED_SECRET>`

Body:
```json
{
  "requested_by": "+972501234567",
  "day": "יום שני",
  "date": "2026-01-20",
  "start": "18:00",
  "end": "22:00"
}
```

Response: `{"ok": true, "sent": 3, "bookingId": 42}`

### `POST /inbound`
Receive a babysitter reply (called by Tudat voice server).

Headers: `x-shared-token: <SHARED_SECRET>`

Body:
```json
{ "from_phone": "+972501234567", "body": "כן, מתאים לי", "ts": "2026-01-19T15:00:00Z" }
```

### `GET /bookings`
List all bookings (admin). Headers: `x-shared-token`.

### `GET /log`
Recent message log. Headers: `x-shared-token`.

## Onboarding sequence

When a sitter is broadcast to for the first time (`intro_sent = 0`), they receive a short introduction message before the offer. After that, `intro_sent = 1` and they only receive offer/reminder/ack messages.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SHARED_SECRET` | ✅ | Auth token for inbound + outbound requests |
| `AGENT_OUTBOUND_WEBHOOK_URL` | ✅ | Voice server `/send-message` endpoint |
| `MASTER_GROUP_JID` | ✅ | WhatsApp JID of the family master group |
| `ANTHROPIC_API_KEY` | ✅ | For LLM intent classification (Haiku) |
| `FAMILY_NAME` | optional | Shown in sitter messages. Default: `המשפחה` |
| `DATABASE_PATH` | optional | SQLite path. Default: `./data/babysitters.sqlite` |
| `DEFAULT_TIMEZONE` | optional | `Asia/Jerusalem` (unused in code — offsets are computed dynamically) |
| `PORT` | optional | HTTP port. Default: `3002` |

## Deployment

Runs under PM2 alongside Tudat on the same EC2 instance:
```bash
pm2 start src/server.js --name babysitter-booking
pm2 save
```

## Key design notes

- **DST-safe timestamps**: `buildTimestamp` uses `Intl.DateTimeFormat` to resolve Israel's actual UTC offset on the booking date (UTC+2 in winter, UTC+3 in summer). Never hardcoded.
- **Concurrent offers**: when a sitter has multiple open offers, inbound replies resolve the soonest unanswered one first (by `start_ts ASC`), not the newest sent.
- **Idempotent inbound**: messages are deduplicated by SHA-256 hash of `(phone, ts, body)`.
- **First-accept-wins**: fill is an atomic SQLite transaction; the second sitter to accept gets `already_booked`.
- **Lead time**: expiry and reminders fire `LEAD_TIME_MS` before start (currently 2h, one constant in `scheduler.js`).
