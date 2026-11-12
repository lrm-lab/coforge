/**
 * Where a card's Ignore sits, for Frank to choose between (task #91, review branch only): `top`,
 * on the card's title line; `bottom`, in the card's own last row. Read from `?ignoreAt=` once.
 */
export const IGNORE_AT: "top" | "bottom" =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("ignoreAt") === "top"
    ? "top"
    : "bottom";
