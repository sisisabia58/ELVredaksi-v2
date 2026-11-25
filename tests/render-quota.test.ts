import { afterEach, describe, expect, it } from "vitest";
import { createTestSql } from "../src/db/client";
import { seedDefaults } from "../src/db/seed";
import { runCopywriter, runDesigner } from "../src/jobs/handlers";
import { DemoLlm } from "../src/llm/provider";
import {
  autoRendersUsed,
  maxAutoRendersPerDay,
  quotaDay,
  reserveAutoRender,
} from "../src/jobs/render-quota";
import { FakeRasterizer } from "../src/render/raster";

const slides = [
  { role: "cover", kicker: "AI", headline: "Iklan baru bisa nyamar", body: "Pembuka." },
  { role: "cta", kicker: "Sumber", headline: "Baca lengkapnya di link bio", body: "Ke artikel Contoh." },
];

async function seed(count: number) {
  const sql = await createTestSql();
  await seedDefaults(sql);
  await sql.rows("insert into sources (id, name, url, lang) values ($1,$2,$3,$4)", [
    "11111111-1111-1111-1111-111111111111",
    "Contoh",
    "https://news.example/feed",
    "ID",
  ]);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const topic = `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}`;
    const draft = `bbbbbbbb-bbbb-bbbb-bbbb-${String(i).padStart(12, "0")}`;
    await sql.rows(
      "insert into topics (id, source_id, title, url, state) values ($1,$2,$3,$4,'drafted')",
      [topic, "11111111-1111-1111-1111-111111111111", `Topik ${i}`, `https://news.example/${i}`],
    );
    await sql.rows(
      `insert into drafts (id, topic_id, status, format, template, slides, caption, hashtags, alt_headlines, short_code)
       values ($1,$2,'drafted','teaser_bio','serif',$3::jsonb,'cap','[]'::jsonb,'[]'::jsonb,$4)`,
      [draft, topic, JSON.stringify(slides), `code${i}`],
    );
    ids.push(draft);
  }
  return { sql, ids };
}

async function assetCount(sql: Awaited<ReturnType<typeof createTestSql>>, draftId: string) {
  const rows = await sql.rows<{ n: number }>("select count(*)::int as n from assets where draft_id = $1", [draftId]);
  return Number(rows[0]?.n ?? 0);
}

const saved = process.env.MAX_IMAGE_GENERATIONS_PER_DAY;
afterEach(() => {
  if (saved === undefined) delete process.env.MAX_IMAGE_GENERATIONS_PER_DAY;
  else process.env.MAX_IMAGE_GENERATIONS_PER_DAY = saved;
});

