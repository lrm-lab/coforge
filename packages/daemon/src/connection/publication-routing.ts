/** Decodes one publication kind; a failed decode or scope acceptance lets the caller try the next. */
export function routePublication<Value>(
  data: Uint8Array,
  decode: (data: Uint8Array) => Value,
  accept: (value: Value) => boolean,
): boolean {
  try {
    return accept(decode(data));
  } catch {
    return false;
  }
}
