import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, ".vitepress/dist");
const schemaSource = resolve(
  root,
  "../../docs/agent-manifest/coforge-agent-manifest.v1.schema.json",
);

function sourcePages(): string[] {
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "public", "test"].includes(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md") && entry.name !== "AGENTS.md") {
        pages.push(relative(root, path));
      }
    }
  };
  walk(root);
  return pages.sort();
}

// vitepress-plugin-llms publishes `<dir>/index.md` as `<dir>.md`; the root index stays `index.md`.
function markdownTwin(page: string): string {
  return page.endsWith("/index.md") ? `${page.slice(0, -"/index.md".length)}.md` : page;
}

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const code = await build.exited;
  if (code !== 0) throw new Error(await new Response(build.stderr).text());
}, 120_000);

describe("developer docs site", () => {
  const pages = sourcePages();

  test("has pages in both locales", () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  test("English and zh-CN have the same page set", () => {
    const english = pages.filter((page) => !page.startsWith("zh-CN/"));
    const chinese = pages.filter((page) => page.startsWith("zh-CN/")).map((page) => page.slice(6));
    expect(chinese).toEqual(english);
  });

  test("every page has a Markdown twin and is listed in llms.txt", () => {
    const llms = readFileSync(join(dist, "llms.txt"), "utf8");
    for (const page of pages) {
      const twin = markdownTwin(page);
      expect(existsSync(join(dist, twin))).toBe(true);
      expect(llms).toContain(`(${twin.startsWith("/") ? twin : `/${twin}`})`);
    }
  });

  test("llms-full.txt exists", () => {
    expect(existsSync(join(dist, "llms-full.txt"))).toBe(true);
  });

  test("the Agent manifest schema is a byte-identical copy of docs/agent-manifest", () => {
    const published = join(dist, "schemas/coforge-agent-manifest.v1.schema.json");
    expect(readFileSync(published).equals(readFileSync(schemaSource))).toBe(true);
  });
});

// The Inter subsets are cut to what the built site uses by `scripts/subset-fonts.py`. These checks
// fail when content or CSS starts to need something the subsets dropped: rerun the script.
describe("subset Inter fonts", () => {
  const fontsCss = readFileSync(join(root, ".vitepress/theme/fonts/fonts.css"), "utf8");
  // What VitePress's own Inter faces cover is what renders in Inter; anything else falls back to
  // system fonts today and must keep doing so.
  const vitepressFontsCss = readFileSync(
    join(root, "node_modules/vitepress/dist/client/theme-default/styles/fonts.css"),
    "utf8",
  );

  function interFaces(css: string): string[] {
    return [...css.matchAll(/@font-face\s*{([^}]*)}/g)]
      .map((match) => match[1]!)
      .filter((body) => /font-family:\s*['"]?Inter['"]?\s*;/.test(body));
  }

  function unicodeRange(face: string): Set<number> {
    const points = new Set<number>();
    const range = /unicode-range:([^;]+);/.exec(face)?.[1] ?? "";
    for (const [, from, to] of range.matchAll(/U\+([0-9A-F]+)(?:-([0-9A-F]+))?/gi)) {
      for (let point = parseInt(from!, 16); point <= parseInt(to ?? from!, 16); point++) {
        points.add(point);
      }
    }
    return points;
  }

  function union(faces: string[]): Set<number> {
    return new Set(faces.flatMap((face) => [...unicodeRange(face)]));
  }

  function builtFiles(extension: string): string[] {
    return readdirSync(dist, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(extension))
      .map((path) => join(dist, path));
  }

  function usedCodePoints(): Set<number> {
    const points = new Set<number>();
    for (const path of [...builtFiles(".html"), ...builtFiles(".js")]) {
      const text = readFileSync(path, "utf8").replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) =>
        String.fromCodePoint(code[0] === "x" ? parseInt(code.slice(1), 16) : Number(code)),
      );
      for (const char of text) points.add(char.codePointAt(0)!);
    }
    return points;
  }

  const before = union(interFaces(vitepressFontsCss));
  const after = union(interFaces(fontsCss));

  test("every character that rendered in Inter still has an Inter face", () => {
    // Control and format characters (a newline, U+00AD) draw nothing, and Inter has no glyph for them.
    const missing = [...usedCodePoints()]
      .filter((point) => !/[\p{Cc}\p{Cf}]/u.test(String.fromCodePoint(point)))
      .filter((point) => before.has(point) && !after.has(point))
      .map((point) => `U+${point.toString(16).toUpperCase().padStart(4, "0")}`);
    expect(missing).toEqual([]);
  });

  test("no character that fell back to a system font gains an Inter face", () => {
    const gained = [...after].filter((point) => !before.has(point));
    expect(gained).toEqual([]);
  });

  // Stylesheets, and inline styles in page HTML and in component code (`:style` compiles to
  // camelCase properties).
  test("the built site asks only for weights and features the subsets keep", () => {
    const css = [...builtFiles(".css"), ...builtFiles(".html"), ...builtFiles(".js")]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n")
      .replace(
        /font(Weight|Variant[A-Za-z]*|FeatureSettings|VariationSettings)["']?\s*:\s*["']?/g,
        (_: string, name: string) => `font${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:`,
      );
    const declared = interFaces(fontsCss).map((face) => /font-weight:\s*(\d+)\s+(\d+);/.exec(face));
    const low = Math.min(...declared.map((match) => Number(match?.[1])));
    const high = Math.max(...declared.map((match) => Number(match?.[2])));
    const outOfRange = [...css.matchAll(/font-weight:\s*([^;}!"',]+)/g)]
      .map((match) => match[1]!.trim())
      .filter((weight) => !/^\d+\s+\d+$/.test(weight) && weight !== "inherit")
      .filter((weight) => {
        const value = weight === "bold" ? 700 : weight === "normal" ? 400 : Number(weight);
        return !(value >= low && value <= high);
      });
    expect(outOfRange).toEqual([]);
    expect(css).not.toMatch(/font-(feature-settings|variation-settings|variant(-[a-z]+)?)\s*:/);
  });

  test("every page preloads the roman core and no other font", () => {
    for (const page of builtFiles(".html")) {
      const preloads = [...readFileSync(page, "utf8").matchAll(/<link rel="preload"[^>]*>/g)]
        .map((match) => match[0])
        .filter((link) => link.includes('as="font"'));
      expect(preloads).toHaveLength(1);
      expect(preloads[0]).toMatch(/href="\/assets\/inter-roman-core\.[\w-]+\.woff2"/);
    }
  });
});