describe("daily automatic render cap", () => {
  it("reads MAX_IMAGE_GENERATIONS_PER_DAY with a default of 10", () => {
    expect(maxAutoRendersPerDay({})).toBe(10);
    expect(maxAutoRendersPerDay({ MAX_IMAGE_GENERATIONS_PER_DAY: "" })).toBe(10);
    expect(maxAutoRendersPerDay({ MAX_IMAGE_GENERATIONS_PER_DAY: " 25 " })).toBe(25);
    expect(maxAutoRendersPerDay({ MAX_IMAGE_GENERATIONS_PER_DAY: "0" })).toBe(0);
    expect(maxAutoRendersPerDay({ MAX_IMAGE_GENERATIONS_PER_DAY: "-3" })).toBe(10);
    expect(maxAutoRendersPerDay({ MAX_IMAGE_GENERATIONS_PER_DAY: "abc" })).toBe(10);
  });

  it("resets at midnight WIB, not UTC", async () => {
    expect(quotaDay(new Date("2026-11-22T16:59:59Z"))).toBe("2026-11-22");
    expect(quotaDay(new Date("2026-11-22T17:00:00Z"))).toBe("2026-11-23");
    const sql = await createTestSql();
    const late = new Date("2026-11-22T16:30:00Z");
    expect(await reserveAutoRender(sql, late, 1)).toBe(true);
    expect(await reserveAutoRender(sql, late, 1)).toBe(false);
    const nextWibDay = new Date("2026-11-22T17:30:00Z");
    expect(await reserveAutoRender(sql, nextWibDay, 1)).toBe(true);
    expect(await reserveAutoRender(sql, late, 0)).toBe(false);
  });

  it("skips automatic renders past the cap but keeps manual renders working", async () => {
    process.env.MAX_IMAGE_GENERATIONS_PER_DAY = "2";
    const { sql, ids } = await seed(4);
    const now = new Date("2026-11-22T03:00:00Z");
    for (const id of ids.slice(0, 3)) {
      await runDesigner({ sql, payload: { draftId: id }, manual: false, now, rasterizer: new FakeRasterizer() });
    }
    expect(await assetCount(sql, ids[0])).toBeGreaterThan(0);
    expect(await assetCount(sql, ids[1])).toBeGreaterThan(0);
    expect(await assetCount(sql, ids[2])).toBe(0);
    expect(await autoRendersUsed(sql, now)).toBe(2);
    const log = await sql.rows<{ message: string }>("select message from activity where agent = 'designer'");
    expect(log.map((row) => row.message)).toContain('Batas 2 gambar otomatis hari ini tercapai, "Iklan baru bisa nyamar" dilewati');

    // A retry of a job that already took its slot does not count again.
    await runDesigner({ sql, payload: { draftId: ids[3] }, manual: false, now, attempts: 1, rasterizer: new FakeRasterizer() });
    expect(await assetCount(sql, ids[3])).toBeGreaterThan(0);
    expect(await autoRendersUsed(sql, now)).toBe(2);

    await runDesigner({ sql, payload: { draftId: ids[2] }, manual: true, now, rasterizer: new FakeRasterizer() });
    expect(await assetCount(sql, ids[2])).toBeGreaterThan(0);
  });

  it("turns automatic renders off when the cap is 0", async () => {
    process.env.MAX_IMAGE_GENERATIONS_PER_DAY = "0";
    const { sql, ids } = await seed(1);
    await runDesigner({ sql, payload: { draftId: ids[0] }, manual: false, now: new Date(), rasterizer: new FakeRasterizer() });
    expect(await assetCount(sql, ids[0])).toBe(0);
  });

  it("does not write automatic drafts once the day's images are used up", async () => {
    process.env.MAX_IMAGE_GENERATIONS_PER_DAY = "1";
    const { sql } = await seed(0);
    const now = new Date("2026-11-22T03:00:00Z");
    for (const i of [1, 2]) {
      await sql.rows(
        "insert into topics (id, source_id, title, url, state) values ($1,$2,$3,$4,'passed')",
        [`cccccccc-cccc-cccc-cccc-00000000000${i}`, "11111111-1111-1111-1111-111111111111", `Lolos ${i}`, `https://news.example/p${i}`],
      );
    }
    await runCopywriter({ sql, payload: { topicId: "cccccccc-cccc-cccc-cccc-000000000001" }, manual: false, now, llm: new DemoLlm() });
    expect(await reserveAutoRender(sql, now, 1)).toBe(true);
    await runCopywriter({ sql, payload: { topicId: "cccccccc-cccc-cccc-cccc-000000000002" }, manual: false, now, llm: new DemoLlm() });
    const drafts = await sql.rows<{ topic_id: string }>("select topic_id from drafts");
    expect(drafts.map((row) => row.topic_id)).toEqual(["cccccccc-cccc-cccc-cccc-000000000001"]);
    const state = await sql.rows<{ state: string }>("select state from topics where id = $1", [
      "cccccccc-cccc-cccc-cccc-000000000002",
    ]);
    expect(state[0]?.state).toBe("passed");
    // A person can still draft it.
    await runCopywriter({ sql, payload: { topicId: "cccccccc-cccc-cccc-cccc-000000000002" }, manual: true, now, llm: new DemoLlm() });
    expect(await sql.rows("select id from drafts")).toHaveLength(2);
  });
});
