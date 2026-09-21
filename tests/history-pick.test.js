"use strict";

// node --test tests/  (или npm test)
//
// Отбор медиа из on-demand истории (/pull-history): в пачке лежат чужие
// чаты, свои же сообщения и голый текст — забрать надо только входящее
// медиа нужного чата.

const test = require("node:test");
const assert = require("node:assert");
const { pickHistoryMedia } = require("../lib/history-pick");

const JID = "380689624497@s.whatsapp.net";

// Упрощённый mediaDescriptor: важно лишь, что он даёт kind или null.
const describe = (m) => {
  if (m?.audioMessage) return { kind: m.audioMessage.ptt ? "voice" : "audio" };
  if (m?.imageMessage) return { kind: "image" };
  return null;
};

const msg = (id, { jid = JID, fromMe = false, message = null } = {}) => ({
  key: { id, remoteJid: jid, fromMe },
  message,
});

const voice = { audioMessage: { ptt: true, seconds: 21 } };
const photo = { imageMessage: {} };
const text = { conversation: "привіт" };

test("берём входящее голосовое нужного чата", () => {
  const { collected } = pickHistoryMedia([msg("A", { message: voice })], {
    jid: JID,
    want: new Set(["voice"]),
    describe,
  });
  assert.equal(collected.length, 1);
  assert.equal(collected[0].desc.kind, "voice");
});

test("чужой чат не трогаем даже с медиа", () => {
  const { seen, collected } = pickHistoryMedia(
    [msg("A", { jid: "380000000000@s.whatsapp.net", message: voice })],
    { jid: JID, want: null, describe }
  );
  assert.deepEqual(seen, []);
  assert.equal(collected.length, 0);
});

test("свои сообщения видим, но не пересылаем — они в CRM уже есть", () => {
  const { seen, collected } = pickHistoryMedia(
    [msg("A", { fromMe: true, message: voice })],
    { jid: JID, want: null, describe }
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].fromMe, true);
  assert.equal(collected.length, 0);
});

test("текст без вложений пропускаем", () => {
  const { seen, collected } = pickHistoryMedia([msg("A", { message: text })], {
    jid: JID,
    want: null,
    describe,
  });
  assert.equal(seen.length, 1);
  assert.equal(collected.length, 0);
});

test("фильтр kinds отсекает лишнее, без фильтра берём всё медиа", () => {
  const batch = [msg("A", { message: voice }), msg("B", { message: photo })];
  const onlyVoice = pickHistoryMedia(batch, { jid: JID, want: new Set(["voice"]), describe });
  assert.deepEqual(onlyVoice.collected.map((c) => c.desc.kind), ["voice"]);
  const all = pickHistoryMedia(batch, { jid: JID, want: null, describe });
  assert.deepEqual(all.collected.map((c) => c.desc.kind), ["voice", "image"]);
});

test("пустая история и мусор не роняют отбор", () => {
  for (const input of [undefined, null, [], [null], [{}]]) {
    const r = pickHistoryMedia(input, { jid: JID, want: null, describe });
    assert.equal(r.collected.length, 0);
  }
});
