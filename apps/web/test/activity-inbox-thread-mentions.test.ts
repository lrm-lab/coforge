import { expect, test } from "bun:test";
import { activityPageSql } from "#src/server/inbox/activity-inbox-page-sql.server";

/**
 * The followed-thread mention probe must stay a per-message primary-key lookup. `OFFSET 0` fences
 * the `EXISTS`: without it PostgreSQL 18 pulls the probe up into a join that scans the member's
 * mentions in the conversation once per thread message — on production one Activity page cost
 * ~940k buffer hits and ~1.2 s; fenced, the same page runs in ~16 ms. A local planner does not
 * always pick the bad plan, so the guard pins the fence in the generated statement itself.
 */
test("the thread mention probe keeps its OFFSET 0 optimization fence", () => {
  const statement = activityPageSql(crypto.randomUUID(), crypto.randomUUID(), {
    filter: "all",
    limit: 30,
  });
  expect(statement.text).toMatch(/mm\."memberId" = threads\."memberId"\s+OFFSET 0/);
});
