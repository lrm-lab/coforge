import { expect, test } from "bun:test";
import { utf8Encoder } from "@lrm/coforge-sdk/internal";

import {
  publicationData,
  publicationDataOrUndefined,
} from "#src/features/realtime/publication-data";

const bytes = (text: string) => utf8Encoder.encode(text);

test("a publication's bytes are read as JSON; data the client already parsed passes through", () => {
  expect(publicationData(bytes('{"type":"task.changed.v1","n":1}'))).toEqual({
    type: "task.changed.v1",
    n: 1,
  });
  const parsed = { type: "workspace.deleted.v1" };
  expect(publicationData(parsed)).toBe(parsed);
  expect(publicationData(null)).toBeNull();
});

test("bytes that are not JSON throw, or read as undefined for a decoder that skips them", () => {
  expect(() => publicationData(bytes("not json"))).toThrow();
  expect(publicationDataOrUndefined(bytes("not json"))).toBeUndefined();
  expect(publicationDataOrUndefined(bytes("[1,2]"))).toEqual([1, 2]);
});
