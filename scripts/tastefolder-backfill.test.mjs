import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPayload,
  hasPriorTargetMessage,
  validateTargetRows,
} from "./tastefolder-backfill.mjs";

const rows = ["32", "28", "30", "29", "31"].map((chapter_number) => ({
  chapter_number,
  thumbnail_url: `https://img.example.test/${chapter_number}.jpg`,
  published_at: null,
  delivery_pending: false,
}));

test("groups exactly TasteFolder chapters 28-32 in one Discord post", () => {
  const payload = buildPayload(rows);
  assert.match(payload.content, /capítulos 28, 29, 30, 31, 32/);
  assert.deepEqual(payload.embeds.map((embed) => embed.title), [
      "Capítulo 28", "Capítulo 29", "Capítulo 30", "Capítulo 31", "Capítulo 32",
  ]);
});

test("refuses incomplete, previously published, or already pending rows", () => {
  assert.throws(() => validateTargetRows(rows.slice(1)), /exactly the five/);
  assert.throws(() => validateTargetRows(rows.map((row) =>
    row.chapter_number === "29" ? { ...row, published_at: new Date() } : row,
  )), /not in the expected unsent state/);
  assert.throws(() => validateTargetRows(rows.map((row) =>
    row.chapter_number === "30" ? { ...row, delivery_pending: true } : row,
  )), /not in the expected unsent state/);
});

test("detects duplicate TasteFolder posts without matching other works or 128", () => {
  assert.equal(hasPriorTargetMessage([{ content: "**TasteFolder** · capítulo 28" }]), true);
  assert.equal(hasPriorTargetMessage([{ content: "**Other work** · capítulo 28" }]), false);
  assert.equal(hasPriorTargetMessage([{ content: "**TasteFolder** · capítulo 128" }]), false);
});
