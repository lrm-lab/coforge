import { expect, test } from "bun:test";

import { searchExcerpt } from "#src/features/search/search-excerpt";

test("literal terms keep longest-first matches and leave the supplied terms unchanged", () => {
  const terms = ["[x]", "foo", "foobar"];
  Object.freeze(terms);
  expect(searchExcerpt("FOObar foo [x] end", terms)).toEqual([
    { text: "FOObar", match: true },
    { text: " ", match: false },
    { text: "foo", match: true },
    { text: " ", match: false },
    { text: "[x]", match: true },
    { text: " end", match: false },
  ]);
  expect(terms).toEqual(["[x]", "foo", "foobar"]);
});

test("adjacent matches and empty terms do not emit empty excerpt parts", () => {
  expect(searchExcerpt("FOObarfoo", ["", "foo", "foobar"])).toEqual([
    { text: "FOObar", match: true },
    { text: "foo", match: true },
  ]);
  expect(searchExcerpt("AB", [""])).toEqual([
    { text: "A", match: false },
    { text: "B", match: false },
  ]);
});

test("Unicode lowercase flags retain their distinction from regexp case matching", () => {
  expect(searchExcerpt("ς", ["σ"])).toEqual([{ text: "ς", match: false }]);
  expect(searchExcerpt("İ", ["i\u0307"])).toEqual([{ text: "İ", match: true }]);
  expect(searchExcerpt("K", ["k"])).toEqual([{ text: "K", match: true }]);
  expect(searchExcerpt("ſ", ["s"])).toEqual([{ text: "ſ", match: false }]);
});

test("a later match retains the leading context and ellipsis", () => {
  expect(searchExcerpt("x".repeat(60) + " HIT tail", ["hit"])).toEqual([
    { text: "…" + "x".repeat(39) + " ", match: false },
    { text: "HIT", match: true },
    { text: " tail", match: false },
  ]);
});

test("whitespace normalization, no matches and empty text retain their excerpt shape", () => {
  expect(searchExcerpt(" \n alpha \t beta \n", [])).toEqual([{ text: "alpha beta", match: false }]);
  expect(searchExcerpt(" \n alpha \t beta \n", ["missing"])).toEqual([
    { text: "alpha beta", match: false },
  ]);
  expect(searchExcerpt(" \n", ["foo"])).toEqual([]);
  expect(searchExcerpt(" \n", [])).toEqual([{ text: "", match: false }]);
});
