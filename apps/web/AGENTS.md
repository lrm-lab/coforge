# Web application instructions

These rules apply to `apps/web`, the TanStack Start Web/backend modular monolith, and refine the repository-level `AGENTS.md`. Directory-specific rules live in nested `AGENTS.md` files listed at the end.

## Product design

- Before designing or changing product UI, read and follow [the product design guidance](../../docs/design/README.md). It is the single design document for `apps/web`; colors and fonts live in [design tokens](../../docs/design-tokens.md). Do not create another design or UI-guideline document; change `docs/design/` instead.
- For list/detail pages and empty states apply sections 2.1–2.2 and 5.1, and run the checklist and acceptance checks in section 6. State why a different user task requires an exception before implementing one; do not treat existing pages as automatic exceptions.
- Hard rules for every UI change (details in `docs/design/`):
  - Mockups: a provided mockup wins over the defaults in `docs/design/`; implement it with the components and units below and update the conflicting rule in the same change. Ask before inventing data or concepts the mockup shows but the product lacks (§1).
  - Components (product UI; `features/landing` keeps its Spell / Magic UI motion components): only official Untitled UI components, unmodified, and the primitives listed in `components/ui/README.md`, per §7 including its exceptions. Icons only from `@untitledui/icons`; a file's type glyph from `@untitledui/file-icons`, reached only through `features/files/file-type-icon.tsx`; vendor logos from `@lobehub/icons-static-svg`, or the vendor's own vector mark kept beside its user with its source noted in the file.
  - Sizes: anything affecting layout or reading uses rem — the Tailwind scale or a rem arbitrary value such as `w-[18rem]`; never `w-[280px]`, `text-[10px]`, or numeric inline `style` sizes. px only for hairlines, stroke widths, shadows/blur, and positions and sizes measured from the DOM (§12).
  - Colors: semantic tokens only, no hex or `dark:` color overrides (§11).
  - People: show a person by `humanLabel` (`src/lib/human-label.ts`), never as `@username`, and do not search by username; an Agent keeps its `@handle`.
  - Feedback: a toast only confirms an action; anything the user must see, handle, or come back to stays inline (§13). Toasts go through `AppToastProvider`; do not add a second notification system.
- Do not apply marketing-page defaults from `design-taste-frontend` to the product workspace.
- Keep supplemental explanations behind accessible, on-demand help when appropriate; keep essential constraints, errors, and risks visible. Help must work for keyboard and touch users.
- Loading placeholders and local load errors belong to the feature whose content they represent (for example `features/agents/agents-pending.tsx`); routes select them, and `components/ui/skeleton.tsx` supplies decorative styling only.
- Derive a slug from a display name with `src/lib/slug.ts`, as Project and Workspace creation do.

## TanStack Start boundaries

Runtime, file-naming and import-protection mechanics are in [web runtime](../../docs/agents/web-runtime.md).

- This app uses TanStack Start, not Next.js. Do not add `app/`, `pages/`, `getServerSideProps`, `getStaticProps`, or `"use server"` directives.
- Follow the TanStack guidance listed in the repository-level `AGENTS.md` before changing routing, data loading, Server Functions, middleware, authentication, SSR, or code splitting.
- Keep `src/server.ts` limited to request middleware and the Start server handler; boot-time work belongs to a Nitro plugin, and long-lived handles register their stop with `onServerShutdown`.
- Use a Server Function (`createServerFn`) for data and mutations called by the Web UI. Put the public function at the owning feature seam, for example `src/features/agents/agents.functions.ts`.
- Follow TanStack Start's file naming: `.functions.ts` for `createServerFn` wrappers, `.server.ts` for server-only code, and no suffix for client-safe code. Everything under `src/server/` is server-only and denied in the client build; code the browser also needs lives in `features/` or `src/lib/`.
- Import through `#src/`; rewrite Untitled UI's CLI `@/` imports to `#src/` when adding a component.
- Route loaders may call Server Functions, but must not access a database, filesystem, secret, or server-only SDK directly. Do not self-fetch a relative `/api/...` URL from an SSR loader.
- Validate Server Function inputs and enforce authorization on the server. Router `beforeLoad` guards improve navigation UX but are not a security boundary.
- Use a Server Route under `src/routes/api/` only when the raw HTTP contract is part of the product (webhooks, third-party REST clients, feeds, file responses). Do not create an API route just to serve data to a page. A raw route stays a thin adapter over the owning server module, which enforces authorization.
- Use TanStack `Link`, `useNavigate`, and typed route APIs for internal navigation. Use ordinary anchors only for external URLs or intentional document downloads.
- Put shareable filters, pagination, sorting, and tabs in validated route search params. Keep ephemeral UI state such as an open Dialog in React state unless it must be deep-linkable.
- When a mutation changes loader data, await it, then call `router.invalidate({ sync: true })` if the next UI step needs fresh data. Chat sidebar and Tasks page changes are TanStack DB optimistic actions instead (see `src/features/conversations/AGENTS.md`, `src/features/tasks/AGENTS.md`).
- Preserve TanStack Router inference. Do not add casts or unnecessary type annotations to route params, search, loader data, or navigation options.
- Keep feature modules out of the shared layout unless genuinely required on every page. Check production chunk output after adding a large feature or dependency: every chunk a route needs needs a `modulepreload` link, or it loads in a request waterfall.

