import { expect, test } from "bun:test";

import { nameMatchTier } from "#src/lib/name-match";

const cases: {
  name: string;
  label: string;
  others: string[];
  query: string;
  tier: ReturnType<typeof nameMatchTier>;
}[] = [
  { name: "label exact", label: "ATLAS", others: ["helper"], query: "atlas", tier: 0 },
  {
    name: "alias exact beats label prefix",
    label: "Atlas Bot",
    others: ["ATLAS"],
    query: "atlas",
    tier: 0,
  },
  {
    name: "later alias exact beats earlier alias prefix",
    label: "Other",
    others: ["atlas-helper", "ATLAS"],
    query: "atlas",
    tier: 0,
  },
  {
    name: "alias prefix beats later label word",
    label: "Casey Atlas",
    others: ["atlas-helper"],
    query: "atl",
    tier: 1,
  },
  {
    name: "later label word beats alias substring",
    label: "Casey Atlas",
    others: ["xatlas"],
    query: "atl",
    tier: 2,
  },
  {
    name: "only label words receive the word tier",
    label: "Other",
    others: ["Casey Atlas"],
    query: "atl",
    tier: 3,
  },
  {
    name: "first nonempty word stays the first word",
    label: "  Atlas Other",
    others: [],
    query: "atl",
    tier: 3,
  },
  {
    name: "mixed whitespace separates later words",
    label: "\tAda\u00a0\uFEFFLovelace\n",
    others: [],
    query: "lov",
    tier: 2,
  },
  {
    name: "punctuation does not separate words",
    label: "Ada-Lovelace",
    others: [],
    query: "lov",
    tier: 3,
  },
  {
    name: "Unicode casing keeps combining characters",
    label: "İSTANBUL",
    others: [],
    query: "i\u0307s",
    tier: 1,
  },
  {
    name: "contextual sigma casing stays unchanged",
    label: "ΟΣ",
    others: [],
    query: "ος",
    tier: 0,
  },
  {
    name: "missing names have no tier",
    label: "Ada Lovelace",
    others: ["ada-l"],
    query: "nomatch",
    tier: undefined,
  },
  { name: "empty label and query are exact", label: "", others: [], query: "", tier: 0 },
  {
    name: "empty alias is exact for an empty query",
    label: "Atlas",
    others: [""],
    query: "",
    tier: 0,
  },
  {
    name: "nonempty fields prefix an empty query",
    label: "Atlas",
    others: ["helper"],
    query: "",
    tier: 1,
  },
];

test.each(cases)("nameMatchTier: $name", ({ label, others, query, tier }) => {
  const fields = [...others];
  expect(nameMatchTier(label, others, query)).toBe(tier);
  expect(others).toEqual(fields);
});
