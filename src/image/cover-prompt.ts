import { z } from "zod";

export type CoverRequest = {
  headline: string;
  kicker: string;
  niche: string;
  accent: string;
  /** One concrete scene, in English, that depicts the article. Written by the language model. */
  concept?: string;
};

const NICHE_MAX = 120;
const CONCEPT_MAX = 400;
const EXCERPT_MAX = 1500;

/**
 * The headline is deliberately NOT in the image prompt: FLUX draws any words it is given and
 * garbles them (seen in a live test). The slide template writes the headline on top. What the
 * picture shows comes from `concept`, a scene derived from the article text.
 */
export function coverPrompt(req: CoverRequest): string {
  const niche = req.niche.trim().slice(0, NICHE_MAX);
  const concept = req.concept?.trim().slice(0, CONCEPT_MAX) ?? "";
  return [
    concept
      ? `Flat vector editorial illustration of this scene: ${concept}`
      : "Abstract editorial illustration for a social media cover.",
    "Simple geometric shapes, modern, high contrast, calm composition, empty space in the upper third.",
    `Dominant color ${req.accent}.`,
    !concept && niche ? `Mood: ${niche}.` : "",
    "A purely visual image with no text, no letters, no numbers, no logos, no real people, no faces, no watermarks.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function coverConceptSystem(niche: string): string {
  const topic = niche.trim() ? ` The channel niche is: ${niche.trim()}.` : "";
  return `You write one image idea for a social media cover about an article.${topic}
Describe ONE concrete scene, in English, in a single sentence of at most 35 words, that visually depicts the article's central subject. Name specific objects, the setting and an action, for example "a farmer holding rice stalks beside a half-empty grain silo".
Rules: no text, signs, labels, captions or numbers in the scene; no logos or brand names; no real or named people, use generic figures seen from behind or as silhouettes without faces; avoid abstract shapes and avoid describing feelings. If the article is about violence, death or tragedy, depict a calm symbolic object instead.
Return only JSON: {"concept": "<the sentence>"}`;
}

export function coverConceptUser(headline: string, excerpt: string): string {
  return [`Headline: ${headline.trim()}`, `Article excerpt: ${excerpt.trim().slice(0, EXCERPT_MAX)}`].join("\n");
}

const conceptSchema = z.object({ concept: z.string().trim().min(10).max(600) });

export function parseConcept(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("konsep cover tidak valid");
  }
  const result = conceptSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("konsep cover tidak valid");
  }
  return result.data.concept.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
}