## PostgreSQL and Prisma

- Prisma is the Web/backend database standard. Use the repository's Prisma skills for CLI, Client API, database setup, and upgrades before changing database code.
- Keep the Prisma schema, generated client usage, repositories, and migrations on the server side. UI routes and feature components call a Server Function or server module instead of importing Prisma.
- A migration that locks or rewrites an existing table, or does anything the migration safety check does not recognise, needs the check's annotation and a session-level `SET lock_timeout`; the `migration-safety` hard rule and the deploy gate enforce it ([migration safety](../../docs/agents/git-hooks/migration-safety.md)).
- Keep `prisma`, `@prisma/client`, and the PostgreSQL driver adapter on the same supported major version, pinned by the workspace lockfile. Use the repository's Bun-compatible Prisma setup rather than an alternate database client.
- Primary keys are generated by the Prisma client as time-ordered UUIDv7: `@default(uuid(7))`. Do not pass an explicit `id` at create time — including `createMany` and repository-facing mint inputs. Never let new rows depend on bare `uuid()`/`randomUUID()`. Raw-SQL INSERTs get no generated id, so they must supply it.
- Historical rows keep their v4 ids, so id order is not meaningful across the v4→v7 switch: do not sort or paginate by `id` over pre-existing data; order by the table's domain keys (`createdAt`, `sequence`, …).
- Use PostgreSQL for database-semantic tests; do not silently substitute SQLite.
- Read the database URL and credentials from runtime environment/secret injection. Local development uses the project's Docker PostgreSQL; managed PostgreSQL changes must not leak provider-specific details into domain code.

## Module map

Each line names a directory under `src/` (unless noted) and its single responsibility.

- `routes/` — URL ownership and route lifecycle; `routes/api/` raw HTTP routes.
- `components/` — `base/`, `application/` and `shared-assets/` official Untitled UI source (`shared-assets/` holds the backgrounds and illustrations `EmptyState` draws), `ui/` sanctioned primitives, `layout/` app chrome, `foundations/` logos and icons, `spell/` and `magicui/` landing-page motion.
- `lib/` shared browser capabilities and pure helpers; `hooks/` shared React hooks; `utils/` Untitled UI class helpers.
- `prisma/` (app root) — schema and migrations; `messages/` — UI translations.
- `features/` — product feature modules, one line each in [`src/features/AGENTS.md`](src/features/AGENTS.md).
- `server/` — server-only modules, one line each in [`src/server/AGENTS.md`](src/server/AGENTS.md).

## A changed file ends without a blank line

One trailing blank line fails CI's `Plan checks`; no package `check` looks for it. Reproduce what CI sees with `git diff --check origin/main...HEAD`. See [web runtime](../../docs/agents/web-runtime.md#the-trailing-blank-line).

## Nested rules

