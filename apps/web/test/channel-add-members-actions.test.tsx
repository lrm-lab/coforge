import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChannelAddMembersActions } from "#src/features/conversations/channel-add-members-dialog";
import { m } from "#src/paraglide/messages";

const render = (canAdd: boolean, count = 1) =>
  renderToStaticMarkup(
    <ChannelAddMembersActions
      canAdd={canAdd}
      submitting={false}
      count={count}
      error=""
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
  );

const addLabel = (count: number) => m.channel_members_add_selected({ count });

/**
 * `PublicChannels.addMembers` rejects a non-member with `ACCESS_DENIED`, so the dialog must not
 * offer the action either: the viewer gets the explanation and no Add button. A regression here
 * reached main once (PR #69), which is why the rule is pinned.
 */
test("a viewer who may not add members gets no Add button, only Cancel", () => {
  const markup = render(false);

  expect(markup).not.toContain(addLabel(1));
  expect(markup).toContain(m.channel_members_cancel());
  expect(markup.match(/<button/g)).toHaveLength(1);
});

test("a member who may add gets both the Add button, counted, and Cancel", () => {
  const markup = render(true, 2);

  expect(markup).toContain(addLabel(2));
  expect(markup).toContain(m.channel_members_cancel());
  expect(markup.match(/<button/g)).toHaveLength(2);
});

test("nothing is selected yet, so the Add button is there but not pressable", () => {
  const markup = render(true, 0);

  expect(markup).toContain(addLabel(0));
  expect(markup).toContain("disabled");
});
