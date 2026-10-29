# Approved setup identity models

`User` is the internal business subject with a stable UUID and required unique
internal `username`. Public user targets are `@${User.username}`; provider
subjects are never usernames. A username is a readable handle, not something a
person types: it starts with a letter, is 3 to 32 characters of `a-z 0-9 _ -`
with no `-` or `_` at either end (`apps/web/src/lib/username-grammar.ts`).
On first identity creation `UsernameAllocator`
(`apps/web/src/server/auth/username-allocation.server.ts`) takes the first of
these that yields a usable name: the Authing `preferred_username`, the email
local part without a `+tag`, the ASCII slug of the profile name, the ASCII slug
of the nickname, and finally `user`. At a QQ mailbox (`qq.com`, `vip.qq.com`,
`foxmail.com`) an all-digit local part is the QQ number and reads `qq<digits>`
(`971766802@qq.com` is `qq971766802`); anywhere else a name that starts with a
digit gets the prefix `u`. A name with a run of 11 or more digits, however
spaced or surrounded (it may be a phone number, which is never a username: the
handle is visible to the whole Workspace and to Agents), and a reserved word
are never used. A taken name gets the smallest free `-N`
(`N >= 2`); the unique index decides races, so the create is retried a bounded
number of times and ends with an 8-hex suffix. Accounts created before
letter-first allocation keep their existing names, some digit-first or ending in
an 8-hex suffix, and stay valid `@username` targets.

A new account's fallback username (`user`, `user-<n>` or `user-<8 hex>`: a
sign-in that told us nothing to name the person by, such as a phone-number
sign-up) is replaced once, at the first-sign-in name step, from the display name
being confirmed (`renameFallbackUsername`,
`server/auth/fallback-username-rename.server.ts`). It runs before the
enrollment transaction, so a personal Workspace whose URL comes from the
username uses the new one, and its update is conditional on `welcomedAt` being
null, so an account that has confirmed a name is never renamed. The name gives the
base by the same slug rule; each run of Chinese characters is written as
`pinyin-pro` pinyin without tones, syllables joined, `ü` as `v` (`安栋` is
`andong`, `张三 Tom` is `zhangsan-tom`), loaded only there, then the allocator
takes the smallest free `-N`. The rename is best effort: a name that yields
nothing usable, or any failure (logged without the name or the username), leaves
the username as it is and never affects the first sign-in. Existing accounts are
never renamed, at sign-in or otherwise: a handle that has been in a Workspace,
a message or an Agent's memory keeps pointing at the same person, and
`preferred_username` stays stable for Login with CoForge apps. Messages and
mentions carry the person's id (`<@human:uuid>`); the `handle`, `targetHandle`
and `actorName` columns of `MessageMention`, `PendingMentionAction` and
`TaskHistoryEvent` are snapshots of the handle. The signed session cookie keeps
the username it was issued with until the next sign-in; it is only an echo and
never a lookup key.
`UserIdentity` maps
an external provider and subject to that User; provider subjects are never
business foreign keys. Membership, Agent ownership, and Computer ownership use
the internal User UUID. Existing rows are backfilled by the migration before
the legacy external column is removed. `User.email` is the latest email the
identity provider reported at login, nullable, not unique, not an identity key.
An account registered with a phone number alone has none and signs in like any
other; the signed session and every consumer of it treat the email as optional.
`User.phone` is the latest phone number the provider reported and says it
verified, in E.164 (`+8613800138000`), on the same terms: nullable, not unique,
never a way to sign in or to link two accounts. Two numbers are left out: one
this platform cannot itself use as a code destination (a provider's foreign
number), and one the provider does not report as verified, since a number a
person typed into their own account must never match someone else.

`User.displayName` is the one name teammates see, and it is required, as Slack
requires a name: an account is created with the name its sign-in provider
reported (`initialDisplayName`: the provider's name, else its nickname, else the
email's local part, each only when it reads as a name; else `Unnamed`), never
its username. `User.welcomedAt` records when the person finished first sign-in;
`null` means not yet. A signed-in person who has not is sent once to
`/welcome` (a page outside the Workspace layout), from sign-in, from
`/w/<slug>`, from `/workspaces/new` and from an invite link `/join/<token>`, but
not from `/oauth/verify`. Sign-in still issues the session, but creates nothing
until they answer. The same page asks for their personal Workspace's URL
(slug), starting from the username unless that is only the fallback `user…`;
submitting locks that User and commits the Workspace, name and `welcomedAt` in
one transaction, so concurrent tabs share the first accepted name and a URL found
taken rolls back confirmation. A person who arrives from a working invite link
(the server checks the link, never the client) is asked for the name only: the
same lock commits just the name and `welcomedAt`, no Workspace is made, and
joining the invited Workspace is their way in. If they never join, they have a
name and no membership; later sign-ins never make a Workspace for them, and they
are offered "create your first Workspace" like anyone in none. Cloud Computer and assistant provisioning follow
the commit; failures leave enrollment intact. When the owner opens the Workspace,
`loadWorkspaceSwitcher` repairs missing Memory Agent and assistant identities and
retries pending cloud provisioning through platform-assistant onboarding. Existing
Memory Agent links, including archived identities, remain intact. A retained Memory
Profile prevents reopening from recreating a deliberately deleted identity. Weekly
assistant binding retries accept only the owner's live default cloud Computer.
A session whose user row is gone is sent to sign in again instead. The name follows the one rule for a person's name
(`apps/web/src/features/profiles/person-name.ts`), which the profile's own name
shares: normalized and 1 to 80 characters, counted as code points, and refused
when it holds control, bidirectional or only invisible characters, is the
server's sender label `System`, or starts with `@`. The first name saved at
first sign-in stays: a second submit changes nothing and returns the memberships
as they are. The signed session's `name` is only what the provider reported (its
name, else its nickname), kept to start the name field (left empty when it is a
phone number or an email).

