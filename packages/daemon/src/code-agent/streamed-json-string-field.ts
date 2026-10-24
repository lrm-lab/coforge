const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
/** A key longer than this is not the one wanted, and is not kept. */
const MAX_KEY_LENGTH = 64;

/** Where the reader is in the JSON text it has been given so far. */
type Position =
  | { in: "structure" }
  | { in: "string"; role: "key" | "wanted" | "other" }
  | { in: "failed" };

/**
 * Reads one string field of a top-level JSON object from text that arrives in fragments, so its
 * value is known while the object is still being written. Fragments may end anywhere, including
 * inside an escape or between the halves of a surrogate pair. Only the top level is searched: a
 * field of that name inside a nested object or array is not it.
 *
 * It never throws. Text that is not a JSON object or a field that is not a string makes the
 * reader give up (`failed`); how much text to read is the caller's to bound.
 */
export class StreamedJsonStringField {
  readonly #key: string;
  #position: Position = { in: "structure" };
  #depth = 0;
  /** The next string at depth 1 is a key, not a value. */
  #expectKey = false;
  #keyText = "";
  #keyMatched = false;
  /** The value being read, or about to be, is the wanted field's. */
  #wantedValueNext = false;
  /** Set after a backslash inside a string; the escape letter has not arrived yet. */
  #escaping = false;
  /** The hex digits of a `\u` escape read so far, once it has begun. */
  #unicodeDigits: string | undefined;
  #value = "";
  #complete = false;

  constructor(key: string) {
    this.#key = key;
  }

  /** The decoded value read so far; the whole value once `complete`. */
  get value(): string {
    return this.#value;
  }

  /** The value's closing quote has been read. */
  get complete(): boolean {
    return this.#complete;
  }

  /** The reader gave up, or the field turned out not to be a string. */
  get failed(): boolean {
    return this.#position.in === "failed";
  }

  push(fragment: string): void {
    for (const ch of fragment) {
      if (this.#complete || this.#position.in === "failed") return;
      if (this.#position.in === "string") this.#readStringCharacter(ch, this.#position.role);
      else this.#readStructureCharacter(ch);
    }
  }

  #readStructureCharacter(ch: string): void {
    if (WHITESPACE.has(ch)) return;
    if (this.#wantedValueNext && ch !== '"') return this.#fail();
    if (ch === '"') {
      const atTopLevel = this.#depth === 1;
      const role =
        atTopLevel && this.#expectKey ? "key" : this.#wantedValueNext ? "wanted" : "other";
      if (role === "key") this.#keyText = "";
      this.#wantedValueNext = false;
      this.#position = { in: "string", role };
    } else if (ch === "{" || ch === "[") {
      this.#depth++;
      this.#expectKey = this.#depth === 1 && ch === "{";
    } else if (ch === "}" || ch === "]") {
      this.#depth = Math.max(0, this.#depth - 1);
    } else if (ch === ":" && this.#depth === 1) {
      this.#expectKey = false;
      this.#wantedValueNext = this.#keyMatched;
      this.#keyMatched = false;
    } else if (ch === "," && this.#depth === 1) {
      this.#expectKey = true;
    }
  }

  #readStringCharacter(ch: string, role: "key" | "wanted" | "other"): void {
    if (this.#unicodeDigits !== undefined) {
      if (!/^[0-9a-fA-F]$/.test(ch)) return this.#fail();
      this.#unicodeDigits += ch;
      if (this.#unicodeDigits.length === 4) {
        const code = String.fromCharCode(Number.parseInt(this.#unicodeDigits, 16));
        this.#unicodeDigits = undefined;
        this.#append(role, code);
      }
      return;
    }
    if (this.#escaping) {
      this.#escaping = false;
      if (ch === "u") this.#unicodeDigits = "";
      else this.#append(role, SIMPLE_ESCAPES[ch] ?? ch);
      return;
    }
    if (ch === "\\") {
      this.#escaping = true;
    } else if (ch === '"') {
      this.#position = { in: "structure" };
      if (role === "key") this.#keyMatched = this.#keyText === this.#key;
      else if (role === "wanted") this.#complete = true;
    } else {
      this.#append(role, ch);
    }
  }

  #append(role: "key" | "wanted" | "other", text: string): void {
    if (role === "key") {
      if (this.#keyText.length <= MAX_KEY_LENGTH) this.#keyText += text;
    } else if (role === "wanted") {
      this.#value += text;
    }
  }

  #fail(): void {
    this.#position = { in: "failed" };
  }
}