- Module map of `src/features/` → [`src/features/AGENTS.md`](src/features/AGENTS.md)
- Module map of `src/server/` → [`src/server/AGENTS.md`](src/server/AGENTS.md)
- Rules for `prisma/` → [`prisma/AGENTS.md`](prisma/AGENTS.md)
- Rules for `src/routes/` → [`src/routes/AGENTS.md`](src/routes/AGENTS.md)
- Rules for `src/components/` → [`src/components/AGENTS.md`](src/components/AGENTS.md)
- Date and time rules for all of `apps/web` (Temporal, `Intl`, `useHydrated`) → [`src/lib/AGENTS.md`](src/lib/AGENTS.md)
- Rules for `src/features/agents/` → [`src/features/agents/AGENTS.md`](src/features/agents/AGENTS.md)
- Rules for `src/features/cache-persistence/` → [`src/features/cache-persistence/AGENTS.md`](src/features/cache-persistence/AGENTS.md)
- Rules for `src/features/computers/` → [`src/features/computers/AGENTS.md`](src/features/computers/AGENTS.md)
- Rules for `src/features/conversations/` → [`src/features/conversations/AGENTS.md`](src/features/conversations/AGENTS.md)
- Rules for `src/features/landing/` → [`src/features/landing/AGENTS.md`](src/features/landing/AGENTS.md)
- Rules for `src/features/panel-tabs/` → [`src/features/panel-tabs/AGENTS.md`](src/features/panel-tabs/AGENTS.md)
- Rules for `src/features/projects/` → [`src/features/projects/AGENTS.md`](src/features/projects/AGENTS.md)
- Rules for `src/features/realtime/` → [`src/features/realtime/AGENTS.md`](src/features/realtime/AGENTS.md)
- Rules for `src/features/tasks/` → [`src/features/tasks/AGENTS.md`](src/features/tasks/AGENTS.md)
- Rules for `src/server/agents/` → [`src/server/agents/AGENTS.md`](src/server/agents/AGENTS.md)
- Rules for `src/server/centrifugo/` → [`src/server/centrifugo/AGENTS.md`](src/server/centrifugo/AGENTS.md)
- Rules for `src/server/computers/` → [`src/server/computers/AGENTS.md`](src/server/computers/AGENTS.md)
- Rules for `src/server/hosts/` → [`src/server/hosts/AGENTS.md`](src/server/hosts/AGENTS.md)
- Rules for `src/server/conversations/` → [`src/server/conversations/AGENTS.md`](src/server/conversations/AGENTS.md)
- Rules for `src/server/db/` → [`src/server/db/AGENTS.md`](src/server/db/AGENTS.md)
- Rules for `src/server/integrations/` → [`src/server/integrations/AGENTS.md`](src/server/integrations/AGENTS.md)
- Rules for `src/server/notifications/` → [`src/server/notifications/AGENTS.md`](src/server/notifications/AGENTS.md)
- Rules for `src/server/projects/` → [`src/server/projects/AGENTS.md`](src/server/projects/AGENTS.md)
- Rules for `src/server/release-catalog/` → [`src/server/release-catalog/AGENTS.md`](src/server/release-catalog/AGENTS.md)
- Rules for `src/server/reminders/` → [`src/server/reminders/AGENTS.md`](src/server/reminders/AGENTS.md)
- Rules for `src/server/tasks/` → [`src/server/tasks/AGENTS.md`](src/server/tasks/AGENTS.md)
- Rules for `src/server/workspaces/` → [`src/server/workspaces/AGENTS.md`](src/server/workspaces/AGENTS.md)
- Rules for Records (`src/features/records/`, `src/server/records/`) → [`src/features/records/AGENTS.md`](src/features/records/AGENTS.md)

## Workspace memory modules

Dependencies point downward. Routes and background entrypoints assemble these modules; they do not own profile transitions or OpenViking HTTP details. The write path (peer, two-phase commit, crash redrive, offer echo stripping) is [OpenViking channel memory](../../docs/memory/openviking.md).

- `workspace-memory/` — profile (`off | openviking`), generation fencing, Admitted PublicChannel Segment detection, one-sink dispatch, the Memory Agent route, Memory Offers, citation policy, and the cleanup a Workspace deletion runs (`cleanup.server.ts`, and `cleanup-remotes.server.ts` for the remotes it calls). It does not import OpenViking HTTP paths.
- `openviking/` — typed account/user/ACL provisioning, the deny-by-default route catalog, `OpenVikingPolicyGateway`, the private runtime client, and Memory Agent read shaping. It does not own profile transitions.
- `db/repositories/workspace-memory-*.server.ts` and `openviking-binding.repositories.server.ts` — Prisma adapters. Credential plaintext does not belong in ordinary business tables.
