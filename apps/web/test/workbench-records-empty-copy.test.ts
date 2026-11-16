import { expect, test } from "bun:test";
import { piChatFailureMessage } from "#src/features/pi-chat/pi-chat-failure";
import { memberWeeksListed, weeklyEmptyNote } from "#src/features/records/records-sidebar";
import { m } from "#src/paraglide/messages";

test("an AI Workbench failure says what failed; only a send says a resend is safe", () => {
  expect(piChatFailureMessage("send")).toBe(m.pi_chat_connection_error());
  expect(piChatFailureMessage("load")).toBe(m.pi_chat_load_error());
  expect(piChatFailureMessage("action")).toBe(m.pi_chat_action_error());
  // A read never mentions sending again: nothing was sent.
  expect(piChatFailureMessage("load")).not.toBe(piChatFailureMessage("send"));
  expect(piChatFailureMessage("action")).not.toBe(piChatFailureMessage("send"));
});

const noMembers = { weeks: [], hasMore: false, loadingMore: false, loadFailed: false };

test("the member weeks group is listed while it has a week, more to load, or a load state", () => {
  expect(memberWeeksListed(noMembers)).toBe(false);
  expect(memberWeeksListed({ ...noMembers, weeks: [{}] })).toBe(true);
  expect(memberWeeksListed({ ...noMembers, hasMore: true })).toBe(true);
  expect(memberWeeksListed({ ...noMembers, loadingMore: true })).toBe(true);
  expect(memberWeeksListed({ ...noMembers, loadFailed: true })).toBe(true);
});

test("Records weekly says there are no reports only when all three groups are empty", () => {
  const empty = { favorites: 0, myReports: 0, membersListed: false, query: "" };
  expect(weeklyEmptyNote(empty)).toBe(m.records_weekly_none());
  expect(weeklyEmptyNote({ ...empty, query: "季度复盘" })).toBe(
    m.records_weekly_no_match({ query: "季度复盘" }),
  );
  expect(weeklyEmptyNote({ ...empty, favorites: 1 })).toBeUndefined();
  expect(weeklyEmptyNote({ ...empty, myReports: 1 })).toBeUndefined();
  expect(weeklyEmptyNote({ ...empty, membersListed: true })).toBeUndefined();
});
