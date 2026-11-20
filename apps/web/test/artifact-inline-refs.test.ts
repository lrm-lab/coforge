import { describe, expect, test } from "bun:test";
import {
  encodeInlineElementRef,
  extractElementTag,
  firstElementAnchorFromSegments,
  hasInlineRefs,
  parseInlineRefs,
  segmentsFromDraft,
  serializeInlineSegments,
} from "#src/features/artifacts/artifact-inline-refs";

describe("artifact inline element references", () => {
  test("extracts clean tag names from step names and CSS selectors", () => {
    expect(extractElementTag("h1#title")).toBe("h1");
    expect(extractElementTag("svg.hero-heart > use")).toBe("use");
    expect(extractElementTag('button[data-testid="buy"]')).toBe("button");
    expect(extractElementTag("main > p:nth-of-type(2)")).toBe("p");
    expect(extractElementTag("custom-card.featured")).toBe("custom-card");
    expect(extractElementTag("#hero")).toBe("el");
  });

  test("round-trips multiple inline element refs mixed with text and attribute selectors", () => {
    const encoded = serializeInlineSegments([
      { kind: "element", tag: "use", selector: "svg.hero-heart > use" },
      { kind: "text", text: " test " },
      { kind: "element", tag: "button", selector: 'button[data-testid="buy"]' },
      { kind: "text", text: " 改一下颜色" },
    ]);
    expect(encoded).toBe(
      '{{<use> svg.hero-heart > use}} test {{<button> button[data-testid="buy"]}} 改一下颜色',
    );
    expect(hasInlineRefs(encoded)).toBe(true);
    expect(parseInlineRefs(encoded)).toEqual([
      { kind: "element", tag: "use", selector: "svg.hero-heart > use" },
      { kind: "text", text: " test " },
      { kind: "element", tag: "button", selector: 'button[data-testid="buy"]' },
      { kind: "text", text: " 改一下颜色" },
    ]);
  });

  test("treats plain text and malformed braces safely as text", () => {
    expect(hasInlineRefs("just plain text")).toBe(false);
    expect(parseInlineRefs("keep {{not a ref}} and <a>")).toEqual([
      { kind: "text", text: "keep {{not a ref}} and <a>" },
    ]);
    expect(encodeInlineElementRef({ tag: "DIV", selector: "main > div\n.bad}}" })).toBe(
      "{{<div> main > div .bad}}",
    );
  });

  test("derives primary element anchor from the first referenced element", () => {
    const segments = parseInlineRefs(
      'check {{<use> svg > use}} and {{<button> button[data-testid="buy"]}}',
    );
    expect(firstElementAnchorFromSegments(segments)).toEqual({
      type: "element",
      data: { selector: "svg > use", quote: "<use>" },
    });
    expect(firstElementAnchorFromSegments([{ kind: "text", text: "no chips" }])).toBeNull();
  });

  test("hydrates legacy element-anchored drafts without duplicating inline refs", () => {
    expect(
      segmentsFromDraft({
        body: "Make it bigger",
        anchor: { type: "element", data: { selector: "svg > use", quote: "Heart" } },
      }),
    ).toEqual([
      { kind: "element", tag: "use", selector: "svg > use", quote: "Heart" },
      { kind: "text", text: " Make it bigger" },
    ]);
    expect(
      segmentsFromDraft({
        body: "{{<use> svg > use}} test {{<use> svg > use}}",
        anchor: { type: "element", data: { selector: "svg > use", quote: "<use>" } },
      }),
    ).toEqual([
      { kind: "element", tag: "use", selector: "svg > use" },
      { kind: "text", text: " test " },
      { kind: "element", tag: "use", selector: "svg > use" },
    ]);
  });
});
