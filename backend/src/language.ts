const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  it: "Italian",
  ja: "Japanese",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
  ru: "Russian"
};

const ENGLISH_HINTS = /\b(the|and|hello|please|thanks|thank you|what|where|when|how|why|yes|no)\b/giu;
const DUTCH_HINTS = /\b(het|een|van|niet|goedemorgen|hallo|alsjeblieft|dank je|waarom)\b/giu;
const FRENCH_HINTS = /\b(le|la|les|bonjour|merci|s'il|pourquoi|comment|avec|vous|être)\b/giu;
const GERMAN_HINTS = /\b(der|die|das|und|hallo|danke|bitte|warum|wie|nicht|ist)\b/giu;
const ITALIAN_HINTS = /\b(il|lo|la|ciao|grazie|perché|come|con|sono|buongiorno)\b/giu;
const PORTUGUESE_HINTS = /\b(olá|obrigado|obrigada|como|você|voce|não|nao|por favor|tudo bem)\b/giu;
const SPANISH_HINTS = /\b(hola|gracias|por favor|cómo|como|qué|que|usted|ustedes|dónde|donde)\b/giu;
const POLISH_HINTS = /\b(cześć|czesc|dzień dobry|dzien dobry|dziękuję|dziekuje|proszę|prosze|jak|czy)\b/giu;

export function normalizeLanguageTag(tag?: string): string | undefined {
  if (!tag) {
    return undefined;
  }

  const normalized = tag.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) {
    return undefined;
  }

  const [base] = normalized.split("-");
  return base || undefined;
}

export function getLanguageDisplayName(language?: string): string {
  const normalized = normalizeLanguageTag(language);
  if (!normalized) {
    return "Unknown";
  }

  return LANGUAGE_DISPLAY_NAMES[normalized] ?? normalized.toUpperCase();
}

export function inferLanguageFromText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(trimmed)) {
    return "ja";
  }

  if (/[\u0900-\u097f]/u.test(trimmed)) {
    return "hi";
  }

  if (/[\u0400-\u04ff]/u.test(trimmed)) {
    return "ru";
  }

  const normalized = trimmed.toLowerCase();
  const scores = new Map<string, number>();

  addScore(scores, "pl", countMatches(normalized, /[ąćęłńóśźż]/giu) * 3);
  addScore(scores, "es", countMatches(normalized, /[¡¿ñáéíóúü]/giu) * 3);
  addScore(scores, "pt", countMatches(normalized, /[ãõçáâàéêíóôõú]/giu) * 3);
  addScore(scores, "fr", countMatches(normalized, /[àâæçèéêëîïôœùûüÿ]/giu) * 3);
  addScore(scores, "de", countMatches(normalized, /[äöüß]/giu) * 3);
  addScore(scores, "it", countMatches(normalized, /[àèéìíîòóù]/giu) * 2);

  addScore(scores, "en", countMatches(normalized, ENGLISH_HINTS) * 2);
  addScore(scores, "nl", countMatches(normalized, DUTCH_HINTS) * 2);
  addScore(scores, "fr", countMatches(normalized, FRENCH_HINTS) * 2);
  addScore(scores, "de", countMatches(normalized, GERMAN_HINTS) * 2);
  addScore(scores, "it", countMatches(normalized, ITALIAN_HINTS) * 2);
  addScore(scores, "pt", countMatches(normalized, PORTUGUESE_HINTS) * 2);
  addScore(scores, "es", countMatches(normalized, SPANISH_HINTS) * 2);
  addScore(scores, "pl", countMatches(normalized, POLISH_HINTS) * 2);

  const ranked = [...scores.entries()]
    .filter((entry) => entry[1] > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  if (ranked.length > 0) {
    return ranked[0]?.[0];
  }

  if (/[a-z]/iu.test(normalized)) {
    return "en";
  }

  return undefined;
}

function addScore(scores: Map<string, number>, language: string, increment: number): void {
  if (increment <= 0) {
    return;
  }

  scores.set(language, (scores.get(language) ?? 0) + increment);
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  const matches = text.match(pattern);
  return matches?.length ?? 0;
}
