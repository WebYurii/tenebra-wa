"use strict";

// Отбор из истории WhatsApp того, что нужно донести в CRM.
//
// История приходит пачкой за весь синк: чужие чаты, свои же сообщения,
// текст без вложений. Нас интересует только входящее медиа нужного чата —
// то, что в своё время потерялось на 401 bad_signature.
//
// Вынесено отдельно от index.js, чтобы проверяться тестами без сокета.

/**
 * @param {Array} messages        WAMessage[] из messaging-history.set
 * @param {object} opts
 * @param {string} opts.jid       чат, который восстанавливаем
 * @param {Set<string>|null} opts.want  нужные виды медиа (null = любые)
 * @param {(m: object) => object|null} opts.describe  mediaDescriptor из index.js
 * @returns {{ seen: Array, collected: Array }}
 */
function pickHistoryMedia(messages, { jid, want, describe }) {
  const seen = [];
  const collected = [];
  for (const m of messages || []) {
    if (m?.key?.remoteJid !== jid) continue;
    seen.push({ id: m.key.id, fromMe: !!m.key.fromMe });
    if (m.key.fromMe) continue; // свои сообщения в CRM и так есть
    const desc = describe(m.message);
    if (!desc) continue;
    if (want && !want.has(desc.kind)) continue;
    collected.push({ msg: m, desc });
  }
  return { seen, collected };
}

module.exports = { pickHistoryMedia };
