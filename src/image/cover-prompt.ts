export type CoverRequest = { headline: string; kicker: string; niche: string; accent: string };

const NICHE_MAX = 120;

/**
 * The headline is deliberately NOT in the prompt: FLUX draws any words it is given, and
 * it garbles them (seen in a live test). The slide template writes the headline on top.
 */
export function coverPrompt(req: CoverRequest): string {
  const niche = req.niche.trim().slice(0, NICHE_MAX);
  return [
    "Abstract editorial illustration for a social media cover.",
    "Flat geometric shapes, modern, high contrast, calm composition, empty space in the upper third.",
    `Dominant color ${req.accent}.`,
    niche ? `Mood: ${niche}.` : "",
    "A purely visual image with no text, no letters, no numbers, no logos, no real people, no faces, no watermarks.",
  ]
    .filter(Boolean)
    .join(" ");
}
