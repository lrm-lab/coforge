/** Where an app is in Marketplace review (`apps.publishStatus`, `apps_publish_status_check`). */
export const APP_PUBLISH_STATUSES = [
  "private",
  "publish_requested",
  "published",
  "rejected",
  "unpublish_requested",
] as const;

export type AppPublishStatus = (typeof APP_PUBLISH_STATUSES)[number];

/** The two kinds of review request: to list the app in the Marketplace, or to take it off. */
export type AppReviewKind = "publish" | "unpublish";

/** A reviewer's decision on a request. */
export type AppReviewOutcome = "approved" | "rejected";

/** The reason a reviewer may record with a decision, at most this many characters. */
export const REVIEW_REASON_MAX_LENGTH = 1000;

/**
 * The publish state machine, per kind of request: the statuses it may be filed from, the status
 * the app waits in while the request is open, and where a reviewer's decision moves it. The one
 * source for the request check, the store's transitions and `canRequestPublish`.
 */
export const PUBLISH_TRANSITIONS = {
  publish: {
    from: ["private", "rejected"],
    pending: "publish_requested",
    approved: "published",
    rejected: "rejected",
  },
  unpublish: {
    from: ["published"],
    pending: "unpublish_requested",
    approved: "private",
    rejected: "published",
  },
} as const satisfies Record<
  AppReviewKind,
  {
    from: readonly AppPublishStatus[];
    pending: AppPublishStatus;
    approved: AppPublishStatus;
    rejected: AppPublishStatus;
  }
>;

/** A listed app, or one whose removal is pending, cannot be deleted: it is live for other
 * Workspaces. */
export const DELETABLE_STATUSES: readonly AppPublishStatus[] = [
  "private",
  "publish_requested",
  "rejected",
];

/** Whether an app can be deleted; an app without a status (`app-marketplace` off) is private. */
export const canDeleteApp = (status: AppPublishStatus = "private") =>
  DELETABLE_STATUSES.includes(status);

/** A publish request can be filed only from private or rejected. */
export const canRequestPublish = (status: AppPublishStatus) =>
  (PUBLISH_TRANSITIONS.publish.from as readonly AppPublishStatus[]).includes(status);

/** The statuses in which other Workspaces can discover and install the app: published, and still
 * published while a request to take it off waits (Raft keeps it listed and installable). */
export const LISTED_STATUSES: readonly AppPublishStatus[] = ["published", "unpublish_requested"];
