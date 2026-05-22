require("dotenv").config();
const express = require("express");
const { createHmac } = require("node:crypto");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const PORT = parseInt(process.env.PORT || "8005", 10);
const HOST = process.env.HOST || "127.0.0.1";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL;
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
  state.status = "disconnected";
  state.lastError = String(reason);
  state.phone = null;
  state.readySince = null;
  setTimeout(() => {
    console.log("[wa] re-initializing after disconnect");
    client.initialize().catch((e) => console.error("[wa] init error:", e));
  }, 5000);
});

client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;
    if (msg.from.endsWith("@g.us")) return;
    if (!msg.from.endsWith("@c.us")) return;

    const phone = "+" + msg.from.replace("@c.us", "");
    const payload = {
      from: phone,
      text: msg.body || "",
      messageId: msg.id?._serialized,
      timestamp: msg.timestamp,
      type: msg.type,
      hasMedia: msg.hasMedia,
    };
    console.log("[wa] inbound from", phone, "len=", (msg.body || "").length);

    if (CRM_WEBHOOK_URL) {
      try {
        const bodyStr = JSON.stringify(payload);
        // HMAC-SHA256 of the exact serialized bytes, so the CRM can verify
        // the body wasn't altered in transit. CRM accepts both bare hex
        // and "sha256=<hex>"; we use the prefixed form.
        const signature =
          "sha256=" +
          createHmac("sha256", BRIDGE_SECRET).update(bodyStr).digest("hex");
        const res = await fetch(CRM_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bridge-secret": BRIDGE_SECRET,
            "x-bridge-signature": signature,
          },
          body: bodyStr,
        });
        if (!res.ok) {
          console.error("[wa] webhook non-ok:", res.status, await res.text());
        }
      } catch (e) {
        console.error("[wa] webhook error:", e.message);
      }
    }
  } catch (e) {
    console.error("[wa] message handler error:", e);
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
