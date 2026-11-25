import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSql } from "../src/db/client";
import { LlmRateLimitError, ScriptedLlm } from "../src/llm/provider";
import { seedDefaults } from "../src/db/seed";
import { SLIDE_TEMPLATES } from "../src/domain/brand";
import { runCoverJob, runDesigner, runPublisher } from "../src/jobs/handlers";
import { maxAiCoversPerDay, reserveAiCover } from "../src/jobs/cover-quota";
import { DemoImageProvider, ScriptedImageProvider, type CoverRequest, type ImageProvider } from "../src/image/provider";
import { FakePublisher } from "../src/publish/publisher";
import { renderSlideHtml } from "../src/render/html";
import { approveDraft, postDraftNow, scheduleDraft } from "../src/studio/drafts";

const DRAFT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";
const TOPIC = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const SOURCE = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-10-28T02:00:00Z");

const ENV_KEYS = ["MAX_AI_COVERS_PER_DAY", "IMAGE_PROVIDER"] as const;
const envSnapshot = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
beforeEach(() => {
  // A real provider is configured, so approving queues an AI cover.
  process.env.IMAGE_PROVIDER = "cloudflare";
});
afterEach(() => {
  for (const [key, value] of envSnapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const fakeRaster = {
  async toPng() {
    return new Uint8Array([1]);
  },
};
async function renderOnce(sql: Awaited<ReturnType<typeof createTestSql>>) {
  await runDesigner({ sql, payload: { draftId: DRAFT }, manual: true, now: NOW, rasterizer: fakeRaster });
}

const baseSlides = [
  { role: "cover", kicker: "Opini", headline: "Kenapa tim kecil menang", body: "Pembuka." },
  { role: "cta", kicker: "Sumber", headline: "Baca lengkapnya di link bio", body: "Ke Contoh." },
];

async function seed(status = "needs_review", slides: unknown[] = baseSlides) {
  const sql = await createTestSql();
  await seedDefaults(sql);
  await sql.rows("insert into sources (id, name, url, lang) values ($1,$2,$3,$4)", [
    SOURCE, "Contoh", "https://blog.example/", "ID",
  ]);
  await sql.rows("insert into topics (id, source_id, title, url, state) values ($1,$2,$3,$4,'drafted')", [
    TOPIC, SOURCE, "Esai", "https://blog.example/esai",
  ]);
  await sql.rows(
    `insert into drafts (id, topic_id, status, format, template, slides, caption, hashtags, alt_headlines, short_code, text_dirty)
     values ($1,$2,$3,'teaser_bio','serif',$4::jsonb,'Dari Contoh','[]'::jsonb,'[]'::jsonb,'cov01',false)`,
    [DRAFT, TOPIC, status, JSON.stringify(slides)],
  );
  return sql;
}

type Sql = Awaited<ReturnType<typeof createTestSql>>;

function jobs(sql: Sql, name: string) {
  return sql.rows<{ payload: { draftId: string }; manual: boolean }>(
    "select payload, manual from jobs where name = $1 and finished_at is null",
    [name],
  );
}

class CountingProvider implements ImageProvider {
  calls = 0;
  async cover(req: CoverRequest) {
    this.calls += 1;
    return new DemoImageProvider().cover(req);
  }
}

describe("approving a draft queues the AI cover", () => {
  it("marks the cover pending and queues exactly one designer.cover job", async () => {
    const sql = await seed();
    await approveDraft(sql, "admin", DRAFT);
    const row = await sql.rows<{ cover_pending: boolean; status: string }>("select cover_pending, status from drafts");
    expect(row[0]).toEqual({ cover_pending: true, status: "approved" });
    expect(await jobs(sql, "designer.cover")).toEqual([{ payload: { draftId: DRAFT }, manual: false }]);
    await expect(approveDraft(sql, "admin", DRAFT)).rejects.toThrow();
    expect(await jobs(sql, "designer.cover")).toHaveLength(1);
  });

  it("does not queue a second cover once one exists, nor over an operator-uploaded cover photo", async () => {
    const sql = await seed();
    await sql.rows("update drafts set cover_ai = true where id = $1", [DRAFT]);
    await approveDraft(sql, "admin", DRAFT);
    expect(await jobs(sql, "designer.cover")).toHaveLength(0);
    expect((await sql.rows<{ cover_pending: boolean }>("select cover_pending from drafts"))[0].cover_pending).toBe(false);

    const uploaded = await seed("needs_review", [
      { ...baseSlides[0], photoDataUrl: "data:image/png;base64,AAAA" },
      baseSlides[1],
    ]);
    await approveDraft(uploaded, "admin", DRAFT);
    expect(await jobs(uploaded, "designer.cover")).toHaveLength(0);
  });
});

describe("runCoverJob", () => {
  it("stores the cover, records spend and queues a manual re-render", async () => {
    const sql = await seed("approved");
    await sql.rows("update drafts set cover_pending = true where id = $1", [DRAFT]);
    await runCoverJob({ sql, payload: { draftId: DRAFT }, manual: false, now: NOW, imageProvider: new DemoImageProvider() });
    const row = await sql.rows<{ cover_type: string; cover_ai: boolean; cover_pending: boolean; size: number }>(
      "select cover_type, cover_ai, cover_pending, length(cover_image) as size from drafts",
    );
    expect(row[0]).toMatchObject({ cover_type: "image/png", cover_ai: true, cover_pending: false });
    expect(Number(row[0].size)).toBeGreaterThan(0);
    const spend = await sql.rows<{ agent: string; model: string }>("select agent, model from llm_spend");
    expect(spend).toEqual([
      { agent: "designer", model: "demo" },
      { agent: "designer", model: "demo" },
    ]);
    expect(await jobs(sql, "designer.render")).toEqual([{ payload: { draftId: DRAFT }, manual: true }]);
  });

  it("falls back to the geometric cover when the provider fails", async () => {
    const sql = await seed("approved");
    await sql.rows("update drafts set cover_pending = true where id = $1", [DRAFT]);
    await runCoverJob({
      sql, payload: { draftId: DRAFT }, manual: false, now: NOW,
      imageProvider: new ScriptedImageProvider([new Error("Cloudflare gagal (500)")]),
    });
    const row = await sql.rows<{ cover_ai: boolean; cover_pending: boolean }>("select cover_ai, cover_pending from drafts");
    expect(row[0]).toEqual({ cover_ai: false, cover_pending: false });
    const log = await sql.rows<{ message: string }>("select message from activity where agent = 'designer'");
    expect(log[0].message).toMatch(/geometris/);
    expect(await jobs(sql, "designer.render")).toHaveLength(1);
  });

  it("never calls the provider when the daily cap is 0", async () => {
    process.env.MAX_AI_COVERS_PER_DAY = "0";
    const sql = await seed("approved");
    await sql.rows("update drafts set cover_pending = true where id = $1", [DRAFT]);
    const provider = new CountingProvider();
    await runCoverJob({ sql, payload: { draftId: DRAFT }, manual: false, now: NOW, imageProvider: provider });
    expect(provider.calls).toBe(0);
    const row = await sql.rows<{ cover_ai: boolean; cover_pending: boolean }>("select cover_ai, cover_pending from drafts");
    expect(row[0]).toEqual({ cover_ai: false, cover_pending: false });
    expect(await jobs(sql, "designer.render")).toHaveLength(1);
  });
});

describe("cover pending gate", () => {
  it("blocks scheduling and posting while the cover is being made, then allows them", async () => {
    const sql = await seed("approved");
    await sql.rows("update drafts set cover_pending = true where id = $1", [DRAFT]);
    const later = new Date(Date.now() + 3600_000);
    await expect(scheduleDraft(sql, "admin", DRAFT, later)).rejects.toThrow(/Cover AI sedang dibuat/);
    await expect(postDraftNow(sql, "admin", DRAFT)).rejects.toThrow(/Cover AI sedang dibuat/);
    await runCoverJob({ sql, payload: { draftId: DRAFT }, manual: false, now: NOW, imageProvider: new DemoImageProvider() });
    await renderOnce(sql);
    await expect(scheduleDraft(sql, "admin", DRAFT, later)).resolves.toBeUndefined();
  });

  it("keeps scheduling blocked after the cover is stored until the new render has run", async () => {
    const sql = await seed("needs_review");
    await approveDraft(sql, "admin", DRAFT);
    await runCoverJob({ sql, payload: { draftId: DRAFT }, manual: false, now: NOW, imageProvider: new DemoImageProvider() });
    const later = new Date(Date.now() + 3600_000);
    const row = await sql.rows<{ cover_pending: boolean; text_dirty: boolean }>("select cover_pending, text_dirty from drafts");
    expect(row[0]).toEqual({ cover_pending: false, text_dirty: true });
    await expect(scheduleDraft(sql, "admin", DRAFT, later)).rejects.toThrow(/Render dulu/);
    await expect(postDraftNow(sql, "admin", DRAFT)).rejects.toThrow(/Render dulu/);
    await renderOnce(sql);
    await expect(scheduleDraft(sql, "admin", DRAFT, later)).resolves.toBeUndefined();
  });
});

describe("when an AI cover is worth making", () => {
  it("queues nothing for templates that never show a photo", async () => {
    const sql = await seed();
    await sql.rows("update drafts set template = 'stabilo' where id = $1", [DRAFT]);
    await approveDraft(sql, "admin", DRAFT);
    expect(await jobs(sql, "designer.cover")).toHaveLength(0);
    expect((await sql.rows<{ cover_pending: boolean }>("select cover_pending from drafts"))[0].cover_pending).toBe(false);
  });

  it("queues nothing with the demo provider, with no provider set, or with the cap at 0", async () => {
    for (const setup of [
      () => { process.env.IMAGE_PROVIDER = "demo"; },
      () => { delete process.env.IMAGE_PROVIDER; },
      () => { process.env.IMAGE_PROVIDER = "cloudflare"; process.env.MAX_AI_COVERS_PER_DAY = "0"; },
    ]) {
      setup();
      const sql = await seed();
      await approveDraft(sql, "admin", DRAFT);
      expect(await jobs(sql, "designer.cover")).toHaveLength(0);
      expect((await sql.rows<{ cover_pending: boolean }>("select cover_pending from drafts"))[0].cover_pending).toBe(false);
    }
  });

  it("does not generate for a draft that is no longer approved or scheduled", async () => {
    const sql = await seed("needs_review");
    await sql.rows("update drafts set cover_pending = true where id = $1", [DRAFT]);
    const provider = new CountingProvider();
    await runCoverJob({ sql, payload: { draftId: DRAFT }, manual: false, now: NOW, imageProvider: provider });
    expect(provider.calls).toBe(0);
    expect((await sql.rows<{ cover_pending: boolean }>("select cover_pending from drafts"))[0].cover_pending).toBe(false);
  });
});

describe("daily AI cover cap", () => {
  it("hands out exactly cap slots per WIB day", async () => {
    const sql = await createTestSql();
    const day1 = new Date("2026-10-28T02:00:00Z");
    expect(await reserveAiCover(sql, day1, 2)).toBe(true);
    expect(await reserveAiCover(sql, day1, 2)).toBe(true);
    expect(await reserveAiCover(sql, day1, 2)).toBe(false);
    expect(await reserveAiCover(sql, new Date("2026-10-29T02:00:00Z"), 2)).toBe(true);
    expect(await reserveAiCover(sql, day1, 0)).toBe(false);
  });
  it("reads MAX_AI_COVERS_PER_DAY with a default of 10", () => {
    expect(maxAiCoversPerDay({})).toBe(10);
    expect(maxAiCoversPerDay({ MAX_AI_COVERS_PER_DAY: "0" })).toBe(0);
    expect(maxAiCoversPerDay({ MAX_AI_COVERS_PER_DAY: "3" })).toBe(3);
    expect(maxAiCoversPerDay({ MAX_AI_COVERS_PER_DAY: "abc" })).toBe(10);
  });
});

describe("AI disclosure", () => {
  const input = (template: (typeof SLIDE_TEMPLATES)[number], index: number, aiCover: boolean) => ({
    template,
    slide: { role: index === 0 ? ("cover" as const) : ("point" as const), kicker: "Opini", headline: "Kenapa tim kecil menang", body: "Isi." },
    index,
    total: 2,
    handle: "h",
    sourceName: "Contoh",
    accent: "#4E708C",
    focalY: 50,
    photoDataUrl: null,
    aiCover,
  });
  it("labels slide 1 of an AI cover in every template and nothing else", () => {
    for (const template of SLIDE_TEMPLATES) {
      expect(renderSlideHtml(input(template, 0, true)), template).toContain("Ilustrasi AI");
      expect(renderSlideHtml(input(template, 1, true)), template).not.toContain("Ilustrasi AI");
      expect(renderSlideHtml(input(template, 0, false)), template).not.toContain("Ilustrasi AI");
    }
  });
  it("adds the caption line when the post is published", async () => {
    const sql = await seed("posting");
    await sql.rows("update drafts set cover_ai = true where id = $1", [DRAFT]);
    await sql.rows("insert into assets (id, draft_id, slide_index, bytes) values ($1,$2,0,$3)", [
      "cccccccc-cccc-cccc-cccc-ccccccccccc1", DRAFT, Buffer.from("png"),
    ]);
    const publisher = new FakePublisher();
    await runPublisher({ sql, payload: { draftId: DRAFT }, manual: true, now: NOW, publisher });
    expect(publisher.calls[0]?.caption.endsWith("Cover: ilustrasi AI.")).toBe(true);
  });
});

describe("designer uses the stored AI cover", () => {
  async function render(sql: Sql): Promise<string[]> {
    const pages: string[] = [];
    await runDesigner({
      sql,
      payload: { draftId: DRAFT },
      manual: true,
      now: NOW,
      rasterizer: {
        async toPng(html: string) {
          pages.push(html);
          return new Uint8Array([1]);
        },
      },
    });
    return pages;
  }

  it("paints the AI cover with the label on slide 1 only", async () => {
    const sql = await seed("drafted");
    const cover = await new DemoImageProvider().cover({ headline: "x", kicker: "", niche: "", accent: "#4E708C" });
    await sql.rows("update drafts set cover_image = $1, cover_type = 'image/png', cover_ai = true where id = $2", [
      Buffer.from(cover.bytes),
      DRAFT,
    ]);
    const pages = await render(sql);
    expect(pages[0]).toContain("data:image/png;base64,");
    expect(pages[0]).toContain("Ilustrasi AI");
    expect(pages[1]).not.toContain("Ilustrasi AI");
  });

  it("lets an operator-uploaded cover photo win and carries no AI label", async () => {
    const png = `data:image/png;base64,${Buffer.alloc(10, 7).toString("base64")}`;
    const sql = await seed("drafted", [{ ...baseSlides[0], photoDataUrl: png }, baseSlides[1]]);
    await sql.rows("update drafts set cover_image = $1, cover_type = 'image/png', cover_ai = true where id = $2", [
      Buffer.from("ai-bytes"),
      DRAFT,
    ]);
    const pages = await render(sql);
    expect(pages[0]).toContain(png);
    expect(pages[0]).not.toContain("Ilustrasi AI");
  });
});

describe("AI label only where the cover is visible", () => {
  it("adds no badge and no caption line on a template without a photo slot", async () => {
    const sql = await seed("drafted");
    await sql.rows("update drafts set template = 'stabilo', cover_image = $1, cover_type = 'image/png', cover_ai = true where id = $2", [
      Buffer.from("x"), DRAFT,
    ]);
    const pages: string[] = [];
    await runDesigner({
      sql, payload: { draftId: DRAFT }, manual: true, now: NOW,
      rasterizer: { async toPng(html: string) { pages.push(html); return new Uint8Array([1]); } },
    });
    expect(pages[0]).not.toContain("Ilustrasi AI");
    await sql.rows("update drafts set status = 'posting' where id = $1", [DRAFT]);
    const publisher = new FakePublisher();
    await runPublisher({ sql, payload: { draftId: DRAFT }, manual: true, now: NOW, publisher });
    expect(publisher.calls[0]?.caption).not.toContain("Cover: ilustrasi AI.");
  });
});

describe("AI badge placement", () => {
  it("sits clear of the vertical source credit on the right edge", () => {
    const html = renderSlideHtml({
      template: "berita_pro",
      slide: { role: "cover", kicker: "Opini", headline: "Judul cukup panjang", body: "Isi." },
      index: 0, total: 2, handle: "h", sourceName: "Contoh", accent: "#4E708C",
      focalY: 50, photoDataUrl: null, aiCover: true,
    });
    expect(html).toMatch(/position:fixed;right:72px;bottom:28px/);
  });
});

describe("cover concept from the article", () => {
  class CapturingProvider implements ImageProvider {
    seen: CoverRequest[] = [];
    async cover(req: CoverRequest) {
      this.seen.push(req);
      return new DemoImageProvider().cover(req);
    }
  }

  async function approvedWithExcerpt(excerpt: string) {
    const sql = await seed("approved");
    await sql.rows("update topics set excerpt = $1 where id = $2", [excerpt, TOPIC]);
    await sql.rows("update drafts set cover_pending = true where id = $1", [DRAFT]);
    return sql;
  }

  it("feeds a scene drawn from the article text to the image model", async () => {
    const sql = await approvedWithExcerpt("Petani di Karawang mengeluh stok gabah menipis di lumbung.");
    const asked: { user: string }[] = [];
    const llm = {
      async complete(req: { purpose: string; user: string }) {
        asked.push(req);
        return { text: '{"concept":"A farmer beside a half-empty grain silo at dawn"}', costUsd: 0.0001, model: "scripted" };
      },
    };
    const provider = new CapturingProvider();
    await runCoverJob({ sql, payload: { draftId: DRAFT }, manual: false, now: NOW, imageProvider: provider, llm });
    expect(provider.seen[0]?.concept).toBe("A farmer beside a half-empty grain silo at dawn");
    expect(asked[0]?.user).toContain("Kenapa tim kecil menang");
    expect(asked[0]?.user).toContain("gabah menipis");
    const spend = await sql.rows<{ model: string }>("select model from llm_spend order by model");
    expect(spend.map((row) => row.model)).toEqual(["demo", "scripted"]);
  });

  it("uses the geometric cover rather than an unrelated picture when no scene can be made", async () => {
    const sql = await approvedWithExcerpt("isi");
    const provider = new CapturingProvider();
    await runCoverJob({
      sql, payload: { draftId: DRAFT }, manual: false, now: NOW, imageProvider: provider,
      llm: new ScriptedLlm(["bukan json"]),
    });
    expect(provider.seen).toHaveLength(0);
    const row = await sql.rows<{ cover_ai: boolean; cover_pending: boolean }>("select cover_ai, cover_pending from drafts");
    expect(row[0]).toEqual({ cover_ai: false, cover_pending: false });
    const log = await sql.rows<{ message: string }>("select message from activity where agent = 'designer'");
    expect(log[0].message).toMatch(/geometris/);
  });

  it("retries later on a rate limit without using today's cover allowance", async () => {
    const sql = await approvedWithExcerpt("isi");
    const llm = { async complete(): Promise<never> { throw new LlmRateLimitError(5000); } };
    await expect(
      runCoverJob({ sql, payload: { draftId: DRAFT }, manual: false, now: NOW, imageProvider: new CapturingProvider(), llm }),
    ).rejects.toBeInstanceOf(LlmRateLimitError);
    expect((await sql.rows<{ cover_pending: boolean }>("select cover_pending from drafts"))[0].cover_pending).toBe(true);
    expect(await sql.rows("select day from cover_quota")).toHaveLength(0);
  });

  it("skips the language model entirely when the daily cap is 0", async () => {
    process.env.MAX_AI_COVERS_PER_DAY = "0";
    const sql = await approvedWithExcerpt("isi");
    let called = 0;
    const llm = { async complete() { called += 1; return { text: "{}", costUsd: 0, model: "x" }; } };
    await runCoverJob({ sql, payload: { draftId: DRAFT }, manual: false, now: NOW, imageProvider: new CapturingProvider(), llm });
    expect(called).toBe(0);
  });
});
