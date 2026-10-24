import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import { CliError } from "#src/cli-error";
import type { AgentUserInfoResponse } from "@lrm/coforge-sdk/agent";

const TRANSPORT = {
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
};

const human = (memberships: AgentUserInfoResponse["memberships"]): AgentUserInfoResponse => ({
  ok: true,
  user: {
    kind: "human",
    id: "user-1",
    name: "alice",
    displayName: "Alice Chen",
    description: "Engineering lead.",
    role: "admin",
    isSelf: false,
  },
  memberships,
});

const userInfo = (args: string[], response: AgentUserInfoResponse) =>
  run(["user", "info", ...args], { ...TRANSPORT, userInfo: async () => response });

test("parses the name, paging and json options of user info", () => {
  expect(parseArgs(["user", "info", "@alice", "--limit", "10", "--offset", "20"])).toEqual({
    command: "user-info",
    name: "alice",
    limit: 10,
    offset: 20,
  });
  expect(() => parseArgs(["user", "info"])).toThrow("Usage: coforge user info");
  expect(() => parseArgs(["user", "info", "@"])).toThrow("user name is required");
  expect(() => parseArgs(["user", "info", "alice", "--limit", "0"])).toThrow(
    "--limit must be greater than 0",
  );
  expect(() => parseArgs(["user", "info", "alice", "--limit", "201"])).toThrow(
    "--limit must be at most 200",
  );
  expect(() => parseArgs(["user", "info", "alice", "--offset", "-1"])).toThrow(
    "--offset must be a non-negative integer",
  );
  expect(() => parseArgs(["user", "info", "alice", "--limit"])).toThrow("Usage:");
});

test("formats a human's card and the channels they share with the caller", async () => {
  expect(
    await userInfo(
      ["@alice"],
      human([{ channel: "#general", role: "member" }, { channel: "#ops" }]),
    ),
  ).toBe(
    [
      "## User",
      "",
      "User: @alice",
      "Kind: human",
      "Role: admin",
      "Description: Engineering lead.",
      "Display name: Alice Chen",
      "",
      "### Visible Channel Memberships",
      "#general [public, joined, channel role=member, not archived]",
      "#ops [public, joined, not archived]",
      "Showing 1-2 of 2.",
      "",
    ].join("\n"),
  );
});

test("leaves out the role of an ordinary member and says when no channel is shared", async () => {
  const response = human([]);
  response.user.role = "member";
  const output = (await userInfo(["alice"], response)) as string;
  expect(output).not.toContain("Role:");
  expect(output).toContain("(none found in inspected visible channels)\nShowing 0-0 of 0.");
});

test("pages the memberships and prints the command for the next page", async () => {
  const memberships = ["#a", "#b", "#c", "#d", "#e"].map((channel) => ({ channel }));
  const output = (await userInfo(
    ["alice", "--limit", "2", "--offset", "2"],
    human(memberships),
  )) as string;
  expect(output).toContain(
    "#c [public, joined, not archived]\n#d [public, joined, not archived]\n",
  );
  expect(output).toContain(
    "Showing 3-4 of 5.\nMore: coforge user info @alice --offset 4 --limit 2\n",
  );
  expect(output).not.toContain("#a ");
});

test("shows an Agent's status and runtime facts after the common lines", async () => {
  const output = (await userInfo(["scout"], {
    ok: true,
    user: {
      kind: "agent",
      id: "agent-1",
      name: "scout",
      displayName: "Scout",
      description: "",
      role: "member",
      isSelf: true,
      status: "online",
      computerName: "mac-1",
      runtime: "codex",
      model: "gpt-5",
    },
    memberships: [],
  })) as string;
  expect(output).toContain(
    "User: @scout\nKind: agent\nStatus: online\nDisplay name: Scout\nComputer: mac-1\nProvider: codex\nModel: gpt-5\nSelf: yes\n",
  );
});

test("an unknown user gets the next step to find them", async () => {
  const error = (await run(["user", "info", "ghost"], {
    ...TRANSPORT,
    userInfo: async () => {
      throw new CliError({
        code: "USER_NOT_FOUND",
        message: "User not found or not visible: @ghost",
      });
    },
  }).catch((caught: unknown) => caught)) as CliError;
  expect(error).toBeInstanceOf(CliError);
  expect(error.message).toBe("User not found or not visible: @ghost");
  expect(error.suggestedNextAction).toBe(
    "Run `coforge workspace info --agents --query <name>` or `coforge workspace info --humans --query <name>` to inspect visible users.",
  );
});
