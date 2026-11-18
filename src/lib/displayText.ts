/**
 * Client-side mirror of authsu's display-text rules for agent names and invitation labels
 * (internal/input: displayText). The server is the authority; this only saves a round trip.
 *
 * Text is refused if it has a control (Cc) or format (Cf) character (bidi overrides,
 * zero-width space, BOM, soft hyphen, tag characters) or is not in Unicode NFC. The two joiners,
 * U+200C and U+200D, are allowed, because emoji sequences and Persian, Indic and Sinhala text
 * cannot be written without them. Account names are stricter: see `isValidName`.
 */

const HIDDEN = /[\p{Cc}\p{Cf}]/u;
const JOINERS = /[\u200c\u200d]/g;

/** Whether `text` holds a character the server refuses in display text. */
export function hasDisallowedChars(text: string): boolean {
  return HIDDEN.test(text.replace(JOINERS, ""));
}

/** Whether the text shows as nothing: empty, or only whitespace and joiners. */
export const isBlank = (text: string) => text.replace(JOINERS, "").trim() === "";

/** The text the server will see: NFC-normalized and trimmed. */
export const normalizeText = (text: string) => text.normalize("NFC").trim();

/** Display text the server accepts, apart from its length bound. */
export const isShowable = (text: string) => {
  const normalized = normalizeText(text);
  return !isBlank(normalized) && !hasDisallowedChars(normalized);
};
