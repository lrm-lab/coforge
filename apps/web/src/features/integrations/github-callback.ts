/** Why the GitHub callback sent the person back to Settings, as the `github` search value. */
export const GITHUB_CALLBACK_FAILURES = ["error", "wrong_account", "account_taken"] as const;
export type GitHubCallbackFailure = (typeof GITHUB_CALLBACK_FAILURES)[number];
/** What `GitHubConnection.complete` answers: connected, a generic failure, or a failure Settings names. */
export type GitHubAuthorizationResult = boolean | Exclude<GitHubCallbackFailure, "error">;
