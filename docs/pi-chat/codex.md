# Native Codex sessions

Choose a Computer with Codex CLI 0.169.1 or newer and an active, updated Daemon.
Sign in to Codex on that Computer. Each conversation stays on its original
Computer and uses the CLI's model configuration and native thread history.
Codex writes inside the private workbench directory. The native sandbox disables
network access by default. Requests for a command or an exact file change can
be approved once or denied in the conversation. Other approval types are declined.

Closing the browser leaves an admitted turn in the local worker. Stopping
interrupts the turn and tears down its process. Removing the conversation from
the workbench archives the native thread. Its workbench index is separate from Pi.

Reopening a session loads native transcript pages. If the worker restarts while
a turn is active, it preserves the submitted text and marks the turn interrupted.
Review the history before continuing. If Codex stopped before saving its first
turn, move the retained text to a new draft and send it when ready.
