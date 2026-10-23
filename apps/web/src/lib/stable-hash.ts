/**
 * A stable 32-bit FNV-1a hash of a string: the same text gives the same number on the server and in
 * the browser, so an id can choose a picture (an Agent's mascot, a person's cartoon) with nothing
 * stored. Not for anything secret.
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}
