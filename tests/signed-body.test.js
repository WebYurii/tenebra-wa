"use strict";

// node --test tests/  (или npm test)
//
// Регрессия на 401 bad_signature от 26.07.2026: мост подписывал JSON, но не
// multipart, и медиа из WhatsApp два месяца не доезжало до CRM. Тест
// проверяет обе стороны: что байты тела мы получаем до отправки и что
// подпись над ними сходится с той, которую считает CRM.

const test = require("node:test");
const assert = require("node:assert");
const { createHmac } = require("node:crypto");
const { packForm, signBody } = require("../lib/signed-body");

const SECRET = "test-bridge-secret-32-chars-long-xy";

// Как считает CRM (lib/whatsapp.ts: verifyBridgeSignature) — по сырому телу.
function crmExpects(raw) {
  return createHmac("sha256", SECRET).update(raw).digest("hex");
}

function voiceForm(bytes) {
  const form = new FormData();
  form.append("from", "+380689624497");
  form.append("kind", "voice");
  form.append("mime", "audio/ogg; codecs=opus");
  form.append("durationSec", "21");
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }), "wa-voice");
  return form;
}

test("packForm отдаёт тело и content-type с boundary", async () => {
  const { body, contentType } = await packForm(voiceForm([1, 2, 3]));
  assert.ok(Buffer.isBuffer(body));
  assert.match(contentType, /^multipart\/form-data; boundary=.+/);
  const boundary = contentType.split("boundary=")[1];
  assert.ok(body.includes(boundary), "boundary из заголовка должен встречаться в теле");
  assert.ok(body.toString("latin1").includes('name="kind"'));
});

test("подпись сходится с той, которую ждёт CRM", async () => {
  const { body } = await packForm(voiceForm([1, 2, 3]));
  assert.equal(signBody(SECRET, body), "sha256=" + crmExpects(body));
});

test("бинарные байты не портятся: подпись над буфером, а не над строкой", async () => {
  // 0x80..0xFF поодиночке — невалидный utf-8; через строку подпись бы поплыла.
  const { body } = await packForm(voiceForm([0xff, 0xfe, 0x80, 0x81, 0x00, 0xc3]));
  assert.equal(signBody(SECRET, body), "sha256=" + crmExpects(body));
  assert.notEqual(
    signBody(SECRET, body),
    "sha256=" + crmExpects(Buffer.from(body.toString("utf8"), "utf8"))
  );
});

test("разные тела — разные подписи", async () => {
  const a = await packForm(voiceForm([1, 1, 1]));
  const b = await packForm(voiceForm([2, 2, 2]));
  assert.notEqual(signBody(SECRET, a.body), signBody(SECRET, b.body));
});

test("JSON подписывается в том же формате sha256=<hex>", () => {
  const body = JSON.stringify({ from: "+380501112233", direction: "in" });
  assert.equal(signBody(SECRET, body), "sha256=" + crmExpects(body));
});
