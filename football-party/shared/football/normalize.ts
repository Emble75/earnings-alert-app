const SPECIAL: Record<string, string> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
};

/** Accent-insensitive, case-insensitive, punctuation-insensitive form used for all matching. */
export function normalizeText(input: string): string {
  const lower = input.normalize('NFKD').toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (/\p{M}/u.test(ch)) continue; // combining accent
    out += SPECIAL[ch] ?? ch;
  }
  return out
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Strips control chars, bidi overrides and zero-width characters; collapses whitespace. */
export function cleanDisplayText(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
