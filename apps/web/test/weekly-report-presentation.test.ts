import { afterAll, beforeAll, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { useStorage } from "nitro/storage";
import { buildWeeklyReportHtml } from "#src/server/records/weekly-report-html.server";
import { buildWeeklyReportPresentation } from "#src/server/records/weekly-report-presentation.server";

const TEMPLATE_NAME = "foundation-models-weekly.pptx";
const templateStorage = useStorage<Uint8Array>("assets:weekly-report-templates");
let templateBytes: Uint8Array;

beforeAll(async () => {
  templateBytes = new Uint8Array(
    await Bun.file(
      new URL(`../assets/weekly-report-templates/${TEMPLATE_NAME}`, import.meta.url),
    ).arrayBuffer(),
  );
  await templateStorage.setItemRaw(TEMPLATE_NAME, templateBytes);
});

afterAll(async () => {
  await templateStorage.removeItem(TEMPLATE_NAME);
});

test("weekly report template is a checked-in binary PPTX server asset", () => {
  expect(templateBytes.byteLength).toBe(3_932_563);
  expect(new TextDecoder().decode(templateBytes.slice(0, 4))).toBe("PK\u0003\u0004");
  expect(new Bun.CryptoHasher("sha256").update(templateBytes).digest("hex")).toBe(
    "cc038d5c4e1252e1cbf055d0f2211455fb88621eb1e0a5f78bf50320bcb9b5c9",
  );
});

test("weekly report presentation keeps the checked-in PPTX package", async () => {
  const bytes = await buildWeeklyReportPresentation({
    title: "Foundation Models Weekly",
    period: "2026.09.21 ~ 2026.09.24",
    members: [{ displayName: "jianghp3", sections: { Summary: "• completed the benchmark" } }],
  });
  expect(bytes.byteLength).toBe(3_932_987);
  const files = unzipSync(bytes);
  const xml = Object.values(files)
    .map((file) => new TextDecoder().decode(file))
    .join("\n");
  expect(xml).toContain("Foundation Models Weekly");
  expect(xml).toContain("2026.09.21 ~ 2026.09.24");
  expect(xml).toContain("completed the benchmark");
  expect(xml).toContain("weeklySlide2");
});

test("weekly report HTML export is self-contained and escapes report content", () => {
  const html = buildWeeklyReportHtml({
    title: "W40 <summary>",
    period: "2026 W40",
    summary: `- shipped <safe>\n- reviewed the export`,
    members: [
      {
        displayName: "Alice",
        sections: { Achievements: "# Delivered\n- <script>alert(1)</script>" },
      },
    ],
  });
  expect(html).toContain("W40 &lt;summary&gt;");
  expect(html).toContain("Alice · Achievements");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("@media print");
});

test("weekly report presentation strips control bytes but keeps tabs from report text", async () => {
  const bytes = await buildWeeklyReportPresentation({
    title: "W41\u0000Report",
    period: "2026 W41\u0007",
    members: [{ displayName: "Alice", sections: { Summary: "shipped\u0001the fix\tand more" } }],
  });
  const xml = Object.entries(unzipSync(bytes))
    .filter(([name]) => name.endsWith(".xml"))
    .map(([, file]) => new TextDecoder().decode(file))
    .join("\n");
  expect(xml).toContain("W41Report");
  expect(xml).toContain("2026 W41");
  expect(xml).toContain("shippedthe fix\tand more");
  for (const byte of ["\u0000", "\u0001", "\u0007"]) expect(xml).not.toContain(byte);
});