`humanLabel` in `apps/web/src/lib/human-label.ts` is the one rule for that label
(`displayName`; a blank one reads as `Unnamed`, never the username), in
messages, member lists, mentions, reactions, notifications, and the signed-in
user's own shell. No screen shows a person's
username, except the `@` list beside two people whose label and description are
identical, where nothing else tells them apart. It is the handle Agents use in
`@mentions`; a search never finds a person by it. The Workspace directory that the Search page and the
pickers load carries a person's label, never the username, and the Members
directory lists people by label. An Agent's `@handle` stays visible. Settings →
Account edits `displayName` (required) by that one rule; a name it refuses is
worded inline where it is typed.

`User.description` stores the editable profile description. The optional
`avatarObjectKey` and `avatarContentType` identify the user's current private
avatar in the shared user-files store; image bytes and delivery URLs are never
stored in PostgreSQL. Replacing an avatar writes a new immutable object before
the row points to it, then removes the previous object. A user who picks one of
the platform's preset pictures, four cartoon people (`person-1` to `person-4`),
stores `preset:<id>` in `avatarObjectKey` with a null `avatarContentType`: it names
no object and resolves to the app's own `/avatars/<id>-<version>.webp`. A user with
no avatar (null key), or whose preset this build does not ship, shows the cartoon
person a stable hash of their user id chooses (`personAvatarUrl`, `src/lib/person-picture.ts`); nothing
is stored for that, and every user avatar URL the server returns to the browser
is therefore never null. Login with CoForge's `picture` is the same person as an
absolute URL on the issuer; it is absent only for an upload on a deployment
without an image CDN. The thirty portrait photos (`portrait-01` to `portrait-30`) were
retired by migration `20261024130000_avatar_cartoon_people`, which rewrote
`preset:portrait-NN` to `preset:person-((NN - 1) % 4 + 1)`; uploaded photos were
left alone. An `Agent` has no uploaded picture: its nullable
`avatarMascot` holds the key of the platform mascot its creator picked (one of
seven, validated at the server boundary); null shows the mascot its id chooses.
Migration `20261024150000_drop_agent_avatar_columns` dropped its former
`avatarObjectKey` and `avatarContentType` columns.

Setup persistence consists of `User`, `UserIdentity`, `Workspace`,
`WorkspaceMembership`, `Computer`, and `WorkspaceComputer`.
`WorkspaceMembership.role` is `owner`, `admin`, or `member`. The Workspace creator
is the immutable owner. Only the owner changes the Workspace's slug (its URL); the
slug it had goes into `WorkspaceFormerSlug`, which keeps naming that Workspace for
good: `/w/<former>` redirects to the current slug, `workspace:get` and
`computer:register` resolve it, and no other Workspace can take it. One advisory
lock per slug serializes creating a Workspace and moving one, since uniqueness
spans both tables. `WorkspaceComputer`
is the durable binding and contains the workspace/computer foreign keys. Its
database `id` is an internal storage primary key; the business identity is the
composite `(workspaceId, computerId)` key. That unique constraint makes
repeated setup converge on the same binding. `DaemonApiKey` stores only the
hash of the long-lived, revocable Daemon API key, its owner, and its
Workspace/Computer binding; the plaintext key is returned once and persisted
only in the native credential store. A key is valid only while its owner is a
member of its Workspace; leaving or being removed revokes the keys the person
owns there and removes their Computers' `WorkspaceComputer` links to it.

`AgentApiKey` stores only the SHA-256 `apiKeyHash` plus its Agent, Workspace,
owner, and Computer binding; plaintext `sk_agent_...` values are returned once
and never persisted. Key creation locks the owning Agent row with PostgreSQL
`FOR UPDATE`, revokes all active keys for that Agent, and inserts the replacement
inside one transaction. Exact-key revocation remains idempotent.

The repository must use database `upsert` operations and explicit unique-conflict
handling, never placeholder UUID rows. Concurrent requests may both reach the
upserts, but PostgreSQL uniqueness ensures one Computer and one
WorkspaceComputer binding; a deployment with stronger all-or-nothing behavior
may wrap the operations in a transaction. Token issuance occurs after the
durable binding is found or created, so an API-key creation failure is safely
retryable.
