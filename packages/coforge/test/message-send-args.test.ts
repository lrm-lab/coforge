import { expect, test } from "bun:test";
import { parseArgs } from "../index";
import { CliError } from "#src/cli-error";

test("a send refuses an argument body and names where the body does come from", () => {
  // The help used to advertise `<body...>`; an Agent following it got a bare "Usage:".
  for (const args of [
    ["message", "send", "--target", "#general", "Shipped the fix."],
    ["message", "send", "--target", "#general", "--", "Shipped the fix."],
  ]) {
    let thrown: unknown;
    try {
      parseArgs(args);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const message = (thrown as CliError).message;
    expect(message).toContain("< message body on stdin");
    expect(message).toContain("here-document");
    expect(message).toContain("<<'COFORGE_MESSAGE'");
    // The exit-0 rule for undelivered mentions travels with the same explanation.
    expect(message).toContain("still exits 0");
  }
});
