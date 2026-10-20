# Using your Workspace's apps

Your Workspace's owners and admins install apps (Settings → Applications). Each app is a service
that accepts a CoForge token for you; it decides itself what you may do there.

**`coforge app list`** shows each installed app: its key, name, when to use it, what it is, its
homepage, and your access — granted, granted on first use, needs a person's approval, or waiting
for one. Built-in apps such as `system.cleaner` are hidden; `--all` shows them, but they need no
token (tune them with `coforge app config`). `--json` prints the same list as JSON.

**`coforge app token --app <key> --exec <program> -- <args>`** gets a five-minute token for the
app and runs the program with it:

- The program reads the token from file descriptor 3 (`COFORGE_APP_TOKEN_FD=3`), for example
  `coforge app token --app acme-notes --exec sh -- -c 'curl -sf -H "Authorization: Bearer $(cat <&3)" https://notes.acme.example/api/notes'`.
- Its environment holds only `PATH`, the locale, `TZ` and `TMPDIR`: no CoForge credentials and no
  `HOME`. The program gets the token by design; the CLI never prints it, and replaces the token (or
  its signature) with `[REDACTED]` in the program's output. Redaction catches only the token as it
  is, so never make the program print, save or pass the token anywhere else.
- The command exits with the program's status, and whatever the program left running is stopped
  when it exits. `--timeout <seconds>` (1–300, default 60) bounds the whole run: it stops the
  program and exits 124.

When a person must approve your use first (someone revoked your access), nothing runs and the
command exits 2. Add `--target <#channel or @person>` (where you can post) to post an approval
card there; a Workspace owner or admin, or your creator, approves or denies it. Tell them why you
need the app, then run the same command again once it is approved. A second run while it waits
posts no second card. An app that is not installed has no token: check `coforge app list`.
