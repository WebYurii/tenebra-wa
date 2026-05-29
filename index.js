require("dotenv").config();
const express = require("express");
const { createHmac, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const QRCode = require("qrcode");
const pino = require("pino");

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
// Baileys keeps its linked-device session here (multi-file auth state).
// This intentionally differs from the old wwebjs ./.wwebjs_auth — the
// session formats are incompatible, so the migration requires one QR
// re-link, after which the session persists across restarts.
const AUTH_DIR = process.env.WA_AUTH_DIR || "./baileys_auth";

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
// Don't try to download/forward media larger than this (memory + transcribe
// cost guard). Bigger files are logged as a note with the filename only.
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

// Baileys is chatty on its own logger; keep it quiet unless asked.
const logger = pino({ level: process.env.WA_LOG_LEVEL || "warn" });

let sock = null; // current Baileys socket instance
let saveCreds = null; // creds persister bound to AUTH_DIR
let starting = false; // guard against overlapping (re)connects
let LOGGED_OUT_CODE = 401; // DisconnectReason.loggedOut, set on first import
let downloadMediaMessage = null; // bound from the Baileys import in startSock

// ---------------------------------------------------------------------------
// CRM webhook plumbing — unchanged from the wwebjs bridge so the CRM side
// (signature verification + payload shape) keeps working byte-for-byte.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// JID / message parsing helpers. Baileys uses "<digits>@s.whatsapp.net" for
// individual chats (vs wwebjs "<digits>@c.us"); groups are "@g.us" and
// status updates "status@broadcast". The CRM still expects a "+<digits>"
// phone string, so we normalise here.
// ---------------------------------------------------------------------------

function jidToPhone(jid) {
  // "<digits>@s.whatsapp.net" or device-scoped "<digits>:3@s.whatsapp.net"
  const user = String(jid || "").split("@")[0].split(":")[0];
  const digits = user.replace(/\D/g, "");
  return digits ? "+" + digits : null;
}

// WhatsApp now commonly addresses chats by LID (a privacy alias ending in
// "@lid") instead of the phone number. The real number rides along in
// key.remoteJidAlt; we also cache lid -> phone-JID so events that only carry
// the lid (e.g. calls) can still be resolved to a real number.
const lidToPn = new Map(); // "<lid-digits>" -> "<digits>@s.whatsapp.net"

function rememberLid(primaryJid, altJid) {
  if (
    typeof primaryJid === "string" &&
    primaryJid.endsWith("@lid") &&
    typeof altJid === "string" &&
    altJid.endsWith("@s.whatsapp.net")
  ) {
    lidToPn.set(primaryJid.split("@")[0].split(":")[0], altJid);
  }
}

// Resolve any addressing form to a real phone-number JID (@s.whatsapp.net),
// or null for things we don't forward (groups @g.us, status@broadcast, or an
// unresolvable lid).
function resolvePnJid(primaryJid, altJid) {
  for (const c of [altJid, primaryJid]) {
    if (typeof c === "string" && c.endsWith("@s.whatsapp.net")) return c;
  }
  if (typeof primaryJid === "string" && primaryJid.endsWith("@lid")) {
    return lidToPn.get(primaryJid.split("@")[0].split(":")[0]) || null;
  }
  return null;
}

// Unwrap ephemeral / view-once / doc-with-caption envelopes so we read the
// real content node.
function unwrap(message) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.viewOnceMessageV2Extension?.message ||
    message?.documentWithCaptionMessage?.message ||
    message ||
    null
  );
}

function extractText(message) {
  const m = unwrap(message);
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ""
  );
}

// Map the Baileys content node to a short type string roughly matching the
// wwebjs `type` values the CRM has seen before (chat/image/video/...).
function messageType(message) {
  const m = unwrap(message);
  if (!m) return "unknown";
  if (m.conversation || m.extendedTextMessage) return "chat";
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return m.audioMessage.ptt ? "ptt" : "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  if (m.locationMessage) return "location";
  if (m.contactMessage || m.contactsArrayMessage) return "vcard";
  return "unknown";
}

function hasMediaContent(message) {
  const m = unwrap(message);
  return !!(
    m &&
    (m.imageMessage ||
      m.videoMessage ||
      m.audioMessage ||
      m.documentMessage ||
      m.stickerMessage)
  );
}

