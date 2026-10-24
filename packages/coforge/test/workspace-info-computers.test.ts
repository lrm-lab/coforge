import { expect, test } from "bun:test";
import { parseArgs } from "../index";

test("workspace info accepts the computers section flag without a value", () => {
  expect(parseArgs(["workspace", "info", "--computers"])).toEqual({
    command: "workspace.info",
    computers: true,
  });
});
