import sharp from "sharp";
import { coverPrompt, type CoverRequest } from "./cover-prompt";

export type { CoverRequest } from "./cover-prompt";

export type CoverResult = {
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg";
  costUsd: number;
  model: string;
};

export interface ImageProvider {
  cover(req: CoverRequest): Promise<CoverResult>;
}

export class DemoImageProvider implements ImageProvider {
  async cover(req: CoverRequest): Promise<CoverResult> {
    const background = /^#[0-9a-fA-F]{6}$/.test(req.accent) ? req.accent : "#4E708C";
    const png = await sharp({ create: { width: 1080, height: 1350, channels: 3, background } }).png().toBuffer();
    return { bytes: new Uint8Array(png), contentType: "image/png", costUsd: 0, model: "demo" };
  }
}

export class ScriptedImageProvider implements ImageProvider {
  private readonly queue: (CoverResult | Error)[];
  constructor(results: (CoverResult | Error)[]) {
    this.queue = [...results];
  }
  async cover(_req: CoverRequest): Promise<CoverResult> {
    const next = this.queue.shift();
    if (!next) throw new Error("ScriptedImageProvider exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
}

export const CLOUDFLARE_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const CLOUDFLARE_TIMEOUT_MS = 60_000;
const CLOUDFLARE_STEPS = 4;

let warnedNoCost = false;

export class CloudflareImageProvider implements ImageProvider {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly usdPerImage: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { accountId: string; apiToken: string; usdPerImage?: number; fetchImpl?: typeof fetch }) {
    this.accountId = opts.accountId;
    this.apiToken = opts.apiToken;
    this.usdPerImage = opts.usdPerImage ?? 0;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private scrub(text: string): string {
    return text.split(this.apiToken).join("***");
  }

  async cover(req: CoverRequest): Promise<CoverResult> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOUDFLARE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: coverPrompt(req), steps: CLOUDFLARE_STEPS }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(this.scrub(`Cloudflare gagal: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`Cloudflare gagal (${response.status})`);
    }
    const body = (await response.json()) as {
      success?: boolean;
      errors?: { message?: string }[];
      result?: { image?: string };
    };
    if (body.success === false) {
      throw new Error(this.scrub(`Cloudflare menolak: ${body.errors?.[0]?.message ?? "tanpa pesan"}`));
    }
    const base64 = body.result?.image;
    if (!base64) {
      throw new Error("Cloudflare tidak mengembalikan gambar");
    }
    const bytes = Buffer.from(base64, "base64");
    let format: string | undefined;
    try {
      format = (await sharp(bytes).metadata()).format;
    } catch {
      format = undefined;
    }
    if (format !== "png" && format !== "jpeg") {
      throw new Error("Cloudflare mengembalikan gambar yang tidak didukung");
    }
    return {
      bytes: new Uint8Array(bytes),
      contentType: format === "png" ? "image/png" : "image/jpeg",
      costUsd: this.usdPerImage,
      model: CLOUDFLARE_IMAGE_MODEL,
    };
  }
}

export function createImageProvider(env: Record<string, string | undefined> = process.env): ImageProvider {
  const provider = env.IMAGE_PROVIDER?.trim() || "demo";
  if (provider === "demo") return new DemoImageProvider();
  if (provider === "cloudflare") {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
    if (!accountId || !apiToken) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
    }
    const rawCost = env.CLOUDFLARE_IMAGE_USD_PER_IMAGE?.trim();
    const cost = rawCost ? Number(rawCost) : NaN;
    if (!Number.isFinite(cost) && !warnedNoCost) {
      warnedNoCost = true;
      console.warn("CLOUDFLARE_IMAGE_USD_PER_IMAGE is unset or invalid; recording $0 per cover");
    }
    return new CloudflareImageProvider({ accountId, apiToken, usdPerImage: Number.isFinite(cost) ? cost : 0 });
  }
  throw new Error("unknown IMAGE_PROVIDER");
}
