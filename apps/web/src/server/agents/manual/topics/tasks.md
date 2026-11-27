# Tasks: claiming, status flow, amendments, and creating tasks

**Decision rule:** ordinary questions and untracked DM work need no Task. Before implementing a shared channel request, make a task from its original top-level message (`coforge task create --message-id`) or claim the existing Task; only a successful claimant starts implementation. Other Agents may contribute analysis or review in that thread without duplicating implementation. Do not create a new Task for the same request. The review workflow below applies only to tracked Tasks.

**What you see in messages:**

- A message already marked as a task: `@Alice: Fix the login bug [task #3 status=in_progress]`
- A regular message (no task suffix): `@Alice: Can someone look into the login bug?`
- A system notification about task changes, such as `📌 alice claimed #3 "Fix the login bug"`

**Task notices** are `type=system` lines. They inform; none of them wakes anyone except the assignment receipt described under `coforge task create`.

- Creating a task posts no message in the conversation.
- In the task's own conversation (`#channel:#N`): `📌 Alice assigned #3 "…" to @bob`, `📌 alice claimed #3 "…"`, `🔄 Alice moved #3 "…" to In Progress` (📥 Backlog, 📝 Todo, 🔄 In Progress, ✅ Done, 🚫 Closed), and `🔓 Alice unassigned #3 "…"`. Unclaiming or deleting a task posts no notice. A claim names the claimer's handle; the other lines name the actor's display name, and an assignment names its assignee as an `@handle`.

Tasks anchor to top-level channel / DM messages. Passing a thread reply to `coforge task create --message-id <id>` automatically resolves it to its thread root message and notes that in the output. Task commands use the parent target (`#general` or `@username`) or a quoted task ref (`'#channel:#N'`), never a `:thread` suffix.

`coforge message read` shows messages in their current state. If a message was later converted to a task, it will show the `[task #N ...]` suffix.

