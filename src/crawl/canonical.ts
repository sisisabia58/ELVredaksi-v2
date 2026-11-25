const TRACKING_PARAMS = new Set(["ref", "source", "fbclid", "gclid"]);

export function canonicalUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.host = parsed.host.toLowerCase();
  let out = parsed.toString();
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    out = parsed.toString();
  }
  return out;
}
