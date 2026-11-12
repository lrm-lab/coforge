import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Labels } from "#src/server/tasks/labels.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
  pickTaskPriority,
} from "./helpers/browser-e2e";

/**
 * The one Task board (task #596) on a Project's Tasks tab and on All tasks, with one realistic
 * Project seeded — two channels, three people, labels, priorities, sub-tasks, a blocked Task, a
 * Task in the viewer's DM — and an empty Project with a very long name. Sub-tasks are their
 * parent's progress, not cards; the DM Task is on All tasks. Screenshots at desktop (light, dark)
 * and phone. The run's Projects, conversations and people are removed after it; the labels stay
 * (the Workspace keeps a label once made).
 * Screenshots are written under `.amp/e2e/project-board/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/project-board");

test("a Project's board and All tasks show top-level Tasks as cards, the viewer's DM Task included", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `project-board-${process.pid}`);
  const board = new TaskBoard(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}`.slice(-5);
  const project = await db.project.create({
    data: {
      workspaceId,
      name: "Spring launch",
      slug: `spring-launch-${tail}`,
      description: "Ship the new site and the onboarding flow by April 20.",
    },
  });
  const empty = await db.project.create({
    data: {
      workspaceId,
      name: `River 2.0 工具型 Agent 的端云协同与离线推理能力建设和全链路评测体系 ${tail}`,
      slug: `river-${tail}`,
    },
  });
  const people = await Promise.all(
    [
      ["lin", "Lin Xia"],
      ["dax", "Dax Moreno"],
      ["ines", "Ines Okafor"],
    ].map(([handle, displayName]) =>
      db.user.create({ data: { username: `${handle}-${tail}`, displayName: displayName! } }),
    ),
  );
  for (const person of people)
    await db.workspaceMembership.create({ data: { workspaceId, userId: person.id } });
  const everyone = [DEV_BROWSER_USER.id, ...people.map((person) => person.id)];
  const channel = (name: string) =>
    db.conversation.create({
      data: {
        workspaceId,
        channelName: `${name}-${tail}`,
        description: "",
        members: { create: everyone.map((userId) => ({ userId })) },
      },
    });
  const site = await channel("site");
  const ops = await channel("ops");
  // The viewer's DM with Lin: its Tasks show on All tasks to the two of them only.
  const dm = await db.conversation.create({
    data: {
      workspaceId,
      directKey: peopleDirectKey(DEV_BROWSER_USER.id, people[0]!.id),
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { userId: people[0]!.id }] },
    },
  });
  // Has no Task yet, so only a list of everyone offers them on the board (task #621).
  const assignAgent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-board-agent-${process.pid}`,
      displayName: `Board Agent ${process.pid}`,
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  // A Task's comments are its own conversation's messages, which Tasks v2 makes.
  const experiments = new PrismaExperimentsRepository(db);
  const before = (await experiments.read(workspaceId)).taskConversations;
  await experiments.write(workspaceId, "taskConversations", true);
  const centrifugo = createCentrifugoServerApi();
  const talk = new TaskConversations({
    db,
    reader: "people",
    dependencies: {
      publisher: centrifugo,
      realtime: new CentrifugoConversationRealtime(centrifugo),
    },
  });
  try {
    const labels = new Labels(db);
    const as = DEV_BROWSER_USER.id;
    for (const [name, color] of [
      ["Design", "pink"],
      ["Copy", "blue"],
      ["Infra", "purple"],
      ["Research", "success"],
    ] as const)
      await labels.create(workspaceId, as, { name, color });
    const [lin, dax, ines] = people.map((person) => `user:${person.id}`);
    const me = `user:${DEV_BROWSER_USER.id}`;
    const run = (conversationId: string) => async (command: Record<string, unknown>) =>
      (
        await board.execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
          idempotencyKey: crypto.randomUUID(),
          conversationId,
          ...command,
        } as Parameters<TaskBoard["execute"]>[1])
      ).tasks[0]!;
    const inSite = run(site.id);
    const inOps = run(ops.id);
    type Seed = {
      title: string;
      status?: "todo" | "in_progress" | "in_review" | "done";
      priority?: "urgent" | "high" | "medium" | "low";
      labels?: string[];
      assignee?: string;
      steps?: { title: string; done?: boolean }[];
      blockedBy?: { number: number }[];
      comments?: number;
      where?: typeof inSite;
    };
    const seed = async ({
      where = inSite,
      steps = [],
      status,
      priority,
      comments = 0,
      ...task
    }: Seed) => {
      const made = await where({ operation: "create", project: project.slug, ...task });
      for (let at = 0; at < comments; at++)
        await talk.reply(
          { workspaceId, userId: DEV_BROWSER_USER.id },
          { conversationId: made.conversationId, number: made.number },
          { idempotencyKey: crypto.randomUUID(), body: `Note ${at + 1}`, mentions: [] },
        );
      for (const step of steps) {
        // A Task past To do needs an owner.
        const child = await where({
          operation: "create",
          title: step.title,
          parent: { number: made.number },
          ...(step.done && { assignee: `user:${DEV_BROWSER_USER.id}` }),
        });
        if (step.done) await where({ operation: "update", number: child.number, status: "done" });
      }
      if (status) await where({ operation: "update", number: made.number, status });
      if (priority) await where({ operation: "update", number: made.number, priority });
      return made;
    };
    const steps = (total: number, done: number) =>
      Array.from({ length: total }, (_, index) => ({
        title: `Step ${index + 1}`,
        done: index < done,
      }));
    await seed({
      title: "Draft the onboarding emails",
      comments: 1,
      labels: ["Copy"],
      assignee: lin,
      steps: steps(4, 0),
      priority: "medium",
    });
    await seed({
      title: "Audit the pricing page copy",
      labels: ["Copy"],
      priority: "low",
      where: inSite,
    });
    await seed({
      title: "Benchmark three analytics vendors",
      labels: ["Research"],
      assignee: dax,
      priority: "medium",
      steps: steps(3, 0),
    });
    await seed({
      title: "Order the launch-day status page domain",
      labels: ["Infra"],
      priority: "low",
      where: inOps,
    });
    const dns = await seed({
      title: "Move DNS to the new provider",
      comments: 4,
      labels: ["Infra"],
      status: "in_progress",
      assignee: dax,
      priority: "urgent",
      steps: steps(6, 3),
      where: inOps,
    });
    await seed({
      title: "Hero illustration, final",
      comments: 3,
      labels: ["Design"],
      status: "in_progress",
      assignee: ines,
      priority: "high",
      steps: steps(5, 4),
    });
    await seed({
      title: "Wire the signup flow to the new API",
      labels: ["Infra"],
      status: "in_progress",
      assignee: me,
      priority: "high",
      blockedBy: [{ number: dns.number }],
      steps: steps(4, 2),
      where: inOps,
    });
    await seed({
      title: "Launch blog post",
      comments: 2,
      labels: ["Copy"],
      status: "in_review",
      assignee: lin,
      priority: "medium",
      steps: steps(3, 3),
    });
    await seed({
      title: "Accessibility pass on the pricing table",
      labels: ["Design"],
      status: "in_review",
      assignee: ines,
      priority: "high",
    });
    await seed({
      title: "Pick the brand typeface",
      labels: ["Design"],
      status: "done",
      assignee: ines,
    });
    await seed({
      title: "Interview five trial users",
      labels: ["Research"],
      status: "done",
      assignee: dax,
    });
    await seed({
      title: "Staging environment for the new site",
      labels: ["Infra"],
      status: "done",
      assignee: dax,
      where: inOps,
    });

    // A step filed under the Project whose parent is not in it: the Project's board shows it as a
    // card (its parent is not on that board); All tasks shows the parent and keeps the step inside it.
    const outsideParent = await inSite({ operation: "create", title: "Plan the partner webinar" });
    await db.task.update({ where: { id: outsideParent.id }, data: { projectId: null } });
    const outsideStep = await inSite({
      operation: "create",
      title: "Book the webinar speakers",
      parent: { number: outsideParent.number },
    });
    await db.task.update({ where: { id: outsideStep.id }, data: { projectId: project.id } });

    await mkdir(artifacts, { recursive: true });
    const page = `${origin}/en/w/${workspace.slug}/projects/${project.slug}?tab=tasks&layout=board`;
    const settle = async () => {
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && document.body.textContent.includes("Move DNS to the new provider")`,
      );
      await browser(
        "wait",
        "--fn",
        `document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running")`,
      );
    };
    const shot = async (name: string) => {
      await settle();
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await settle();
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    const prefix = Bun.env.SHOT_PREFIX ?? "board";
    await browser("set", "viewport", "1440", "900");
    await browser("open", page);
    // Done is read in its own request after the board's.
    const doneRead = `document.body.textContent.includes("Pick the brand typeface")`;
    await browser("wait", "--fn", doneRead);
    await shot(`${prefix}-1440`);
    const projectCards = await evaluate<string[]>(
      `[...document.querySelectorAll("[data-task-board] article h3")].map((h) => h.textContent.trim())`,
    );
    expect(projectCards).toContain("Book the webinar speakers");
    // A card names its owner beside the face (task #task_v2:#8), on the one footer line.
    const footers = await evaluate<{ title: string; text: string; height: number }[]>(
      `[...document.querySelectorAll("[data-task-board] article")].map((card) => { const footer = card.querySelector("[data-task-card-footer]"); return { title: card.querySelector("h3").textContent.trim(), text: footer.textContent, height: footer.getBoundingClientRect().height }; })`,
    );
    const drafted = footers.find((footer) => footer.title === "Draft the onboarding emails");
    expect(drafted?.text).toContain("Lin Xia");
    for (const footer of footers) expect(footer.height).toBeLessThanOrEqual(28);
    expect(projectCards).not.toContain("Plan the partner webinar");
    // "New task", filled in, over the board.
    await browser(
      "eval",
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New task")?.click()`,
    );
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] [aria-label="Task title"]') !== null`,
    );
    // On a Project's board a new Task starts under that Project (task #621).
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] button[aria-label="Change project: ${project.name}"]') !== null`,
    );
    await browser(
      "fill",
      '[role="dialog"] [aria-label="Task title"]',
      "Write the launch checklist",
    );
    await shot(`${prefix}-dialog-1440`);
    // Assign to reaches everyone, not only who is on the board's Tasks (task #621).
    await browser("click", '[role="dialog"] button[aria-label^="Assign to"]');
    const assignRow = `[...document.querySelectorAll('[role^="menuitem"], [role="option"]')].find((row) => row.textContent.includes(${JSON.stringify(assignAgent.displayName)}))`;
    await browser("wait", "--fn", `${assignRow} !== undefined`);
    await shot(`${prefix}-assign-to-1440`);
    await browser("eval", `${assignRow}.click()`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] button[aria-label="Assign to: @${assignAgent.displayName}"]') !== null`,
    );
    // The picker's popover closes after its pick; wait it out before the next field.
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="menu"][aria-label="Assign to"]') === null`,
    );
    // A new Task names its priority (task #12).
    await pickTaskPriority(browser, '[role="dialog"]', "High");
    await browser(
      "eval",
      `[...document.querySelectorAll('[role="dialog"] button[type="submit"]')][0].click()`,
    );
    await browser("wait", "--fn", `document.querySelector('[role="dialog"]') === null`);
    const assigned = await db.task.findFirstOrThrow({
      where: { title: "Write the launch checklist", projectId: project.id },
      select: {
        conversation: { select: { directKey: true } },
        owner: { select: { agentId: true } },
      },
    });
    expect(assigned.conversation.directKey).toContain(assignAgent.id);
    expect(assigned.owner?.agentId).toBe(assignAgent.id);
    await browser(
      "eval",
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New task")?.click()`,
    );
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] [aria-label="Task title"]') !== null`,
    );
    await browser("press", "Escape");
    await browser("tab", "t1");
    await browser("open", `${origin}/en/w/${workspace.slug}/projects?layout=board`);
    await shot(`${prefix}-all-tasks-1440`);
    await browser("set", "viewport", "390", "844");
    await browser("open", page);
    await browser("wait", "--fn", doneRead);
    await shot(`${prefix}-390`);
    await browser(
      "eval",
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New task")?.click()`,
    );
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] [aria-label="Task title"]') !== null`,
    );
    await browser(
      "fill",
      '[role="dialog"] [aria-label="Task title"]',
      "Write the launch checklist",
    );
    await shot(`${prefix}-dialog-390`);
    // Many labels: the popup's picker. On a phone the chips are one row that scrolls sideways
    // (task #54), so Labels, the last, is swiped to first.
    await browser(
      "eval",
      `document.querySelector('[role="dialog"] button[aria-label="Edit labels"]').scrollIntoView({ inline: "end" })`,
    );
    await browser("click", '[role="dialog"] button[aria-label="Edit labels"]');
    const labelRows = `[...document.querySelectorAll('[role^="menuitem"]')]`;
    await browser("wait", "--fn", `${labelRows}.length > 0`);
    const labelCount = await evaluate<number>(`${labelRows}.length`);
    for (let index = 0; index < Math.min(labelCount, 5); index += 1)
      await browser("eval", `${labelRows}[${index}].click()`);
    await browser("press", "Escape");
    await shot(`${prefix}-labels-390`);

    // A Task in the viewer's own DM, filed under the Project, is on All tasks for them (only).
    await browser("press", "Escape");
    await browser("tab", "t1");
    const dmTitle = "Agree the agency's contract terms";
    await run(dm.id)({ operation: "create", title: dmTitle, project: project.slug });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/projects?layout=board`);
    await browser("wait", "--fn", `document.body.textContent.includes(${JSON.stringify(dmTitle)})`);
    await shot(`${prefix}-all-tasks-dm`);
    // A sub-task is its parent's progress, not a card of its own.
    const cardTitles = await evaluate<string[]>(
      `[...document.querySelectorAll("[data-task-board] article h3")].map((h) => h.textContent.trim())`,
    );
    expect(cardTitles).toContain("Move DNS to the new provider");
    expect(cardTitles.some((title) => title.startsWith("Step "))).toBe(false);
    // On All tasks the webinar's parent is on the board, so its step is inside that card.
    expect(cardTitles).toContain("Plan the partner webinar");
    expect(cardTitles).not.toContain("Book the webinar speakers");

    // An empty Project with a very long name: the header's switcher truncates it.
    await browser("open", `${origin}/en/w/${workspace.slug}/projects/${empty.slug}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector("main")?.textContent.includes(${JSON.stringify(empty.name)}) === true`,
    );
    for (const [width, height, label] of [
      ["1440", "900", "1440"],
      ["390", "844", "390"],
    ] as const) {
      await browser("set", "viewport", width, height);
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${prefix}-empty-long-${label}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("screenshot", join(artifacts, `${prefix}-empty-long-${label}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => {});
    await db.task.deleteMany({ where: { projectId: project.id } }).catch(() => {});
    await db.conversation.deleteMany({ where: { id: { in: [site.id, ops.id] } } }).catch(() => {});
    await db.task.deleteMany({ where: { conversationId: dm.id } }).catch(() => {});
    await db.conversation
      .deleteMany({ where: { directKey: { contains: assignAgent.id } } })
      .catch(() => {});
    await db.agent.deleteMany({ where: { id: assignAgent.id } }).catch(() => {});
    await db.conversation.delete({ where: { id: dm.id } }).catch(() => {});
    await db.project.deleteMany({ where: { id: { in: [project.id, empty.id] } } }).catch(() => {});
    await db.workspaceMembership
      .deleteMany({ where: { workspaceId, userId: { in: people.map((person) => person.id) } } })
      .catch(() => {});
    await db.user
      .deleteMany({ where: { id: { in: people.map((person) => person.id) } } })
      .catch(() => {});
    await db.$disconnect();
  }
}, 300_000);
