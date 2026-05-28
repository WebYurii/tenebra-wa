require("dotenv").config();
const express = require("express");
const { createHmac } = require("node:crypto");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const PORT = parseInt(process.env.PORT || "8005", 10);
const HOST = process.env.HOST || "127.0.0.1";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL;
const CRM_CALL_WEBHOOK_URL =
  process.env.CRM_CALL_WEBHOOK_URL ||
  (CRM_WEBHOOK_URL ? CRM_WEBHOOK_URL + "/call" : null);
const CRM_STATUS_WEBHOOK_URL =
  process.env.CRM_STATUS_WEBHOOK_URL ||
  (CRM_WEBHOOK_URL ? CRM_WEBHOOK_URL + "/status" : null);
const CHROME_PATH = process.env.CHROME_PATH;

if (!BRIDGE_SECRET) {
  console.error("BRIDGE_SECRET is required");
  process.exit(1);
}

const state = {
  status: "starting",
  qrDataUrl: null,
  qrText: null,
  phone: null,
  pushname: null,
  lastError: null,
  readySince: null,
};

const lastSendAt = { ts: 0 };
const MIN_SEND_INTERVAL_MS = 5000;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
  puppeteer: {
    headless: true,
    executablePath: CHROME_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  },
});

client.on("qr", async (qr) => {
  console.log("[wa] QR received, length:", qr.length);
  try {
    state.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
    state.qrText = qr;
    state.status = "qr_pending";
    state.lastError = null;
  } catch (e) {
    console.error("[wa] QR encode error:", e);
  }
});

client.on("authenticated", () => {
  console.log("[wa] authenticated");
  state.status = "authenticated";
  state.qrDataUrl = null;
  state.qrText = null;
});

client.on("auth_failure", (msg) => {
  console.error("[wa] auth_failure:", msg);
  state.status = "auth_failure";
  state.lastError = String(msg);
  notifyStatus("auth_failure", String(msg));
});

client.on("ready", () => {
  state.status = "ready";
  state.readySince = new Date().toISOString();
  state.qrDataUrl = null;
  state.qrText = null;
  try {
    state.phone = client.info?.wid?.user ?? null;
    state.pushname = client.info?.pushname ?? null;
  } catch {}
  console.log("[wa] ready as", state.phone, state.pushname);
});

client.on("disconnected", (reason) => {
  console.log("[wa] disconnected:", reason);
  const previousPhone = state.phone;
  state.status = "disconnected";
  state.lastError = String(reason);
  state.phone = null;
  state.readySince = null;
  notifyStatus("disconnected", String(reason), previousPhone);
  setTimeout(() => {
    console.log("[wa] re-initializing after disconnect");
    client.initialize().catch((e) => console.error("[wa] init error:", e));
  }, 5000);
});

// Fire a bridge status transition to the CRM. Used for negative
// transitions (disconnected, auth_failure, error) so the CRM can ping
// the operator in Telegram — when the bridge drops, every other
// inbound flow stops too, so this is the only signal they'd get.
async function notifyStatus(status, reason, phone) {
  if (!CRM_STATUS_WEBHOOK_URL) return;
  await postToWebhook(
    CRM_STATUS_WEBHOOK_URL,
    { status, reason: reason ?? null, phone: phone ?? null },
    `status-${status}`
  );
}

// Shared helper: POST a JSON payload to a CRM webhook URL with the
// bridge secret + HMAC signature of the exact serialized bytes.
async function postToWebhook(url, payload, label) {
  try {
    const bodyStr = JSON.stringify(payload);
    const signature =
      "sha256=" +
      createHmac("sha256", BRIDGE_SECRET).update(bodyStr).digest("hex");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bridge-secret": BRIDGE_SECRET,
        "x-bridge-signature": signature,
      },
      body: bodyStr,
    });
    if (!res.ok) {
      console.error(`[wa] ${label} non-ok:`, res.status, await res.text());
    }
  } catch (e) {
    console.error(`[wa] ${label} error:`, e.message);
  }
}

// Use the dedicated `message` event for inbound — it fires reliably
// on every received message in whatsapp-web.js; `message_create`
// turned out to be unreliable for inbound across versions, so we
// only use it for outbound (filtered to fromMe).
client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return; // outbound is handled by message_create below
    if (msg.from.endsWith("@g.us")) return;
    if (!msg.from.endsWith("@c.us")) return;

    const phone = "+" + msg.from.replace("@c.us", "");
    // notifyName is the sender's profile name as visible in WhatsApp (what
    // shows up next to the avatar). Falls back to null when WhatsApp didn't
    // attach one — we let the CRM decide on a placeholder.
    const pushname = msg._data?.notifyName ?? null;
    const payload = {
      from: phone,
      direction: "in",
      pushname,
      text: msg.body || "",
      messageId: msg.id?._serialized,
      timestamp: msg.timestamp,
      type: msg.type,
      hasMedia: msg.hasMedia,
    };
    console.log(
      "[wa] inbound from",
      phone,
      pushname ? `(~${pushname})` : "",
      "len=",
      (msg.body || "").length
    );

    if (CRM_WEBHOOK_URL) {
      await postToWebhook(CRM_WEBHOOK_URL, payload, "webhook");
    }
  } catch (e) {
    console.error("[wa] inbound handler error:", e);
  }
});

