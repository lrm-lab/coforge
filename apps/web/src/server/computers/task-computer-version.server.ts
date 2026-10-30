import { compareReleaseVersions, parseReleaseVersion } from "@lrm/coforge-sdk/internal";

/**
 * The oldest Computer release whose CLI and daemon handle a Task with no channel message, which
 * task conversations create. `-0` is the lowest 0.1.19 prerelease, so every 0.1.19 build counts,
 * the development ones included. An older CLI crashes listing such a Task.
 */
export const TASK_CONVERSATIONS_MIN_COMPUTER_VERSION = "0.1.19-0";

/** The release a person is asked to upgrade to. */
export const TASK_CONVERSATIONS_MIN_COMPUTER_RELEASE = "0.1.19";

/** Whether a Computer's reported version can serve task conversations; an unknown one cannot. */
export function computerSupportsTaskConversations(version: string | null | undefined) {
  return (
    version != null &&
    parseReleaseVersion(version) !== undefined &&
    compareReleaseVersions(version, TASK_CONVERSATIONS_MIN_COMPUTER_VERSION) >= 0
  );
}
