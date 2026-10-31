import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  loadAllMemberWeeks,
  loadMemberWeek,
  loadMemberWeeksPage,
} from "#src/server/records/record-member-weeks.server";
import { filterMemberWeeks } from "./records-sidebar";

// The Records catalog holds the newest page of member weeks (task #366); these read the rest.

const weekOfYear = {
  year: z.number().int().min(1).max(9999),
  week: z.number().int().min(1).max(53),
};

/** The page of member weeks older than `before` (the catalog's `memberWeeksBefore`). */
export const loadOlderMemberWeeks = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ before: z.object(weekOfYear) }))
  .handler(({ data, context: { user, db, workspaceId } }) =>
    loadMemberWeeksPage(db, { workspaceId, userId: user.id, before: data.before }),
  );

/** One member week, wherever it falls; no week when the viewer has none there. */
export const loadMemberWeekAt = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object(weekOfYear))
  .handler(({ data, context: { user, db, workspaceId } }) =>
    loadMemberWeek(db, { workspaceId, userId: user.id, year: data.year, week: data.week }),
  );

/** Every member week matching `query`, by the sidebar's own filter, so a search reaches them all. */
export const searchMemberWeeks = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  // Untrimmed, as the sidebar matches it: "2024 W5 " finds W5 and not W50.
  .validator(z.object({ query: z.string().min(1).max(200) }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const all = await loadAllMemberWeeks(db, { workspaceId, userId: user.id });
    const memberWeeks = filterMemberWeeks(all.memberWeeks, data.query, all.people);
    const named = new Set(
      memberWeeks.flatMap((week) => week.submissions.map((row) => row.authorId)),
    );
    return {
      memberWeeks,
      people: Object.fromEntries(Object.entries(all.people).filter(([id]) => named.has(id))),
    };
  });
