import { expect, test } from "bun:test";
import { ownedWorkspaceCreateData } from "#src/server/db/repositories/workspace-slugs.repositories.server";

test("a new Workspace is created with the Foundation Models Weekly template", () => {
  expect(
    ownedWorkspaceCreateData({
      slug: "lijian",
      name: "李健的工作区",
      userId: "user-1",
    }),
  ).toEqual({
    slug: "lijian",
    name: "李健的工作区",
    members: { create: { userId: "user-1", role: "owner" } },
    conversations: {
      create: { channelName: "general", members: { create: { userId: "user-1" } } },
    },
    weeklyTemplates: {
      create: {
        ownerId: "user-1",
        name: "Foundation Models Weekly",
        frequency: "weekly",
        sendTime: "15:00",
        sendWeekday: 5,
        scheduleEnabled: false,
        applied: false,
        allMembers: true,
        mainTitles: [],
        dimensions: [
          { title: "Summary", children: ["Work Summary", "Next Steps"] },
          { title: "Technique", children: ["Technique"] },
          { title: "Achievements", children: ["Achievements"] },
          { title: "Research", children: ["New paper / model / product"] },
        ],
      },
    },
  });
});
