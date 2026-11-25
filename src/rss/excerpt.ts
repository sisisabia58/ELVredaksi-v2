export function imageUrlFromHtml(html: string, pageUrl: string): string | null {
  const patterns = [
    /<meta\b[^>]*property\s*=\s*["']og:image(?::secure_url)?["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image(?::secure_url)?["'][^>]*>/i,
    /<meta\b[^>]*name\s*=\s*["']twitter:image(?::src)?["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']twitter:image(?::src)?["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const raw = html.match(pattern)?.[1]?.trim();
    if (!raw) {
      continue;
    }
    try {
      const url = new URL(raw, pageUrl);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.href;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function excerptFromHtml(html: string): string {
  let text = html;
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, 1200);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** The page's own title: og:title first, then <title>, with a trailing " | Site" name removed. */
export function titleFromHtml(html: string): string | null {
  const og =
    html.match(/<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i)?.[1] ??
    html.match(/<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["'][^>]*>/i)?.[1];
  const raw = og ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!raw) {
    return null;
  }
  const cleaned = decodeEntities(raw).replace(/\s+/g, " ").trim().replace(/\s+\|\s+[^|]+$/, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : null;
}
