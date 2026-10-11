import { extractUrls } from "@/lib/url/extractor";
import type { ExtractedUrl } from "@/lib/url/types";
import { HOMOGLYPHS, HOMOGLYPH_RE } from "@/lib/text/homoglyphs";

/**
 * Preprocessor: Unicode normalisation, invisible-character stripping, homoglyph folding and
 * URL extraction. The original text is kept for the LLM (it may need the exact wording); all
 * deterministic matching runs on the normalised form.
 */

const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤﻿­]/g;


export interface PreprocessedText {
  original: string;
  /** NFKC + invisible chars removed + homoglyphs folded + whitespace collapsed. */
  normalized: string;
  /** Lower-cased `normalized`, used by rules. */
  lower: string;
  urls: ExtractedUrl[];
  obfuscation: { zeroWidthChars: number; homoglyphs: number };
}

export function preprocess(text: string): PreprocessedText {
  const nfkc = text.normalize("NFKC");
  const zeroWidthChars = nfkc.match(ZERO_WIDTH)?.length ?? 0;
  const stripped = nfkc.replace(ZERO_WIDTH, "");

  // Only fold homoglyphs inside words that also contain Latin letters (mixed-script words);
  // genuine Cyrillic/Greek text is left alone.
  let homoglyphs = 0;
  const folded = stripped.replace(/[\p{L}\p{N}]+/gu, (word) => {
    if (!/[A-Za-z]/.test(word) || !HOMOGLYPH_RE.test(word)) return word;
    HOMOGLYPH_RE.lastIndex = 0;
    return word.replace(HOMOGLYPH_RE, (c) => {
      homoglyphs++;
      return HOMOGLYPHS[c] ?? c;
    });
  });
  HOMOGLYPH_RE.lastIndex = 0;

  const normalized = folded.replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return {
    original: text,
    normalized,
    lower: normalized.toLowerCase().replace(/[\u2018\u2019`]/g, "'"),
    urls: extractUrls(normalized),
    obfuscation: { zeroWidthChars, homoglyphs },
  };
}