// Outbound capture: message_create fires whenever ANY of the operator's
// devices (phone, MacBook, the bridge itself) sends a message. We
// filter to fromMe so we don't double-handle inbound.
client.on("message_create", async (msg) => {
  try {
    if (!msg.fromMe) return; // inbound handled by the `message` event
    if (!msg.to || !msg.to.endsWith("@c.us")) return; // skip groups/broadcasts

    const phone = "+" + msg.to.replace("@c.us", "");
    const payload = {
      from: phone, // CRM treats `from` as "the other party"
      direction: "out",
      text: msg.body || "",
      messageId: msg.id?._serialized,
      timestamp: msg.timestamp,
      type: msg.type,
      hasMedia: msg.hasMedia,
    };
    console.log("[wa] outbound to", phone, "len=", (msg.body || "").length);
    if (CRM_WEBHOOK_URL) {
      await postToWebhook(CRM_WEBHOOK_URL, payload, "webhook-out");
    }
  } catch (e) {
    console.error("[wa] outbound handler error:", e);
  }
});

// Incoming call events. whatsapp-web.js emits these for both voice and
// video, regardless of whether the call is answered or missed — we
// forward the bare facts and let the CRM decide presentation.
client.on("call", async (call) => {
  try {
    if (!call?.from || !call.from.endsWith("@c.us")) return;
    const phone = "+" + call.from.replace("@c.us", "");
    const payload = {
      from: phone,
      callId: call.id ?? null,
      timestamp: call.timestamp ?? Math.floor(Date.now() / 1000),
      isVideo: !!call.isVideo,
      // The library doesn't surface a clean "missed" flag; the call event
      // fires on incoming ring. If we never auto-answer (we don't), this
      // is effectively a missed/unanswered call from the user's POV.
      missed: true,
    };
    console.log("[wa] incoming call from", phone, payload.isVideo ? "(video)" : "");

    if (CRM_CALL_WEBHOOK_URL) {
      await postToWebhook(CRM_CALL_WEBHOOK_URL, payload, "call-webhook");
    }
  } catch (e) {
    console.error("[wa] call handler error:", e);
  }
});

const app = express();
app.use(express.json({ limit: "1mb" }));

const { timingSafeEqual } = require("node:crypto");
const BRIDGE_SECRET_BUF = Buffer.from(BRIDGE_SECRET, "utf8");

function requireSecret(req, res, next) {
  const hdr = req.headers["x-bridge-secret"];
  if (typeof hdr !== "string") {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const got = Buffer.from(hdr, "utf8");
  // Constant-time compare; length-mismatch fast-path replaced by an
  // equal-length dummy compare to avoid a timing channel.
  if (got.length !== BRIDGE_SECRET_BUF.length) {
    const pad = Buffer.alloc(BRIDGE_SECRET_BUF.length);
    timingSafeEqual(pad, pad);
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  if (!timingSafeEqual(got, BRIDGE_SECRET_BUF)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, status: state.status });
});

app.get("/status", requireSecret, (_req, res) => {
  res.json({
    ok: true,
    status: state.status,
    phone: state.phone,
    pushname: state.pushname,
    readySince: state.readySince,
    lastError: state.lastError,
    hasQr: !!state.qrDataUrl,
  });
});

app.get("/qr", requireSecret, (_req, res) => {
  if (!state.qrDataUrl) {
    return res.json({ ok: false, error: "no_qr", status: state.status });
  }
  res.json({ ok: true, dataUrl: state.qrDataUrl, status: state.status });
});

function normalizePhoneToWid(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (!digits) return null;
  return `${digits}@c.us`;
}

app.post("/send", requireSecret, async (req, res) => {
  if (state.status !== "ready") {
    return res.status(409).json({ ok: false, error: "not_ready", status: state.status });
  }
  const { to, text } = req.body || {};
  if (!to || !text || !String(text).trim()) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }

  const now = Date.now();
  const wait = MIN_SEND_INTERVAL_MS - (now - lastSendAt.ts);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSendAt.ts = Date.now();

  const wid = normalizePhoneToWid(to);
  if (!wid) return res.status(400).json({ ok: false, error: "invalid_phone" });

  try {
    const numberId = await client.getNumberId(wid);
    if (!numberId) {
      return res.status(404).json({ ok: false, error: "not_on_whatsapp" });
    }
    const chatId = numberId._serialized;
    const sent = await client.sendMessage(chatId, String(text));
    res.json({ ok: true, messageId: sent.id?._serialized });
  } catch (e) {
    console.error("[wa] send error:", e);
    res.status(500).json({ ok: false, error: e.message || "send_failed" });
  }
});

app.post("/logout", requireSecret, async (_req, res) => {
  try {
    await client.logout();
    state.status = "disconnected";
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[wa] bridge listening on ${HOST}:${PORT}`);
});

console.log("[wa] initializing client…");
client.initialize().catch((e) => {
  console.error("[wa] initialize error:", e);
  state.status = "error";
  state.lastError = e.message;
});

process.on("SIGTERM", async () => {
  console.log("[wa] SIGTERM, shutting down");
  try { await client.destroy(); } catch {}
  process.exit(0);
});
