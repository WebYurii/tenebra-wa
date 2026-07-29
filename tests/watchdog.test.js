"use strict";

// node --test tests/  (или npm test)
const test = require("node:test");
const assert = require("node:assert");
const { isStuck } = require("../lib/watchdog");

const MIN = 60 * 1000;
const THRESHOLD = 3 * MIN;
const NOW = 1_785_000_000_000;

test("рабочий мост не трогаем, сколько бы он ни висел в ready", () => {
  assert.equal(isStuck("ready", NOW - 10 * MIN, NOW, THRESHOLD), false);
});

test("ожидание сканирования QR — это не залип, там ждут человека", () => {
  assert.equal(isStuck("qr_pending", NOW - 10 * MIN, NOW, THRESHOLD), false);
});

test("зависание в connecting дольше порога — рвём", () => {
  // Ровно этот случай 29.07.2026: 405, переподключение, и тишина 15 часов.
  assert.equal(isStuck("authenticated", NOW - 15 * 60 * MIN, NOW, THRESHOLD), true);
});

test("короткое connecting не трогаем — обычное переподключение занимает секунды", () => {
  assert.equal(isStuck("authenticated", NOW - 20 * 1000, NOW, THRESHOLD), false);
});

test("на границе порога уже рвём", () => {
  assert.equal(isStuck("authenticated", NOW - THRESHOLD, NOW, THRESHOLD), true);
});

test("disconnected тоже под присмотром: цепочка ретраев может оборваться", () => {
  assert.equal(isStuck("disconnected", NOW - 5 * MIN, NOW, THRESHOLD), true);
});

test("error и auth_failure не остаются навсегда", () => {
  assert.equal(isStuck("error", NOW - 5 * MIN, NOW, THRESHOLD), true);
  assert.equal(isStuck("auth_failure", NOW - 5 * MIN, NOW, THRESHOLD), true);
});

test("битые метки времени не вызывают вечный перезапуск", () => {
  assert.equal(isStuck("authenticated", NaN, NOW, THRESHOLD), false);
  assert.equal(isStuck("authenticated", NOW, NaN, THRESHOLD), false);
});
