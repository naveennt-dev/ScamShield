/** Cyrillic/Greek letters commonly used to imitate Latin ones (confusables subset). */
export const HOMOGLYPHS: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ӏ: "l",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X",
  α: "a", ο: "o", ν: "v", ρ: "p", τ: "t", υ: "u", ι: "i", κ: "k",
};

export const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "g");

export function foldHomoglyphs(s: string): string {
  return s.replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c] ?? c);
}
