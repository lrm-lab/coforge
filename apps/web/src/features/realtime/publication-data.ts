import { utf8Decoder } from "@lrm/coforge-sdk/internal";

/**
 * A Centrifugo publication's data as JSON: the client hands over raw bytes (`Uint8Array`) or data
 * it already parsed. Bytes that are not JSON throw, for a decoder that refuses them.
 */
export function publicationData(value: unknown): unknown {
  return value instanceof Uint8Array ? (JSON.parse(utf8Decoder.decode(value)) as unknown) : value;
}

/** `publicationData`, or undefined for bytes that are not JSON: for a decoder that skips every
 * publication on its channel that is not its own. */
export function publicationDataOrUndefined(value: unknown): unknown {
  try {
    return publicationData(value);
  } catch {
    return undefined;
  }
}
