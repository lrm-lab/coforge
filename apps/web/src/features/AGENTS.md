# Features modules

The module map of `src/features/`, split out of [`apps/web/AGENTS.md`](../../AGENTS.md#module-map). Each line names a directory under `src/` and its single responsibility. Update it before adding or reorganizing a module.

- `features/agents/` — Members page, Agent creation, profile panel, control buttons, and Agent status and Activity display.
- `features/app-authorization/` — Login with CoForge's page at `/oidc/auth`: the consent an app asks for, the Workspace picker, the refusals, its Continue/Cancel server function, the page's headers, and the GET (sealed query) and POST (form) adapters before the router.
- `features/apps/` — Settings → Applications (the Installed and My apps lists, the register/edit editor with its danger zone, a new secret shown once) and the client-safe rules for an app's input.
- `features/auth/` — the sign-in error page, the split shell of the pages before
  sign-in, `returnTo` handling, signing out (`signOut`) and the step `/` takes to resume sign-in
  after signing out to switch account, the first-sign-in name step (`/welcome`), and the auth middleware for server functions.
- `features/cache-persistence/` — the browser's copy of the Query cache in IndexedDB that Chat opens from (what is kept, per person, removed at sign-out).
- `features/computers/` — Computer list/detail, setup, and Runtime Usage.
- `features/conversations/` — channels, direct messages, threads, composer, message rendering, action cards, saved messages, and the sidebar lists.
- `features/device-auth/` — device-code verification page.
- `features/errors/` — page-level load-error view and the router's 404 page.
- `features/files/` — what a file is, from its name and media type: extension, size text, kind, preview kind and language, type label, and the icon it is drawn with (`FileTypeIcon`).
- `features/inbox/` — the Activity page: conversations and threads not yet marked Done, the viewer's pinned conversations above them, and the conversation a row opens beside the list (a thread's alone; full-screen below `lg` for an `open` link).
- `features/install/` — Computer install command text.
- `features/integrations/` — Settings → Integrations GitHub view and functions.
- `features/landing/` — the public homepage.
- `features/notifications/` — browser push lifecycle and in-page notifications.
- `features/panel-tabs/` — each member's saved panel tab order.
- `features/profiles/` — current-user profile read and update, and the one rule for a person's name (`person-name.ts`).
- `features/projects/` — Projects directory, project detail, file browser, and project settings page.
- `features/realtime/` — the one browser Centrifuge connection, and its status as the page shows it (`connection-status.ts`).
- `features/records/` — Workspace Records (see the last section).
- `features/settings/` — preference pages and device-local preferences, and what the request says
  about the browser for the server render (phone or desktop).
- `features/search/` — the Workspace search page (`search`): filters, matching channels, Agents and Computers, message results with their preview, and the browser-local search history and frequently used places.
- `features/tasks/` — Task board, list, overview, and message task actions.
- `features/workspaces/` — Workspace switcher and creation (the switcher dialog and the page a signed-in person in no Workspace lands on, `/workspaces/new`), the Workspace a page URL names (`/w/<slug>`) and the one each QueryClient last showed, member directory reads, member presence (`presence:workspace:<workspace_id>`), join links and the invite-link page (`/join/<token>`), human roles, the Settings → Workspace profile Danger zone (leave, or delete for its owner), leaving a page whose Workspace was deleted (`workspace.deleted.v1`), and the last page `/` returns to.
