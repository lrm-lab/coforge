import { expect, test } from "bun:test";
import { findReadmeEntry } from "#src/features/projects/readme-entry";

const file = (name: string) => ({ name, path: name, type: "file" as const });

test("finds the root README.md whatever its case", () => {
  expect(findReadmeEntry([file("package.json"), file("README.md")])).toEqual(file("README.md"));
  expect(findReadmeEntry([file("readme.md")])).toEqual(file("readme.md"));
  expect(findReadmeEntry([file("Readme.MD")])).toEqual(file("Readme.MD"));
});

test("prefers README.md over README.markdown", () => {
  expect(findReadmeEntry([file("README.markdown"), file("README.md")])).toEqual(file("README.md"));
  expect(findReadmeEntry([file("README.markdown")])).toEqual(file("README.markdown"));
});

test("ignores a README that is not a Markdown file or not a regular file", () => {
  expect(findReadmeEntry([file("README"), file("README.txt"), file("README.rst")])).toBeNull();
  expect(
    findReadmeEntry([{ name: "README.md", path: "README.md", type: "dir" as const }]),
  ).toBeNull();
  expect(
    findReadmeEntry([{ name: "README.md", path: "README.md", type: "symlink" as const }]),
  ).toBeNull();
});

test("only looks at the repository root", () => {
  expect(
    findReadmeEntry([{ name: "README.md", path: "docs/README.md", type: "file" as const }]),
  ).toBeNull();
});

test("finds nothing in an empty repository", () => {
  expect(findReadmeEntry([])).toBeNull();
});
