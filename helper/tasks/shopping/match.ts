const STOPWORDS = new Set(["a", "an", "the", "of", "some", "more", "any", "few", "pack", "please", "our", "we", "need", "out", "and"]);

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("oes")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(singular);
}

/** AUT-3: a product is an exact match when its name contains every significant word of the request. */
export function isExactMatch(request: string, productName: string): boolean {
  const wanted = significantWords(request);
  if (wanted.length === 0) return false;
  const have = new Set(significantWords(productName));
  return wanted.every((w) => have.has(w));
}

export function normaliseRequest(request: string): string {
  return significantWords(request).join(" ");
}
