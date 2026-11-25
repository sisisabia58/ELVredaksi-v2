import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestSql } from "../src/db/client";
import { seedDefaults } from "../src/db/seed";
import { calculator, faq, packages } from "../src/marketing/content";

describe("marketing offer", () => {
  it("matches the inspected price math", () => {
    expect(packages.map((p) => p.price)).toEqual([5_000_000, 7_000_000]);
    expect(calculator(12)).toEqual({ team: 228_000_000, once: 5_000_000, save: 223_000_000 });
    expect(calculator(3).team).toBe(57_000_000);
    expect(faq).toHaveLength(8);
    expect(faq.some((item) => item.answer.toLowerCase().includes("tiktok"))).toBe(true);
    expect(JSON.stringify({ packages, faq })).not.toMatch(/0899|jimmimohtar|1\.480/);
  });
});

describe("perspective channel positioning", () => {
  const page = readFileSync("app/(marketing)/page.tsx", "utf8");
  const deck = readFileSync("components/marketing/deck.tsx", "utf8");

  it("no longer promises article photos and says perspective", () => {
    expect(page).not.toMatch(/memakai foto|mengunduh|di cache/i);
    expect(page).toMatch(/perspektif/i);
    expect(page).toMatch(/Ilustrasi AI/);
    expect(deck).toMatch(/crawl/i);
    expect(deck).not.toMatch(/memakai foto|mengunduh|di cache/i);
  });

  it("seeds Brain notes for essays, with author credit and no news wording in the intro notes", async () => {
    const sql = await createTestSql();
    await seedDefaults(sql);
    const docs = await sql.rows<{ slug: string; body: string }>("select slug, body from brain_docs");
    const body = (slug: string) => docs.find((d) => d.slug === slug)?.body ?? "";
    expect(body("00-baca-dulu").toLowerCase()).not.toContain("berita");
    expect(body("01-brand-voice").toLowerCase()).not.toContain("berita");
    expect(body("03-aturan-caption").toLowerCase()).toContain("penulis");
    expect(body("06-aturan-carousel").toLowerCase()).not.toContain("foto diambil");
  });
});
