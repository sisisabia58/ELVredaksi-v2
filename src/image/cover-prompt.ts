export type CoverRequest = { headline: string; kicker: string; niche: string; accent: string };

const HEADLINE_MAX = 300;
const NICHE_MAX = 120;

export function coverPrompt(req: CoverRequest): string {
  const headline = req.headline.trim().slice(0, HEADLINE_MAX);
  const niche = req.niche.trim().slice(0, NICHE_MAX);
  return [
    `Abstract editorial illustration for an Instagram carousel cover about: ${headline}.`,
    niche ? `Channel niche: ${niche}.` : "",
    `Dominant accent color ${req.accent}.`,
    "Style: flat shapes, modern, high contrast, calm composition with empty space in the upper third for a headline overlay.",
    "Constraints: no text, no letters, no numbers, no logos, no real people, no faces, no watermarks.",
  ]
    .filter(Boolean)
    .join(" ");
}
