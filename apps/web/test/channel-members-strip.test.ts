import { expect, test } from "bun:test";

import { sliceMembersGrid } from "#src/features/conversations/channel-members-strip";

function ids(count: number) {
  return Array.from({ length: count }, (_, index) => `member-${index + 1}`);
}

test("keeps all members up to 14 when the 15th slot is reserved for the add button", () => {
  expect(sliceMembersGrid(ids(0), true)).toEqual({ shown: [], more: 0 });
  expect(sliceMembersGrid(ids(5), true)).toEqual({ shown: ids(5), more: 0 });
  expect(sliceMembersGrid(ids(14), true)).toEqual({ shown: ids(14), more: 0 });
});

test("reserves slot 14 for +N and slot 15 for the add button once members exceed 14", () => {
  expect(sliceMembersGrid(ids(15), true)).toEqual({ shown: ids(13), more: 2 });
  expect(sliceMembersGrid(ids(17), true)).toEqual({ shown: ids(13), more: 4 });
});

test("uses all 15 slots for members when no add slot is rendered", () => {
  expect(sliceMembersGrid(ids(14), false)).toEqual({ shown: ids(14), more: 0 });
  expect(sliceMembersGrid(ids(15), false)).toEqual({ shown: ids(15), more: 0 });
  expect(sliceMembersGrid(ids(16), false)).toEqual({ shown: ids(14), more: 2 });
  expect(sliceMembersGrid(ids(17), false)).toEqual({ shown: ids(14), more: 3 });
});
