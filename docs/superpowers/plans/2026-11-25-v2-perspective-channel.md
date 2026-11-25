# Redaksi v2 Perspective Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the v1 news carousel app into a perspective channel: curated essays (RSS or crawled) become summarized carousels with an AI-generated cover, still approved by a human before posting.

**Architecture:** Keep the v1 pipeline (`scout.scan → analyst.score → copywriter.write → designer.render → publisher.publish`). Add a `Crawler` adapter next to the RSS fetcher so a source can be `rss` or `crawl`. Swap the analyst rubric and copywriter prompt to perspective rules and add a verbatim-copy guard. Add an `ImageProvider` adapter and one new job, `designer.cover`, that runs after a human approves a draft and feeds the existing cover-photo slot. Every new adapter ships with a local fake so tests and demo mode need no keys.

**Tech Stack:** Next.js 15, TypeScript, PGlite/Postgres (`Sql` from `src/db/client.ts`), Vitest (`npx vitest run <file>`), zod, sharp, Playwright rasterizer. Crawler: Tavily REST (Map and Extract endpoints). Images: Cloudflare Workers AI REST, model `@cf/black-forest-labs/flux-1-schnell`. Both are called with plain `fetch`, no SDK.

**Spec:** `docs/v2-plan.md`

## Global Constraints