// Describe a downloadable media node (or null for non-media). `kind` maps to
// the CRM's media kinds; voice = ptt audio.
function mediaDescriptor(message) {
  const m = unwrap(message);
  if (!m) return null;
  if (m.imageMessage)
    return { kind: "image", node: m.imageMessage, mime: m.imageMessage.mimetype || "image/jpeg", filename: null, durationSec: null };
  if (m.videoMessage)
    return { kind: "video", node: m.videoMessage, mime: m.videoMessage.mimetype || "video/mp4", filename: null, durationSec: Number(m.videoMessage.seconds) || null };
  if (m.audioMessage)
    return { kind: m.audioMessage.ptt ? "voice" : "audio", node: m.audioMessage, mime: m.audioMessage.mimetype || "audio/ogg", filename: null, durationSec: Number(m.audioMessage.seconds) || null };
  if (m.documentMessage)
    return { kind: "document", node: m.documentMessage, mime: m.documentMessage.mimetype || "application/octet-stream", filename: m.documentMessage.fileName || null, durationSec: null };
  if (m.stickerMessage)
    return { kind: "sticker", node: m.stickerMessage, mime: m.stickerMessage.mimetype || "image/webp", filename: null, durationSec: null };
  return null;
}

// Download a media message and forward the bytes (+ metadata) to the CRM's
// multipart media webhook. Falls back to a plain text note if download fails
// or the file is too big, so the message is never silently dropped.
async function postMedia(msg, phone, pushname, desc, caption, ts) {
  if (!CRM_WEBHOOK_URL) return;
  const mediaUrl = CRM_WEBHOOK_URL + "/media";

  const sendNote = async (note) => {
    await postToWebhook(
      CRM_WEBHOOK_URL,
      {
        from: phone,
        direction: "in",
        pushname,
        text: caption || note || "",
        messageId: msg.key?.id,
        timestamp: ts,
        type: desc.kind,
        hasMedia: true,
      },
      "webhook"
    );
  };

  const declaredLen = Number(desc.node?.fileLength) || 0;
  if (declaredLen && declaredLen > MAX_MEDIA_BYTES) {
    console.log("[wa] media too large, skipping download:", phone, desc.kind, declaredLen);
    await sendNote(`📎 ${desc.filename || desc.kind} (завеликий файл)`);
    return;
  }

  let buffer;
  try {
    buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
  } catch (e) {
    console.error("[wa] media download failed:", e?.message);
    await sendNote();
    return;
  }
  if (buffer && buffer.length > MAX_MEDIA_BYTES) {
    await sendNote(`📎 ${desc.filename || desc.kind} (завеликий файл)`);
    return;
  }

  try {
    const form = new FormData();
    form.append("from", phone);
    form.append("kind", desc.kind);
    form.append("mime", desc.mime);
    if (desc.filename) form.append("filename", desc.filename);
    if (caption) form.append("caption", caption);
    if (msg.key?.id) form.append("messageId", msg.key.id);
    if (pushname) form.append("pushname", pushname);
    if (desc.durationSec) form.append("durationSec", String(desc.durationSec));
    form.append(
      "file",
      new Blob([buffer], { type: desc.mime }),
      desc.filename || `wa-${desc.kind}`
    );
    const res = await fetch(mediaUrl, {
      method: "POST",
      headers: { "x-bridge-secret": BRIDGE_SECRET },
      body: form,
    });
    if (!res.ok) {
      console.error("[wa] media webhook non-ok:", res.status, await res.text());
    }
  } catch (e) {
    console.error("[wa] media webhook error:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Baileys event handlers
// ---------------------------------------------------------------------------

// messages.upsert covers both directions: messages we receive (fromMe=false)
// and messages sent from any of the operator's devices incl. this bridge
// (fromMe=true). We only act on type === "notify" (live messages); "append"
// /"prepend" are history sync we don't want to replay into the CRM.
async function handleUpsert({ messages, type }) {
  if (type !== "notify") return;
  for (const msg of messages || []) {
    try {
      rememberLid(msg.key?.remoteJid, msg.key?.remoteJidAlt);
      const pnJid = resolvePnJid(msg.key?.remoteJid, msg.key?.remoteJidAlt);
      if (!pnJid) continue; // groups / broadcast / status / unresolved lid
      const phone = jidToPhone(pnJid);
      if (!phone) continue;

      const text = extractText(msg.message) || "";
      const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
      const type_ = messageType(msg.message);
      const media = hasMediaContent(msg.message);

      // Skip protocol/system noise (receipts, reactions, app-state syncs,
      // empty notifications): no text, no media, unrecognised type — nothing
      // worth a CRM timeline entry. Real content always has text or media,
      // or a recognised type (location/vcard).
      if (!text && !media && type_ === "unknown") continue;

      if (msg.key.fromMe) {
        // Outbound capture — fires whenever the operator sends from phone,
        // another linked device, or this bridge. CRM treats `from` as the
        // other party (the recipient JID here).
        const payload = {
          from: phone,
          direction: "out",
          text,
          messageId: msg.key.id,
          timestamp: ts,
          type: type_,
          hasMedia: media,
        };
        console.log("[wa] outbound to", phone, "len=", text.length);
        if (CRM_WEBHOOK_URL) {
          await postToWebhook(CRM_WEBHOOK_URL, payload, "webhook-out");
        }
      } else {
        // pushName is the sender's WhatsApp profile name; may be absent.
        const pushname = msg.pushName ?? null;
        const desc = mediaDescriptor(msg.message);
        if (desc) {
          // Media inbound: download the bytes and forward to the CRM's
          // multipart endpoint (which stores + transcribes voice). `text`
          // here is the caption, if any.
          console.log("[wa] inbound media from", phone, desc.kind, pushname ? `(~${pushname})` : "");
          await postMedia(msg, phone, pushname, desc, text, ts);
        } else {
          const payload = {
            from: phone,
            direction: "in",
            pushname,
            text,
            messageId: msg.key.id,
            timestamp: ts,
            type: type_,
            hasMedia: media,
          };
          console.log(
            "[wa] inbound from",
            phone,
            pushname ? `(~${pushname})` : "",
            "len=",
            text.length
          );
          if (CRM_WEBHOOK_URL) {
            await postToWebhook(CRM_WEBHOOK_URL, payload, "webhook");
          }
        }
      }
    } catch (e) {
      console.error("[wa] upsert handler error:", e);
    }
  }
}

// Incoming calls. Baileys emits an array of call-state objects; we only ping
// on the initial "offer" so a single call doesn't fan out multiple Telegram
// alerts. We never auto-answer, so from the operator's POV it's a missed call.
async function handleCall(calls) {
  for (const call of calls || []) {
    try {
      if (call.status && call.status !== "offer") continue;
      const jid = resolvePnJid(
        call.from || call.chatId || call.peerJid,
        call.fromAlt
      );
      if (!jid) {
        console.log("[wa] call from unresolved jid, skipping ping:", call.from);
        continue;
      }
      const phone = jidToPhone(jid);
      let ts = Math.floor(Date.now() / 1000);
      if (call.date) {
        const d = new Date(call.date).getTime();
        if (!Number.isNaN(d)) ts = Math.floor(d / 1000);
      }
      const payload = {
        from: phone,
        callId: call.id ?? null,
        timestamp: ts,
        isVideo: !!call.isVideo,
        // No clean "missed" flag — we never answer, so any incoming call is
        // effectively missed/unanswered from the operator's POV.
        missed: true,
      };
      console.log(
        "[wa] incoming call from",
        phone,
        payload.isVideo ? "(video)" : ""
      );
      if (CRM_CALL_WEBHOOK_URL) {
        await postToWebhook(CRM_CALL_WEBHOOK_URL, payload, "call-webhook");
      }
    } catch (e) {
      console.error("[wa] call handler error:", e);
    }
  }
}

async function onConnectionUpdate(u) {
  const { connection, lastDisconnect, qr } = u;

  if (qr) {
    try {
      state.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
      state.qrText = qr;
      state.status = "qr_pending";
      state.lastError = null;
      console.log("[wa] QR received, length:", qr.length);
    } catch (e) {
      console.error("[wa] QR encode error:", e);
    }
  }

  if (connection === "connecting" && state.status !== "qr_pending") {
    state.status = "authenticated";
  }

  if (connection === "open") {
    state.status = "ready";
    state.readySince = new Date().toISOString();
    state.qrDataUrl = null;
    state.qrText = null;
    state.lastError = null;
    try {
      const phone = jidToPhone(sock?.user?.id);
      state.phone = phone ? phone.replace("+", "") : null;
      state.pushname = sock?.user?.name ?? sock?.user?.verifiedName ?? null;
    } catch {}
    console.log("[wa] ready as", state.phone, state.pushname);
  }

  if (connection === "close") {
    const code = lastDisconnect?.error?.output?.statusCode;
    const reason = lastDisconnect?.error?.message || String(code || "unknown");
    const loggedOut = code === LOGGED_OUT_CODE;
    const previousPhone = state.phone;
    console.log(
      "[wa] connection closed:",
      code,
      reason,
      loggedOut ? "(logged out)" : ""
    );
    state.phone = null;
    state.readySince = null;
    sock = null;

    if (loggedOut) {
      // Session is dead on WhatsApp's side — wipe creds so the next connect
      // surfaces a fresh QR instead of looping on a rejected session.
      state.status = "auth_failure";
      state.lastError = "logged_out";
      notifyStatus("auth_failure", "logged_out", previousPhone);
      try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } catch (e) {
        console.error("[wa] failed to clear auth dir:", e.message);
      }
      setTimeout(() => startSock().catch(() => {}), 2000);
    } else {
      state.status = "disconnected";
      state.lastError = reason;
      notifyStatus("disconnected", reason, previousPhone);
      setTimeout(() => startSock().catch(() => {}), 5000);
    }
  }
}

// Bring up (or re-bring up) the Baileys socket. Imported dynamically because
// @whiskeysockets/baileys is ESM-only and this bridge stays CommonJS.
async function startSock() {
  if (starting || sock) return;
  starting = true;
  try {
    const baileys = await import("@whiskeysockets/baileys");
    const makeWASocket = baileys.default;
    downloadMediaMessage = baileys.downloadMediaMessage;
    const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason } =
      baileys;
    LOGGED_OUT_CODE = DisconnectReason.loggedOut;

    const { state: authState, saveCreds: persist } = await useMultiFileAuthState(
      AUTH_DIR
    );
    saveCreds = persist;

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (e) {
      console.error("[wa] fetchLatestBaileysVersion failed, using bundled:", e.message);
    }

    sock = makeWASocket({
      version,
      auth: authState,
      logger,
      browser: Browsers.ubuntu("Chrome"),
      // Don't steal notifications from the phone — keep the device passive.
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", onConnectionUpdate);
    sock.ev.on("messages.upsert", handleUpsert);
    sock.ev.on("call", handleCall);
  } catch (e) {
    console.error("[wa] startSock error:", e);
    state.status = "error";
    state.lastError = e.message;
    sock = null;
    setTimeout(() => startSock().catch(() => {}), 5000);
  } finally {
    starting = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP control surface — identical routes/contract to the previous bridge.
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "1mb" }));

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

app.post("/send", requireSecret, async (req, res) => {
  if (state.status !== "ready" || !sock) {
    return res
      .status(409)
      .json({ ok: false, error: "not_ready", status: state.status });
  }
  const { to, text } = req.body || {};
  if (!to || !text || !String(text).trim()) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }

  const now = Date.now();
  const wait = MIN_SEND_INTERVAL_MS - (now - lastSendAt.ts);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSendAt.ts = Date.now();

  const digits = String(to).replace(/\D/g, "");
  if (!digits) return res.status(400).json({ ok: false, error: "invalid_phone" });

  try {
    // Resolve the canonical JID and confirm the number is on WhatsApp.
    const results = await sock.onWhatsApp(digits);
    const hit = Array.isArray(results) ? results.find((r) => r && r.exists) : null;
    if (!hit) {
      return res.status(404).json({ ok: false, error: "not_on_whatsapp" });
    }
    const sent = await sock.sendMessage(hit.jid, { text: String(text) });
    res.json({ ok: true, messageId: sent?.key?.id });
  } catch (e) {
    console.error("[wa] send error:", e);
    res.status(500).json({ ok: false, error: e.message || "send_failed" });
  }
});

app.post("/logout", requireSecret, async (_req, res) => {
  try {
    // logout() triggers a connection close with loggedOut, which wipes the
    // creds and re-arms a fresh QR via onConnectionUpdate.
    if (sock) await sock.logout();
    state.status = "disconnected";
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[wa] bridge listening on ${HOST}:${PORT}`);
});

console.log("[wa] initializing Baileys client…");
startSock().catch((e) => {
  console.error("[wa] initialize error:", e);
  state.status = "error";
  state.lastError = e.message;
});

process.on("SIGTERM", async () => {
  console.log("[wa] SIGTERM, shutting down");
  try {
    await sock?.end?.(undefined);
  } catch {}
  process.exit(0);
});
