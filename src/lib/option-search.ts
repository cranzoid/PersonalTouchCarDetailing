/**
 * Matching and ordering for the admin picker lists.
 *
 * The customer list has outgrown a plain `<select>`: scrolling a few hundred
 * names to raise one invoice is slower than typing three letters. The rules
 * live here rather than in the component so the behaviour staff actually rely
 * on — "type part of a surname and part of a phone number, in either order,
 * and still land on the right customer" — is covered by the test suite, which
 * has no DOM.
 */

/** Case- and accent-insensitive, and it reads 12 before 100. */
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Lowercased, accents stripped, punctuation collapsed to single spaces. */
export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The query split into the words that all have to match. */
export function searchTokens(query: string): string[] {
  return normalizeForSearch(query).split(" ").filter(Boolean);
}

/**
 * True when every token appears somewhere in `text`, in any order.
 *
 * Matching runs twice: once over the spaced form, once with the spaces removed.
 * The second pass is what makes "9055551234" find "(905) 555-1234" and
 * "ABCD123" find a plate entered as "ABCD 123" — both forms are in live data,
 * and staff type whichever one is in front of them. Same spirit as the phone
 * search on the customers list (src/lib/phone.ts), without needing a second
 * stored column.
 */
export function matchesSearch(text: string, query: string): boolean {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return true;
  const spaced = normalizeForSearch(text);
  const squashed = spaced.replace(/ /g, "");
  return tokens.every((token) => spaced.includes(token) || squashed.includes(token));
}

/**
 * Orders by what is on screen rather than by the column a label was built from.
 *
 * A business customer is listed as "Company — First Last", so ordering the
 * query by `first_name` scattered every fleet account through the list at a
 * position nothing on screen explained. Sorting the finished label is the only
 * order a human reading the list can predict.
 */
export function compareLabels(a: string, b: string): number {
  return collator.compare(a, b);
}
