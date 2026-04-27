# tenebra-wa — WhatsApp Bridge

Self-hosted WhatsApp bridge for [Tenebra CRM](https://github.com/WebYurii/tenebra).
Wraps `whatsapp-web.js` behind a small Express API protected by a shared secret.

## Endpoints

All endpoints require `X-Bridge-Secret` header (except `/health`).

| Method | Path      | Body                     | Description |
|--------|-----------|--------------------------|-------------|
| GET    | `/health` | —                        | Liveness probe (no auth) |
| GET    | `/status` | —                        | Connection state, phone, last error |
| GET    | `/qr`     | —                        | Current QR (base64 PNG data URL) when pending |
| POST   | `/send`   | `{to, text}`             | Send message; rate-limited to 1 per 5s |
| POST   | `/logout` | —                        | Drop session (forces fresh QR on next start) |

Inbound messages → POST to `CRM_WEBHOOK_URL` with the same shared secret in header.

## Run

```bash
npm install
cp .env.example .env  # fill BRIDGE_SECRET, CRM_WEBHOOK_URL, CHROME_PATH
node index.js
```

Or via PM2: `pm2 start ecosystem.config.js`.

Session persists in `./.wwebjs_auth/` (LocalAuth). After Chrome restart you do not
need to scan QR again unless WhatsApp dropped the linked device.

## Notes

- Uses Puppeteer's bundled Chromium (override via `CHROME_PATH`).
- One linked device slot is consumed on the WhatsApp account.
- For low-volume warm-contact use only — Meta may ban numbers used for mass outreach.
