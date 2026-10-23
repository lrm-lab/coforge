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
