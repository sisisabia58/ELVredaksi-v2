import type { Sql } from "../db/client";
import { TIME_ZONE } from "../domain/constants";

export const DEFAULT_MAX_IMAGE_GENERATIONS_PER_DAY = 10;

/**
 * Daily cap on automatic slide renders (designer.render jobs that no person queued).
 * MAX_IMAGE_GENERATIONS_PER_DAY: unset or invalid = 10, 0 = automatic renders off.
 * Manual renders (edits, re-renders, rewrites a person asked for) are never capped.
 */
export function maxAutoRendersPerDay(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MAX_IMAGE_GENERATIONS_PER_DAY?.trim();
  if (!raw) {
    return DEFAULT_MAX_IMAGE_GENERATIONS_PER_DAY;
  }
  if (!/^\d+$/.test(raw)) {
    console.warn(
      `MAX_IMAGE_GENERATIONS_PER_DAY="${raw}" is not a whole number; using ${DEFAULT_MAX_IMAGE_GENERATIONS_PER_DAY}`,
    );
    return DEFAULT_MAX_IMAGE_GENERATIONS_PER_DAY;
  }
  return Number(raw);
}

/** Calendar day in WIB (Asia/Jakarta) as YYYY-MM-DD. The cap resets at WIB midnight. */
export function quotaDay(now: Date, timeZone = TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export async function autoRendersUsed(sql: Sql, now: Date): Promise<number> {
  const rows = await sql.rows<{ used: number }>(`select used from render_quota where day = $1::date`, [
    quotaDay(now),
  ]);
  return Number(rows[0]?.used ?? 0);
}

/**
 * Atomically takes one automatic render from today's allowance.
 * Returns false when the cap is reached (or the cap is 0).
 */
export async function reserveAutoRender(sql: Sql, now: Date, cap: number): Promise<boolean> {
  if (cap <= 0) {
    return false;
  }
  const rows = await sql.rows<{ used: number }>(
    `insert into render_quota (day, used) values ($1::date, 1)
     on conflict (day) do update set used = render_quota.used + 1
     where render_quota.used < $2
     returning used`,
    [quotaDay(now), cap],
  );
  return rows.length > 0;
}