- UI copy is Indonesian. Code, tests, logs are English.
- Human approval before every publish is unchanged: no job may move a draft to `scheduled`, `posting` or `posted`.
- Summarize only: copy is in the app's own words, credits the author and source, and never reproduces a passage of 10 or more consecutive source words.
- No copied photos: never download or hotlink an image from a source article or feed. AI covers are allowed.
- An AI cover always carries the visible label `Ilustrasi AI` on slide 1 and the caption line `Cover: ilustrasi AI.`
- AI cover is generated only after a human approves the draft, only for slide 1, and counts against its own daily cap `MAX_AI_COVERS_PER_DAY` (unset or invalid = 10, 0 = off), reset at WIB midnight.
- Crawler: `CRAWLER_PROVIDER` is `fake` (default when unset, no network) or `tavily` (needs `TAVILY_API_KEY`). `CRAWL_MAX_ARTICLES_PER_SCAN` unset or invalid = 5 articles per crawl source per scan. A fetched article under 400 characters of text is not a topic. Tavily does not return an author, so `author` is usually null; the caption always credits the source name and adds the author only when known.
- Image: `IMAGE_PROVIDER` is `demo` (default when unset, local fake, cost 0) or `cloudflare` (needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`). `CLOUDFLARE_IMAGE_USD_PER_IMAGE` sets the cost recorded per cover; unset = 0 with a one-time warning.
- Secrets (`TAVILY_API_KEY`, `CLOUDFLARE_API_TOKEN`) never appear in thrown error messages, logs, activity rows or `last_error`.
- Niche and output language are per-brand settings. `brand.output_lang` is `ID` or `EN`. `sources.lang` stays per source.
- Keep sources curated by the operator. No automatic source discovery.

## Review Focus

1. The same article reached by two URLs (`?utm_source=…`, trailing slash, `#fragment`, `?source=rss---`) must become one topic.
2. A crawled page that is a login wall, paywall stub or empty shell (text under 400 chars) must not become a topic and must put a readable error on the source row.
3. A crawled listing page full of nav, tag, author and off-site links must yield only same-host article links, at most `CRAWL_MAX_ARTICLES_PER_SCAN` per scan.
4. Copy that lifts long runs from the source must be rejected, not drafted.
5. A draft whose AI cover is still being generated must not be schedulable or postable, and an image-provider failure or exhausted cap must fall back to the geometric cover instead of leaving the draft stuck.

---

### Task 1: Crawler adapter

**Files:**
- Create: `src/crawl/crawler.ts`, `src/crawl/canonical.ts`
- Test: `tests/crawler.test.ts`

**Interfaces:**
- Produces:
  - `type CrawledArticle = { url: string; title: string; author: string | null; text: string; publishedAt: Date | null }`
  - `interface Crawler { listing(url: string): Promise<string[]>; article(url: string): Promise<CrawledArticle> }`
  - `class FakeCrawler implements Crawler` constructed with `{ listings?: Record<string, string[]>; articles?: Record<string, CrawledArticle>; failOn?: string[] }`
  - `class TavilyCrawler implements Crawler` constructed with `(apiKey: string, fetchImpl?: typeof fetch)`; `listing` uses Tavily Map, `article` uses Tavily Extract
  - `function titleFromMarkdown(markdown: string, fallbackUrl: string): string` (first `# ` heading, else the last URL path segment with dashes turned into spaces)
  - `function createCrawler(env?: Record<string, string | undefined>): Crawler` (picks by `CRAWLER_PROVIDER`)
  - `function canonicalUrl(url: string): string`
  - `function articleLinksFromListing(listingUrl: string, links: string[], max: number): string[]`

- [ ] **Step 1: Write the failing tests in `tests/crawler.test.ts`**
  - `canonicalUrl("https://Blog.Example/Post/?utm_source=x&ref=y#top")` equals `"https://blog.example/Post"`; `canonicalUrl("https://blog.example/")` equals `"https://blog.example/"`; params that are not tracking params (`?id=7`) are kept.
  - `articleLinksFromListing("https://blog.example/", [ "https://blog.example/p/one", "https://blog.example/tag/ai", "https://other.site/p/x", "https://blog.example/p/one?utm_source=a", "mailto:a@b.c", "https://blog.example/" ], 5)` returns `["https://blog.example/p/one"]` (same host only, drops the listing itself, drops `/tag/`, `/author/`, `/category/`, `/page/` paths and non-http links, dedupes by canonical URL, honours `max`).
  - `FakeCrawler.listing` returns the configured list, throws for URLs in `failOn`; `createCrawler({})` returns a `FakeCrawler`; `createCrawler({ CRAWLER_PROVIDER: "tavily" })` throws `"TAVILY_API_KEY is required"`.
  - `titleFromMarkdown("intro\n# Real Title\nbody", "https://b.example/p/x")` is `"Real Title"`; with no heading and URL `https://b.example/p/my-first-post` it is `"my first post"`.
  - `TavilyCrawler.listing` called with a stub `fetchImpl` posts the listing URL to the Map endpoint with `Authorization: Bearer <key>` and returns the URLs from the response. `TavilyCrawler.article` posts the article URL to the Extract endpoint requesting markdown, maps the first result's raw content to `text`, sets `author` to null, and throws when the response has no result for the URL (the error message names the URL, not the key). A non-2xx response throws an error whose message contains the status code and not the API key.

- [ ] **Step 2: Run `npx vitest run tests/crawler.test.ts`**
  Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/crawl/canonical.ts` and `src/crawl/crawler.ts`**
  `canonicalUrl` lower-cases host, drops fragment, drops params `utm_*`, `ref`, `source`, `fbclid`, `gclid`, and drops a trailing slash unless the path is `/`. `TavilyCrawler` calls `https://api.tavily.com/map` (body `{ url }`, response list of URLs) for `listing` and `https://api.tavily.com/extract` (body `{ urls: [url], format: "markdown" }`, response `results[].raw_content`) for `article`, both with a bearer token and a 30 s timeout. These paths and field names are from memory: check them against the Tavily docs before writing the mapping, and make the stub test assert the exact shape you verified. Run `assertPublicFetchUrl` (from `src/rss/fetch-guard.ts`) on every URL before sending it to Tavily. Never include the API key in thrown messages. `publishedAt` is null (Extract does not return it).

- [ ] **Step 4: Run `npx vitest run tests/crawler.test.ts`**
  Expected: PASS.

- [ ] **Step 5: Commit** `feat: add crawler adapter with fake and tavily`

### Task 2: Crawl sources in Scout

**Files:**
- Modify: `src/studio/sources.ts`, `src/jobs/handlers.ts:30-160` (`ScoutCtx`, `runScout`, `runScoutCron`), `src/db/sql.ts` (topics), `src/db/boot.ts:232-263` (migration list), `app/(studio)/sumber/actions.ts`, `app/(studio)/sumber/sumber-panel.tsx`, `app/(studio)/sumber/page.tsx`
- Test: `tests/scout.test.ts` (extend)

**Interfaces:**
- Consumes: `Crawler`, `canonicalUrl`, `articleLinksFromListing` from Task 1.
- Produces:
  - `SourceRow.kind: "rss" | "crawl"`; `addSource(sql, role, input: { name; url; lang; kind })` where `kind` is required and validated by zod as `"rss" | "crawl"`.
  - `ScoutCtx` gains `crawler: Crawler`.
  - `topics.author text` (nullable), added in `boot.ts` as `alter table topics add column if not exists author text`.

- [ ] **Step 1: Write the failing tests in `tests/scout.test.ts`**
  - A `crawl` source whose `FakeCrawler` listing has two article URLs and articles of 500+ chars creates two topics with `author` set, `summary` empty-safe, `excerpt` equal to the article text capped at 12000 chars, and enqueues two `analyst.score` jobs.
  - Review Focus 1: an RSS item `https://news.example/a?utm_source=x` and a crawl item `https://news.example/a/` end up as one topic whose stored `url` is `https://news.example/a`.
  - Review Focus 2: an article with 100 chars of text creates no topic and sets `sources.last_error` to a message containing `terlalu pendek`.
  - Review Focus 3: a listing with 8 valid links and `CRAWL_MAX_ARTICLES_PER_SCAN` unset fetches exactly 5 articles (assert `FakeCrawler` call count).
  - `addSource` with `kind: "crawl"` stores the kind; `listSources` returns it; `kind: "pdf"` is rejected.

- [ ] **Step 2: Run `npx vitest run tests/scout.test.ts`**
  Expected: FAIL.

- [ ] **Step 3: Implement**
  - `runScout` selects `kind` too. For `rss` keep the current path but store `canonicalUrl(item.url)`. For `crawl`, call `ctx.crawler.listing`, filter with `articleLinksFromListing(..., maxArticlesPerScan())`, skip URLs already in `topics`, fetch each with `ctx.crawler.article`, apply the 400-char rule (collect a per-source error string, continue with the other links), insert the topic as the RSS path does with `author`, `excerpt = text.slice(0, 12000)`, `summary = ""`.
  - `runScoutCron` passes `crawler: createCrawler()`.
  - Sumber form gets a `Jenis` select (`RSS/Atom`, `Crawl halaman daftar`); the action passes `kind`. The help text for `crawl` says the URL is a listing page of articles.

- [ ] **Step 4: Run `npx vitest run tests/scout.test.ts`**
  Expected: PASS, existing scout tests still pass.

- [ ] **Step 5: Commit** `feat: crawl-listing sources in scout`

### Task 3: Remove copied photos

**Files:**
- Modify: `src/jobs/handlers.ts` (`runScout` image fill block, `runDesigner` cover fallback), `src/rss/parse.ts` (stop exposing `imageUrl` use only; keep parsing), `src/db/seed.ts` (Brain doc 06 text)
- Test: `tests/render.test.ts`, `tests/scout.test.ts` (extend)

**Interfaces:**
- Produces: topics always get `image_url = null` from Scout; the designer never calls `cachedImageDataUrl` for a cover.

- [ ] **Step 1: Write the failing tests**
  - Scout: an RSS item with an `enclosure` image inserts a topic whose `image_url` is null.
  - Designer: a draft whose topic row has `image_url = 'https://cdn.example/a.jpg'` renders with a stub rasterizer without any row appearing in `image_cache` and without any fetch call (use a `fetchImpl` spy via `vi.stubGlobal("fetch", …)` that fails the test if called).

- [ ] **Step 2: Run `npx vitest run tests/scout.test.ts tests/render.test.ts`**
  Expected: FAIL.

- [ ] **Step 3: Implement**
  Delete the "known topic fills image" block and the `imageUrl` insert value in `runScout`, delete the `cachedImageDataUrl` fallback in `runDesigner` (keep the operator-uploaded `photoDataUrl` path untouched), and replace the last sentence of Brain doc 06 ("Foto diambil dari gambar artikel…") with "Cover dibuat AI atau diunggah operator. Jangan memakai foto dari artikel."

- [ ] **Step 4: Run the full suite `npx vitest run`**
  Expected: PASS.

- [ ] **Step 5: Commit** `feat: stop using article photos on covers`

### Task 4: Niche and output language settings

**Files:**
- Modify: `src/db/sql.ts` (brand), `src/db/boot.ts` (migrations), `src/studio/settings.ts` (`Settings`, `SettingsInput`, `getSettings`, `saveSettings`), `app/(studio)/pengaturan/pengaturan-form.tsx`, `app/(studio)/pengaturan/actions.ts`
- Test: `tests/brain-settings.test.ts` (extend)

**Interfaces:**
- Produces: `Settings.niche: string` (0–120 chars, default `""`), `Settings.outputLang: "ID" | "EN"` (default `"ID"`), stored as `brand.niche`, `brand.output_lang`.

- [ ] **Step 1: Write the failing tests**
  `saveSettings` with `niche: "keuangan pribadi"` and `outputLang: "EN"` round-trips through `getSettings`; `outputLang: "FR"` is rejected; a 121-char niche is rejected; a `social_media` role can still not save settings (existing admin rule).

- [ ] **Step 2: Run `npx vitest run tests/brain-settings.test.ts`**
  Expected: FAIL.

- [ ] **Step 3: Implement**
  Add `alter table brand add column if not exists niche text not null default ''` and `... output_lang text not null default 'ID'` to the boot migrations and the base schema. Extend zod validation in `saveSettings`. Form fields `Niche channel` (text) and `Bahasa output slide` (`Indonesia` | `Inggris`).

- [ ] **Step 4: Run `npx vitest run tests/brain-settings.test.ts`**
  Expected: PASS.

- [ ] **Step 5: Commit** `feat: brand niche and output language`

### Task 5: Perspective scoring

**Files:**
- Modify: `src/domain/score.ts`, `src/agents/analyst.ts`, `src/agents/prompts.ts` (`analystSystem`), `src/llm/provider.ts` (`demoScorePayload`, `SCORE_RESPONSE_SCHEMA`), `src/jobs/handlers.ts` (`scoreOneTopic` prompt input), `src/db/seed.ts` (Brain doc 02)
- Test: `tests/domain.test.ts`, `tests/analyst.test.ts`, `tests/regenerate-demo.test.ts` (update fixtures)

**Interfaces:**
- Produces: `AspectScores = { tesis; sudut; relevansi; kutipan; orisinalitas }`, each integer 0–20, total 0–100. `analystSystem(brain: string, options?: { niche?: string }): string`.

- [ ] **Step 1: Update tests to the new keys and write the failing ones**
  `totalScore` sums the five new keys and still throws `"tesis must be an integer 0-20"` for 21. `scoreTopic` rejects a payload with the old keys. `analystSystem("brain", { niche: "keuangan pribadi" })` contains `keuangan pribadi` and each of the five key names, and does not contain `shareability`. The demo LLM score payload parses with `scoreTopic`.

- [ ] **Step 2: Run `npx vitest run tests/domain.test.ts tests/analyst.test.ts tests/regenerate-demo.test.ts`**
  Expected: FAIL.

- [ ] **Step 3: Implement**
  Rename the keys everywhere they appear (score, zod schema, Gemini schema, demo payload). Rewrite `analystSystem` to say: score an essay or opinion piece; `tesis` = one-sentence thesis is clear; `sudut` = counterintuitive or distinctive angle; `relevansi` = fits the channel niche; `kutipan` = quotable lines that fit slides; `orisinalitas` = not generic information found everywhere. In `scoreOneTopic` pass the niche loaded from `brand` and add an `Penulis:` line to the user message when `author` is set. Rewrite Brain doc 02 to the same rubric. Existing databases keep old Brain text; v2 starts fresh so no migration.

- [ ] **Step 4: Run the full suite `npx vitest run`**
  Expected: PASS.

- [ ] **Step 5: Commit** `feat: perspective scoring rubric`

### Task 6: Summarize-only copywriter

**Files:**
- Create: `src/agents/verbatim.ts`
- Modify: `src/agents/prompts.ts` (`copySystem`), `src/jobs/handlers.ts` (`runCopywriter` user message and validation, lines near 580-800), `src/llm/provider.ts` (`demoCopyPayload`)
- Test: `tests/copywriter.test.ts` (extend), new `tests/verbatim.test.ts`

**Interfaces:**
- Produces:
  - `function longestSharedRun(source: string, copy: string): number` (longest run of consecutive words shared, case and punctuation insensitive)
  - `const VERBATIM_MAX_WORDS = 10`
  - `copySystem(brain, options?: { slideCount?; handle?; outputLang?: "ID" | "EN" })`

- [ ] **Step 1: Write the failing tests**
  - `longestSharedRun("a b c d e f", "x b c d e y")` is `4`; ignores case and punctuation; returns 0 for disjoint text.
  - `copySystem` with `outputLang: "EN"` says to write slides and caption in English, with `"ID"` in bahasa Indonesia, and both say to summarize in own words, credit the author, and never reproduce passages.
  - Review Focus 4: `runCopywriter` with a `ScriptedLlm` whose copy body repeats 11 consecutive words of the topic excerpt creates no draft and handles the failure the same way an invalid script is handled today (follow the existing `naskah tidak valid` path in `runCopywriter`); a copy with a 9-word shared run is accepted.
  - The copy user message includes `Penulis: <author>` and `Bahasa sumber: EN` when the source is EN and `outputLang` is ID, plus an instruction line to translate.

- [ ] **Step 2: Run `npx vitest run tests/verbatim.test.ts tests/copywriter.test.ts`**
  Expected: FAIL.

- [ ] **Step 3: Implement**
  Replace "Jangan mengarang fakta … hanya dari cuplikan" style rules with summarize-in-own-words rules, keep the existing length limits. Add the verbatim check across every slide body, headline and caption against `topic.excerpt + topic.summary`. Caption must name the author when known and the source name.

- [ ] **Step 4: Run the full suite `npx vitest run`**
  Expected: PASS.

- [ ] **Step 5: Commit** `feat: summarize-only copywriter with verbatim guard`

### Task 7: Image provider and cover prompt

**Files:**
- Create: `src/image/provider.ts`, `src/image/cover-prompt.ts`
- Modify: `.env.example`
- Test: `tests/image.test.ts`

**Interfaces:**
- Produces:
  - `type CoverRequest = { headline: string; kicker: string; niche: string; accent: string }`
  - `type CoverResult = { bytes: Uint8Array; contentType: "image/png" | "image/jpeg"; costUsd: number; model: string }`
  - `interface ImageProvider { cover(req: CoverRequest): Promise<CoverResult> }`
  - `class DemoImageProvider implements ImageProvider` (sharp-generated 1080×1350 solid-accent PNG, `costUsd: 0`, `model: "demo"`)
  - `class ScriptedImageProvider implements ImageProvider` (queue of results or errors, for tests)
  - `class CloudflareImageProvider implements ImageProvider` constructed with `(opts: { accountId: string; apiToken: string; usdPerImage?: number; fetchImpl?: typeof fetch })`; `model` is `"@cf/black-forest-labs/flux-1-schnell"`
  - `function createImageProvider(env?): ImageProvider` (`IMAGE_PROVIDER` unset or `demo` returns Demo; `cloudflare` returns Cloudflare and throws `"CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required"` when either is missing; any other value throws `"unknown IMAGE_PROVIDER"`)
  - `function coverPrompt(req: CoverRequest): string` (at most 2000 characters, the model's prompt limit is 2048)

- [ ] **Step 1: Write the failing tests**
  `DemoImageProvider.cover` returns a PNG with sharp metadata 1080×1350. `coverPrompt` contains the headline, the niche, and the exact phrases `no text`, `no logos`, `no real people`, and is at most 2000 characters even for a 500-character headline. `createImageProvider({})` returns a Demo; `createImageProvider({ IMAGE_PROVIDER: "x" })` throws; `cloudflare` with a missing token throws.
  - `CloudflareImageProvider.cover` with a stub `fetchImpl`: asserts one POST to `https://api.cloudflare.com/client/v4/accounts/<accountId>/ai/run/@cf/black-forest-labs/flux-1-schnell` with `Authorization: Bearer <token>`, a JSON body containing `prompt` and `steps: 4`, and maps a response `{ "result": { "image": "<base64 jpeg>" }, "success": true }` to bytes with `contentType: "image/jpeg"` (detect JPEG or PNG from the decoded bytes with `sharp(...).metadata()`, do not trust a header) and `costUsd` equal to `usdPerImage`.
  - Failure cases: `success: false` with an `errors` array throws with the first error message; a non-2xx status throws with the status code; an image that is neither PNG nor JPEG throws; none of the thrown messages contain the token. A request that never resolves is aborted after 60 s (use fake timers).

- [ ] **Step 2: Run `npx vitest run tests/image.test.ts`**
  Expected: FAIL.

- [ ] **Step 3: Implement** the files above. The Cloudflare REST path, request fields (`prompt`, `steps`) and response shape (`result.image` as base64, `success`, `errors`) are from memory: check them, plus the supported output size and the `steps` maximum, against the Cloudflare Workers AI docs for the model before writing the mapping, and make the stub test assert what you verified. The model may return a square image: do not resize it here, the template's cover-fit and focal slider already crop to 1080×1350. Add `IMAGE_PROVIDER=demo`, `CLOUDFLARE_ACCOUNT_ID=`, `CLOUDFLARE_API_TOKEN=`, `CLOUDFLARE_IMAGE_USD_PER_IMAGE=`, `CRAWLER_PROVIDER=fake`, `TAVILY_API_KEY=` and `MAX_AI_COVERS_PER_DAY=` to `.env.example`.

- [ ] **Step 4: Run `npx vitest run tests/image.test.ts`**
  Expected: PASS.

- [ ] **Step 5: Commit** `feat: image provider adapter and cover prompt`

### Task 8: AI cover job, gating and disclosure

**Files:**
- Create: `src/jobs/cover-quota.ts`
- Modify: `src/db/sql.ts`, `src/db/boot.ts`, `src/jobs/runner.ts` (`JobName`, `handlers` record), `src/jobs/handlers.ts` (new `runCoverJob`, `runDesigner` cover source, publisher caption near line 1178, `jobHandlers`), `src/studio/drafts.ts` (`approveDraftInTx`, `scheduleDraftInTx`, `postDraftNow`, `loadDraftRow`), `src/render/html.ts` and `src/render/berita-pro.ts` (badge), `app/(studio)/review/[id]/editor-panel.tsx` (status line)
- Test: `tests/render-quota.test.ts` (extend), new `tests/cover.test.ts`

**Interfaces:**
- Consumes: `ImageProvider`, `createImageProvider`, `coverPrompt` from Task 7; `quotaDay` from `render-quota.ts`.
- Produces:
  - Columns `drafts.cover_image bytea`, `drafts.cover_type text` (`image/png` or `image/jpeg`), `drafts.cover_ai boolean not null default false`, `drafts.cover_pending boolean not null default false`; table `cover_quota (day date primary key, used integer not null default 0)`.
  - `maxAiCoversPerDay(env?): number`, `reserveAiCover(sql, now, cap): Promise<boolean>` in `src/jobs/cover-quota.ts` (same semantics as `reserveAutoRender`).
  - `JobName` gains `"designer.cover"`; `type CoverCtx = JobCtx & { imageProvider?: ImageProvider }`; `runCoverJob(ctx: CoverCtx): Promise<void>` with payload `{ draftId: string }`.
  - `RenderSlideInput.aiCover?: boolean`.

- [ ] **Step 1: Write the failing tests in `tests/cover.test.ts`**
  - Approving a `needs_review` draft sets `cover_pending = true` and enqueues one `designer.cover` job for it; approving again changes nothing and enqueues no second job.
  - `runCoverJob` with `DemoImageProvider` stores `cover_image`, sets `cover_ai = true`, `cover_pending = false`, records `llm_spend` with agent `designer`, and enqueues a manual `designer.render` for the draft.
  - Review Focus 5: with `ScriptedImageProvider` throwing, `cover_pending` ends `false`, `cover_ai` stays `false`, an activity row says the geometric cover is used, and a manual `designer.render` is still enqueued. With `MAX_AI_COVERS_PER_DAY=0` the provider is never called and the same fallback applies.
  - `scheduleDraft` and `postDraftNow` on a draft with `cover_pending = true` throw a message containing `Cover AI sedang dibuat`; after the job finishes they succeed.
  - `reserveAiCover` hands out exactly `cap` slots per WIB day (mirror the existing render-quota test).
  - Rendering slide 0 of a draft with `cover_ai = true` produces HTML containing `Ilustrasi AI` for every template in `SLIDE_TEMPLATES`; slide index 1 and a draft with `cover_ai = false` never contain it.
  - The publisher caption for a `cover_ai` draft ends with the line `Cover: ilustrasi AI.`

- [ ] **Step 2: Run `npx vitest run tests/cover.test.ts tests/render-quota.test.ts`**
  Expected: FAIL.

- [ ] **Step 3: Implement**
  - Schema and boot migrations for the columns and table.
  - `approveDraftInTx`: after the status update, if the draft has no `cover_ai` cover and no unfinished `designer.cover` job, set `cover_pending = true` and `enqueue(tx, { name: "designer.cover", payload: { draftId: id }, runAt: now, manual: false })`. Not gated by work hours (add nothing to `WORK_HOUR_GATED`).
  - `runCoverJob`: reserve a slot (fall back when refused), call `imageProvider.cover(...)` with niche and accent from `brand`, store bytes and `cover_type`, record spend, clear `cover_pending` in a `finally`-safe path on every outcome, then enqueue `designer.render` with `manual: true`.
  - `runDesigner`: for slide index 0 use `data:<cover_type>;base64,<cover_image>` (it must pass `safePhotoDataUrl`, which accepts png, jpeg and webp) as the cover photo when `cover_image` is set and no operator-uploaded `photoDataUrl` exists (operator upload wins). Pass `aiCover` to the renderer when the cover came from `cover_image`.
  - Add `blockIfCoverPending(row.cover_pending)` beside every existing `blockIfDirty` call for scheduling and posting.
  - Badge text `Ilustrasi AI`, small, bottom corner of slide 0, in the common wrapper and the berita_pro template.
  - Editor panel shows `Cover AI sedang dibuat…` while `cover_pending`.

- [ ] **Step 4: Run the full suite `npx vitest run`**
  Expected: PASS.

- [ ] **Step 5: Commit** `feat: AI cover job after approval with gate and disclosure`

### Task 9: Rename newsroom copy to perspective channel

**Files:**
- Modify: `src/db/seed.ts` (Brain docs 00, 01, 03, 05), `README.md`, `src/marketing/content.ts`, `app/(marketing)/page.tsx`, `components/studio/shell.tsx`, `.env.example`
- Test: `tests/marketing.test.ts`, `tests/ui-contrast.test.ts` (must stay green)

**Interfaces:**
- Produces: no new code interfaces. Copy only.

- [ ] **Step 1: Write the failing test**
  In `tests/marketing.test.ts` assert the marketing content no longer contains the strings `news photo`, `Newsroom` or `berita viral`, and mentions `perspektif`. Assert the seeded Brain docs do not contain `berita` in docs 00 and 01 and that doc 03 tells the caption to credit the author.

- [ ] **Step 2: Run `npx vitest run tests/marketing.test.ts`**
  Expected: FAIL.

- [ ] **Step 3: Implement** the copy changes. Update README sections "No news photos" to "No copied photos" and add crawler and image env vars. Do not change prices, calculator numbers or contact handling.

- [ ] **Step 4: Run the full suite `npx vitest run`**
  Expected: PASS.

- [ ] **Step 5: Commit** `docs: reposition copy as perspective channel`

---

## Deferred until the open items are decided

- A live smoke test of `TavilyCrawler` against one real feed-less source and of `CloudflareImageProvider` against the real API. Both need keys, and this cloud session's network allowlist must include `api.tavily.com` and `api.cloudflare.com` before they can run here.
- Setting `CLOUDFLARE_IMAGE_USD_PER_IMAGE` from Cloudflare's current pricing, and tuning `CRAWL_MAX_ARTICLES_PER_SCAN` once Tavily credit use per scan is known.
- A/B testing of AI versus geometric covers using Analitik data.
- Final wording of the AI label if it must differ from `Ilustrasi AI`.

## Self-Review notes

- **Vendors:** Tavily is Task 1, Cloudflare FLUX.1 Schnell is Task 7. Both have fakes, so Tasks 2 and 8 and every test run without keys.
- **Spec coverage:** crawler and sources (Tasks 1-2), no copied photos (3), niche and language (4), perspective scoring (5), summarize-only (6), AI cover after approval with cap, label and fallback (7-8), repositioning (9). Cost tuning, A/B and source discovery are explicitly out of scope per the spec.
- **Types:** `Crawler`, `CrawledArticle`, `canonicalUrl` (Task 1) are the names used in Task 2. `ImageProvider`, `CoverRequest`, `coverPrompt` (Task 7) are the names used in Task 8. `AspectScores` keys (Task 5) are used in Task 5 only.
- **Order:** Tasks 1-2 and 7 can run in parallel with 3-6; Task 8 needs 7; Task 9 goes last.
