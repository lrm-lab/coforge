# `coforge` Agent-facing CLI

This binary is the stable command boundary exposed to code agents. Message
transport is intentionally injected by the eventual host; the standalone
binary currently reports a clear unavailable-transport error.

The command reference lives in [`docs/agent-cli/`](../../docs/agent-cli/README.md).

## Module map

| Module                                      | Responsibility                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/cli.ts`                                | Entry point: dispatches `argv`, prints the result or a rendered `CliError`, sets the exit code |
| `index.ts`                                  | Argument parsing, the `MessageTransport` port, and the commands that return a result to print  |
| `src/local-client.ts`                       | The `MessageTransport` over the daemon's local Agent proxy                                     |
| `src/proxy-request.ts`                      | The preflight and the `{ ok: false, errorCode, error }` request every proxied call shares      |
| `src/cli-error.ts`                          | The typed CLI failure and its rendering                                                        |
| `src/refusal-guidance.ts`                   | What a server refusal means for the Agent's next step                                          |
| `src/app-config.ts`                         | `app config`: read or change one of the Agent's own Apps' config                               |
| `src/app-commands.ts`                       | `app list/invoke/token`: parsing, the list text, approval-required guidance                    |
| `src/app-actions.ts`                        | `app invoke --list-actions`: actions as text or typed JSON, text cleaned                       |
| `src/manifest-fetch.ts`                     | An app's Agent manifest fetch: https only, 1 MiB and 10 s caps, outcomes                       |
| `src/app-client.ts`                         | The `app list` and `app token` requests through the local proxy                                |
| `src/app-token-exec.ts`                     | Running a program with an app token: fd 3, minimal environment, redaction, timeout, group stop |
| `src/github-credential.ts`                  | The git credential helper and the `github gh` wrapper                                          |
| `src/git-prepare-commit-msg.ts`             | The `prepare-commit-msg` hook's co-author trailers                                             |
| `src/action-prepare-input.ts`               | `action prepare`'s heredoc or literal body                                                     |
| `src/attachment-upload.ts`                  | `attachment upload`'s MIME type and target checks                                              |
| `src/reminder-duration.ts`                  | `reminder` duration literals                                                                   |
| `src/*-format.ts`, `src/message-summary.ts` | Text renderers for each command family's stdout                                                |
| `src/version.ts`                            | The CLI's own version                                                                          |
