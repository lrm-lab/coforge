import { afterEach, expect, spyOn, test } from "bun:test";
import { decodeAppRegistrationNotice } from "@lrm/coforge-sdk/internal/app-registration-notice";

import { AppRegistrationNotices } from "#src/server/apps/app-registration-notices.server";

const SECRET = `cfa_secret_${"s".repeat(43)}`;
const notice = {
  agentId: "agent-1",
  appKey: "acme-notes",
  appName: "Acme Notes",
  clientSecret: SECRET,
};

afterEach(() => {
  spyOn(console, "warn").mockRestore();
});

function notices(
  options: {
    computerId?: string | null;
    supported?: boolean;
    fail?: boolean;
  } = {},
) {
  const published: { workspaceId: string; computerId: string; payload: Uint8Array }[] = [];
  const sender = new AppRegistrationNotices(
    async () => ({
      workspaceId: "ws-1",
      computerId: options.computerId === undefined ? "computer-1" : options.computerId,
    }),
    { supports: async () => options.supported ?? true },
    async (workspaceId, computerId, payload) => {
      if (options.fail) throw new Error(`down while sending ${SECRET}`);
      published.push({ workspaceId, computerId, payload });
    },
  );
  return { sender, published };
}

test("one notice goes to the Agent's own daemon, carrying the secret", async () => {
  const { sender, published } = notices();
  expect(await sender.send(notice)).toBe(true);
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({ workspaceId: "ws-1", computerId: "computer-1" });
  expect(decodeAppRegistrationNotice(published[0]!.payload)).toMatchObject({
    workspaceId: "ws-1",
    computerId: "computer-1",
    agentId: "agent-1",
    appKey: "acme-notes",
    clientSecret: SECRET,
  });
});

test("a daemon that did not advertise the capability, or an Agent with no Computer, gets nothing", async () => {
  const unsupported = notices({ supported: false });
  expect(await unsupported.sender.send(notice)).toBe(false);
  expect(unsupported.published).toHaveLength(0);
  const placed = notices({ computerId: null });
  expect(await placed.sender.send(notice)).toBe(false);
  expect(placed.published).toHaveLength(0);
});

test("a failed publish is not retried, does not throw, and the log never holds the secret", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const { sender, published } = notices({ fail: true });
  expect(await sender.send(notice)).toBe(false);
  expect(published).toHaveLength(0);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
});
