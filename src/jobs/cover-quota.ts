import type { Sql } from "../db/client";
import { quotaDay } from "./render-quota";

export const DEFAULT_MAX_AI_COVERS_PER_DAY = 10;

/** MAX_AI_COVERS_PER_DAY: unset or invalid = 10, 0 = AI covers off. Resets at WIB midnight. */
export function maxAiCoversPerDay(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MAX_AI_COVERS_PER_DAY?.trim();
  if (!raw) {
    return DEFAULT_MAX_AI_COVERS_PER_DAY;
  }
  if (!/^\d+$/.test(raw)) {
    console.warn(`MAX_AI_COVERS_PER_DAY="${raw}" is not a whole number; using ${DEFAULT_MAX_AI_COVERS_PER_DAY}`);
    return DEFAULT_MAX_AI_COVERS_PER_DAY;
  }
  return Number(raw);
}

/** Atomically takes one AI cover from today's allowance. False when the cap is reached or is 0. */
export async function reserveAiCover(sql: Sql, now: Date, cap: number): Promise<boolean> {
  if (cap <= 0) {
    return false;
  }
  const rows = await sql.rows<{ used: number }>(
    `insert into cover_quota (day, used) values ($1::date, 1)
     on conflict (day) do update set used = cover_quota.used + 1
     where cover_quota.used < $2
     returning used`,
    [quotaDay(now), cap],
  );
  return rows.length > 0;
}

/** AI covers are made only with a real image provider configured and a cap above 0. */
export function aiCoversEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const provider = env.IMAGE_PROVIDER?.trim() || "demo";
  return provider !== "demo" && maxAiCoversPerDay(env) > 0;
}
