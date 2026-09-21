"use strict";

// Подпись тела вебхука: HMAC-SHA256 ровно тех байтов, что уходят в сеть.
//
// 26.07.2026 CRM включила обязательную проверку подписи на /media, а мост
// подписывал только JSON-вебхуки. Медиа уходило как FormData прямо в fetch:
// тело собирал undici уже внутри, до него было не дотянуться — значит, и
// подписать нечего. Два месяца каждое голосовое, фото и файл из WhatsApp
// умирали на 401 bad_signature, и никто этого не видел: ошибка была только в
// логах моста.
//
// Поэтому байты собираем сами (packForm), их же подписываем, их же шлём.

const { createHmac } = require("node:crypto");

/**
 * Собрать FormData в те самые байты, которые пойдут в сеть, и вернуть их
 * вместе с content-type (в нём boundary, без него тело не разобрать).
 * @param {FormData} form
 * @returns {Promise<{ body: Buffer, contentType: string }>}
 */
async function packForm(form) {
  const packed = new Response(form);
  const contentType = packed.headers.get("content-type") || "";
  const body = Buffer.from(await packed.arrayBuffer());
  return { body, contentType };
}

/**
 * @param {string} secret
 * @param {string|Buffer} body  ровно то, что уйдёт в body запроса
 * @returns {string} "sha256=<hex>" — формат, который ждёт CRM
 */
function signBody(secret, body) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

module.exports = { packForm, signBody };
