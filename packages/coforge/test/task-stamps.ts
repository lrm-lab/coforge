/** The id, creator and timestamps every Task read carries. */
export const taskStamps = {
  id: "task-1",
  creator: {
    memberId: "member-ada",
    kind: "user" as const,
    id: "user-ada",
    name: "Ada",
    handle: "ada",
  },
  createdAt: "2026-09-23T05:00:00.000Z",
  updatedAt: "2026-09-23T06:00:00.000Z",
};
