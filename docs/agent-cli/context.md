# Agent context search and read

`coforge context search` and `coforge context read` inspect the calling Agent's
current provider session through the local Daemon. The command never accepts a
different Agent or an older session id.

```sh
coforge context search --message-id <id> --session-id <id> --query "deploy" [--limit 20] [--offset 0]
coforge context read --message-id <id> --session-id <id> --around m4.p0 [--limit 5] [--page 0]
```

Search is literal and case-insensitive. Results use stable entry ids: `sN` for
system entries, `tN` for tools, and `mN.pN` for message parts. Search returns
at most 50 matches and caps the query at 200 characters. Read returns at most
21 entries per page and caps each page at 8 KiB, with a 64 KiB answer limit.

Authorization runs before context-index lookup or provider-file access. The
local proxy binds the request to the Agent API key; the Daemon then requires
the requested session to equal that Agent's current reported session. Context
content is restored in the existing isolated child and passes through the same
redaction and source-containment checks as the owner context view.
