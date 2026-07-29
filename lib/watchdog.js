"use strict";

// Решение «мост завис — пора рвать сокет и подниматься заново».
//
// 29.07.2026 Baileys получил 405, переподключился — и новый сокет застрял в
// "connecting" навсегда: ни "open", ни "close". Вся логика переподключения в
// index.js висит на событии "close", поэтому такой залип для неё невидим, а
// startSock() выходит по `if (starting || sock) return`, пока в переменной
// лежит мёртвый сокет. Итог: pm2 зелёный, /status бодро отвечает
// "authenticated", сообщения не ходят 15 часов.
//
// Отдельным файлом — чтобы это можно было проверить тестами, не поднимая
// сокет и HTTP-сервер.

// Состояния, в которых мост работает или законно ждёт человека.
// qr_pending — на экране QR, ждём, пока его отсканируют: рвать нечего.
const HEALTHY = new Set(["ready", "qr_pending"]);

/**
 * @param {string} status      текущий state.status моста
 * @param {number} sinceMs     когда статус сменился в последний раз (epoch ms)
 * @param {number} now         текущее время (epoch ms)
 * @param {number} thresholdMs сколько терпим не-рабочее состояние
 * @returns {boolean}
 */
function isStuck(status, sinceMs, now, thresholdMs) {
  if (HEALTHY.has(status)) return false;
  if (!Number.isFinite(sinceMs) || !Number.isFinite(now)) return false;
  return now - sinceMs >= thresholdMs;
}

module.exports = { isStuck, HEALTHY };
