import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coverPrompt } from "../src/image/cover-prompt";
import {
  CloudflareImageProvider,
  DemoImageProvider,
  ScriptedImageProvider,
  createImageProvider,
} from "../src/image/provider";

const req = { headline: "Kenapa tim kecil menang", kicker: "Opini", niche: "keuangan pribadi", accent: "#4E708C" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function jpegBase64(): Promise<string> {
  const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  return buf.toString("base64");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("coverPrompt", () => {
  it("never contains the headline (the model draws any words it is given) but names the niche", () => {
    const prompt = coverPrompt(req);
    expect(prompt).not.toContain("Kenapa tim kecil menang");
    expect(prompt).not.toContain("Opini");
    expect(prompt).toContain("keuangan pribadi");
    for (const phrase of ["no text", "no letters", "no logos", "no real people"]) {
      expect(prompt).toContain(phrase);
    }
  });
  it("stays under 2000 characters even for a very long niche", () => {
    expect(coverPrompt({ ...req, niche: "x".repeat(500) }).length).toBeLessThanOrEqual(2000);
  });
});

describe("DemoImageProvider and factory", () => {
  it("returns a 1080x1350 png at zero cost", async () => {
    const result = await new DemoImageProvider().cover(req);
    expect(result).toMatchObject({ contentType: "image/png", costUsd: 0, model: "demo" });
    const meta = await sharp(Buffer.from(result.bytes)).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
  });
  it("scripted provider replays results and errors", async () => {
    const scripted = new ScriptedImageProvider([new Error("boom")]);
    await expect(scripted.cover(req)).rejects.toThrow("boom");
  });
  it("picks a provider from env", () => {
    expect(createImageProvider({})).toBeInstanceOf(DemoImageProvider);
    expect(createImageProvider({ IMAGE_PROVIDER: "demo" })).toBeInstanceOf(DemoImageProvider);
    expect(() => createImageProvider({ IMAGE_PROVIDER: "x" })).toThrow("unknown IMAGE_PROVIDER");
    expect(() => createImageProvider({ IMAGE_PROVIDER: "cloudflare", CLOUDFLARE_ACCOUNT_ID: "a" })).toThrow(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required",
    );
    expect(
      createImageProvider({ IMAGE_PROVIDER: "cloudflare", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" }),
    ).toBeInstanceOf(CloudflareImageProvider);
  });
});

describe("CloudflareImageProvider", () => {
  it("posts the prompt to the flux-1-schnell endpoint and decodes the image", async () => {
    const image = await jpegBase64();
    const fetchImpl = vi.fn(async () => json({ result: { image }, success: true }));
    const provider = new CloudflareImageProvider({
      accountId: "acc123",
      apiToken: "tok-secret",
      usdPerImage: 0.0004,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.cover(req);
    expect(result.contentType).toBe("image/jpeg");
    expect(result.costUsd).toBe(0.0004);
    expect(result.model).toBe("@cf/black-forest-labs/flux-1-schnell");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/black-forest-labs/flux-1-schnell");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-secret");
    const body = JSON.parse(init.body as string);
    expect(body.steps).toBe(4);
    expect(body.prompt).toContain("keuangan pribadi");
  });

  it("fails cleanly and never leaks the token", async () => {
    const make = (impl: () => Promise<Response>) =>
      new CloudflareImageProvider({ accountId: "a", apiToken: "tok-secret", fetchImpl: impl as unknown as typeof fetch });
    const apiError = await make(async () =>
      json({ success: false, errors: [{ code: 1, message: "bad tok-secret request" }] }),
    ).cover(req).catch((e: Error) => e);
    expect((apiError as Error).message).toContain("bad");
    expect((apiError as Error).message).not.toContain("tok-secret");
    const status = await make(async () => json({}, 500)).cover(req).catch((e: Error) => e);
    expect((status as Error).message).toContain("500");
    const notImage = await make(async () =>
      json({ result: { image: Buffer.from("not an image").toString("base64") }, success: true }),
    ).cover(req).catch((e: Error) => e);
    expect(notImage).toBeInstanceOf(Error);
  });

  it("aborts a request that never answers after 60 seconds", async () => {
    vi.useFakeTimers();
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const provider = new CloudflareImageProvider({
      accountId: "a",
      apiToken: "t",
      fetchImpl: hang as unknown as typeof fetch,
    });
    const pending = provider.cover(req).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toBeInstanceOf(Error);
  });
});