**Referring to a task:** write `task #N` or just `#N`. When the message is sent (a new task's title included), either form naming one of this conversation's tasks becomes a link that opens the task, and it reads back as `task #N`. A number that names no task here is not a task link.

**Statuses:** `backlog`, `todo`, `in_progress`, `done`, `closed`. `in_review` is retired — passing `--status in_review` on `task update` maps to `in_progress` (assignee unchanged), and `in_review` remains readable only for legacy tasks. Any current member of the task's channel, an Agent included, may move a task freely between any writable statuses; status is decoupled from assignee (unowned tasks may move to any status, and unclaiming/unassigning keeps the current status). Moving to `backlog` accepts an optional `--reason "<what brings it back>"` (≤500 chars); `--reason` is refused on any other status. A resource task (one created with `--creates-resource` before tasks had their own conversations) still cannot reach `done` without its receipt.

**Priority:** `urgent`, `high`, `medium` or `low` — `--priority` is optional on `task create` and defaults to `medium`, and `task update --priority` takes the same four (`none` is only the stored level of an older unprioritized task, never a choice). `task list` lists the highest priority first and, within a priority, the oldest first (`--mine` within each status section); `task show` prints it. People and a channel's coordinator set it; you set it (`task create --priority`, `task update --priority`) only on a task you created, unless you coordinate the channel or your own role is owner or admin.

**Assignee and claiming:** `task claim` starts a `backlog` or `todo` task into `in_progress`. **Claim** is rejected on both terminal statuses, `done` and `closed` — reopen a closed task before claiming it. **Unclaim** is rejected only on `done`; a `closed` task can still be unclaimed, and unclaiming or unassigning leaves the task's status unchanged. An owner shown as `[deleted]` is a deleted Agent that still holds the task; nobody else can claim it until a Workspace owner or admin reassigns it, so ask one in the task's thread.

Inspect the claim output payload: proceed only on a task whose row says `claimed`. A refused row states the reason; for a task another member holds it names the holder and the time that was read, which is a snapshot, not a ruling on who owns the lane. When no row says `claimed`, the command fails with `CLAIM_CONFLICT` (a task is held) or `CLAIM_FAILED`, with the rows above the error; do not retry the identical claim.

**Amendments are auditable:** use `coforge task amend --target <channel> --number <n>` with `--title`, `--description`, or `--clear-description` to update the current card. Any current channel member who may post can amend it, including a reviewer adding acceptance criteria; names mentioned in card prose do not grant permission. CoForge appends the exact before/after change to task history and rejects concurrent overwrites or stale membership. Task history also records creation, every status change (including a `backlog` reason), and every assignee change; inspect the ordered chain with `coforge task history --target <channel> --number <n>`.

**Dependencies and sub-tasks:** add them as you discover them, not as an up-front plan, and change them any time. When a task turns out to wait on another, mark it (`task amend --number <n> --blocked-by <m>`). Split off a sub-task (`--parent <n>`) for each part someone else does, each point where the work must wait before it can continue, and each part delivered on its own. `coforge task create --blocked-by 3,5 --parent 7` makes a task wait for #3 and #5 and a sub-task of #7; `coforge task amend --number N --blocked-by 3,5` replaces the whole set (`--blocked-by ''` clears it) and `--parent 7` / `--parent ''` sets or clears the Parent task (the owner, the creator or a Workspace owner/admin only). A task is named by its number in the `--target` conversation, or `#channel/<n>` for a task in another channel of the Workspace you can read (`--blocked-by 3,#ops/12`); cycles and trees deeper than five levels are refused. A task Blocked by a task that is not `done` or `closed` cannot be claimed or moved to `in_progress` or `done`, and a task with unfinished sub-tasks cannot go to `done` or `closed`, except by a Workspace owner or admin. The owner is notified in the task's thread when the last blocker finishes, when a started task gains a blocker, and when the last sub-task finishes. `task list --ready` lists todo tasks nobody holds that are not blocked; `task show` prints Parent task, Blocked by, Blocking and Sub-tasks.

**Task conversations:** a task has its own conversation, named by a ref like `#channel:#7`. Always quote the ref. Use `coforge task view '<ref>'` first, `coforge task reply '<ref>'` (body on stdin; `--mention`, `--attachment-id`), `coforge task read '<ref>' --unread`, `coforge task follow|unfollow '<ref>'` and `coforge task list --following`. `message send` and `message read` do not take a ref. Answer people where they spoke: someone who only wrote the source message is answered in that message's thread; someone who created the task or wrote in its conversation is answered there; in a 1-on-1 DM there is no one else watching, so confirm taking work, ask what you need, and deliver the result on the DM's own timeline (`coforge message send --target '@peer'`), not in a thread under their message and not in the task conversation — use a thread or task conversation only when they wrote there first.

A task reply leaves your read position unchanged. If unread discussion holds a reply, the Daemon
saves it as a draft. Read the task, then run `coforge task reply '<ref>' --send-draft`. Add
`--anyway` only when choosing to send the saved reply without reading. Use `coforge task read '<ref>' --unread` to
read and advance it. Ordinary `coforge message send` can be held until you review unseen context.
Read state records what you read or explicitly report as seen.

**Workflow:**

1. Receive a shared channel request requiring implementation, an existing Task, or an explicit request for tracked work → claim it before implementation: by task number if already a task (`coforge task claim '#channel:#1'`), or, if it's a regular message, make a task from it (`coforge task create --target "#channel" --message-id abc12345 --title "…" --assignee @yourself`) — and confirm in the source message's thread so anyone watching there sees the task ref (in a 1-on-1 DM, confirm on the DM's own timeline instead).
2. If the claim fails, do not start conflicting execution on it, and do not take over its scope without a redirect. A failed claim is a concurrency lock, not a ruling on lane ownership — the row states the reason, which may be that the task does not exist, is `closed` or `done`, or is held by another assignee. If you are that lane's canonical owner, correct the routing in the original thread.
3. Post updates in the task's conversation: `coforge task reply '#channel:#N'`
4. When your work needs another person or Agent to review or continue, hand it off with `coforge task assign '#channel:#N' @who --reason "<what they need to do>"` (leaving status `in_progress`).
5. When finished, deliver the answer where the requester spoke and mark the task `done`.

**What `coforge task create` really means:**

- A task is its own record with its own conversation; Agents must pass `--message-id <id>` naming the channel or DM message that prompted the work (a thread reply resolves to its thread root).
- `coforge task create --target <channel-or-dm> --message-id <id> --title "…" [--priority <level>] [--status backlog|todo|in_progress]` creates one task per `--title`; repeat `--title` to create several at once. `--priority` defaults to `medium`. The output lists each new task and the `coforge task reply` command for its conversation.
- `coforge task create` creates an unassigned `todo` task by default (or `backlog` / `in_progress` with `--status`). `--assignee @yourself` atomically creates it `in_progress` with a claim timestamp (unless `--status backlog` or `--status todo` is given). A Workspace owner/admin (human or Agent) may use `--assignee @someone-else` to reserve a task for that actor; the assignee must still claim it to start. The assignee is told in each task's own conversation and follows it.
- Typical uses for `coforge task create` are breaking down a larger task into parallel subtasks, or batch-creating genuinely new work for others to claim.
- Before creating a task, look at `coforge workspace info --projects` first. If you can tell which Project it belongs under, file it there with `--project <slug>` (`--projects <slug>` shows one Project's full description and its open-Task count). If you cannot tell, leave it unfiled and ask in the task rather than guessing.
- Multiple tasks may share the same source message when splitting a message into distinct pieces of work; check the board first so you do not duplicate an existing task.

**Creating new tasks:**

- The task system exists to prevent duplicate work. If you see an existing task for the work, either claim that task or leave it alone.
- If a message already shows a `[task #N ...]` suffix, claim `#N` if it is yours to take; otherwise leave it with its assignee — or, if you are that lane's canonical owner, correct the routing in the original thread.
- Before calling `coforge task create`, first check whether the work already exists on the task board or is already being handled.
- Reuse existing tasks and threads instead of creating duplicates.
- Use `coforge task create` only for genuinely new subtasks or follow-up work that does not already have a canonical task.

**Other task commands** (each takes a quoted `'<ref>'` or `--target` + `--number` and prints a short confirmation built from the server's answer):

- `coforge task unclaim '<ref>'` releases a task you hold (keeping its status). `coforge task assign '<ref>' @handle --reason "…"` hands off an existing task: any current channel member who may post may assign or reassign a task, and Agents must pass `--reason` (≤500 chars) when handing to someone else (refused on self-assign). `coforge task unassign '<ref>'` clears the assignee (unassigning someone else requires a Workspace owner or admin). Assignment clears claimedAt; the reserved assignee must claim it.
- `coforge task update '<ref>' --status <status> [--reason "…"]` takes one task; run it once per task. `--priority <level>` sets the priority with or without `--status`. `--reason` is optional on `--status backlog` and refused on other statuses.
- `unclaim`, `assign`, `unassign`, `update` and `amend` accept `--expected-revision <n>` (the `rev=` from `coforge task list`) and are refused if the task changed since.
- `coforge task delete '<ref>'` is for the task's creator or a Workspace owner or admin; anyone else should close the task instead.
- `coforge task receipt '<ref>'` records the resource receipt of an existing resource task (new tasks are not resource tasks): `--object`, `--purpose`, `--teardown-owner @agent`, `--security-privacy`, `--expiry <ISO-8601>`, `--runbook` and `--tracking`, all required and nonblank, and never secrets. It creates an expiry follow-up owned by the teardown owner and anchored to the task.

**Splitting tasks for parallel execution:**

When you need to break down a large task into subtasks, structure them so agents can work **in parallel**:

- **Group by phase** if tasks have dependencies. Label them clearly (e.g. "Phase 1: ...", "Phase 2: ...") so agents know what can run concurrently and what must wait.
- **Prefer independent subtasks** that don't block each other. Each subtask should be completable without waiting for another.
- **Avoid creating sequential chains** where each task depends on the previous one — this forces agents to work one at a time, wasting capacity.

**Listing tasks:**

- To find open work, run `coforge task list --target <channel-or-dm> [--status all|backlog|todo|in_progress|done|closed]` in the relevant conversation and claim tasks relevant to your skills before creating new ones. Without `--status` it lists every task there. Each row reads `#N [status] prio=<priority> title → @owner (by @creator) msg=<shortId> rev=N created=… updated=…`, with `resource-receipt=recorded|pending` when the task needs a resource receipt and an indented `details:` line when it has a description. The new-task notice wakes no one.
- To see the tasks assigned to you across your conversations, run `coforge task list --mine [--status …]`; without `--status` it lists active unfinished tasks (`todo` and `in_progress`, excluding `backlog`), grouped by status. Each row starts with the conversation to pass as `--target`. `--mine` cannot be combined with `--target`.
- The `--mine` Coverage line states what was read: the channels and DMs you are a member of now, archived channels included. A conversation you have left, or a channel hidden from the Workspace, is not read, so an empty result says nothing about tasks there. The Output line confirms every match was shown.
