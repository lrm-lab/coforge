import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  browserSession,
  devBrowserWorkspace,
  elementAtRest,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/public-runtimes-hint");

test("non-owners see the owner public-runtimes footnote on computer detail and in New Agent while owners see none", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `public-runtimes-hint-${process.pid}`,
  );
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const ownerDisplayName = "Alice Lin";
  const enHint = `Showing runtimes ${ownerDisplayName} has made public.`;
  const zhHint = `仅显示 ${ownerDisplayName} 公开的运行时`;
  const ownerUsername = `alice-rt-${suffix}`;

  const otherUser = await db.user.create({
    data: {
      username: ownerUsername,
      displayName: ownerDisplayName,
      welcomedAt: new Date(),
    },
  });
  await db.workspaceMembership.create({
    data: {
      workspaceId,
      userId: otherUser.id,
      role: "member",
    },
  });

  const otherPublic = await db.computer.create({
    data: {
      ownerId: otherUser.id,
      machineId: `other-pub-${suffix}`,
      name: `Alice Public Host ${suffix}`,
      displayName: `Alice Public Host ${suffix}`,
      computerVersion: "1.0.53",
      platform: "darwin",
    },
  });
  const otherEmpty = await db.computer.create({
    data: {
      ownerId: otherUser.id,
      machineId: `other-empty-${suffix}`,
      name: `Alice Private Host ${suffix}`,
      displayName: `Alice Private Host ${suffix}`,
      computerVersion: "1.0.53",
      platform: "linux",
    },
  });
  const ownComputer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `own-host-${suffix}`,
      name: `Own Host ${suffix}`,
      displayName: `Own Host ${suffix}`,
      computerVersion: "1.0.53",
      platform: "darwin",
    },
  });

  const createdComputerIds = [otherPublic.id, otherEmpty.id, ownComputer.id];

  try {
    await db.workspaceComputer.createMany({
      data: createdComputerIds.map((computerId) => ({ workspaceId, computerId })),
    });
    await db.computerRuntime.createMany({
      data: [
        {
          workspaceId,
          computerId: otherPublic.id,
          provider: "claude-code",
          version: "1.0.0",
          displayName: "Claude Code",
          isPublic: true,
        },
        {
          workspaceId,
          computerId: otherPublic.id,
          provider: "codex",
          version: "1.0.0",
          displayName: "Codex",
          isPublic: false,
        },
        {
          workspaceId,
          computerId: otherEmpty.id,
          provider: "codex",
          version: "1.0.0",
          displayName: "Codex",
          isPublic: false,
        },
        {
          workspaceId,
          computerId: ownComputer.id,
          provider: "claude-code",
          version: "1.0.0",
          displayName: "Claude Code",
          isPublic: false,
        },
      ],
    });
    await db.computerModelCatalog.createMany({
      data: [
        {
          workspaceId,
          computerId: otherPublic.id,
          provider: "claude-code",
          models: [{ id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" }],
        },
        {
          workspaceId,
          computerId: ownComputer.id,
          provider: "claude-code",
          models: [{ id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" }],
        },
      ],
    });
    for (const computerId of createdComputerIds) {
      await getComputerStatusCache().put({ workspaceId, computerId }, true);
    }
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");

    await browser("open", `${origin}/en/w/${workspace.slug}/computer/${otherPublic.id}`);
    await waitFor(
      `${pageHydrated} && document.querySelector('section[aria-labelledby="computer-runtimes"]') !== null`,
    );
    await waitFor(
      `document.querySelector('section[aria-labelledby="computer-runtimes"]')?.innerText.includes(${JSON.stringify(enHint)}) ?? false`,
    );

    const detailOtherPublic = await evaluate<{
      sectionText: string;
      fontSize: string;
      gapPx: number;
      imgCount: number;
    }>(`(() => {
      const section = document.querySelector('section[aria-labelledby="computer-runtimes"]');
      const ul = section?.querySelector('ul');
      const hintEl = [...(section?.querySelectorAll('p') ?? [])].find((p) =>
        p.textContent?.includes(${JSON.stringify(enHint)}),
      );
      if (!section || !ul || !hintEl) return null;
      return {
        sectionText: section.innerText,
        fontSize: getComputedStyle(hintEl).fontSize,
        gapPx: Math.round(hintEl.getBoundingClientRect().top - ul.getBoundingClientRect().bottom),
        imgCount: hintEl.querySelectorAll('img').length,
      };
    })()`);
    expect(detailOtherPublic).not.toBeNull();
    expect(detailOtherPublic.sectionText).toContain("Claude Code");
    expect(detailOtherPublic.sectionText).not.toContain("Codex");
    expect(detailOtherPublic.sectionText).not.toContain(ownerUsername);
    expect(detailOtherPublic.fontSize).toBe("12px");
    expect(detailOtherPublic.gapPx).toBeGreaterThanOrEqual(7);
    expect(detailOtherPublic.gapPx).toBeLessThanOrEqual(9);
    expect(detailOtherPublic.imgCount).toBe(0);
    await browser("screenshot", join(artifacts, "detail-other-public-en.png"));

    const createBtn = `[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Create Agent')`;
    await waitFor(elementAtRest(createBtn));
    await evaluate(`${createBtn}.click() ?? true`);
    await waitFor(
      `document.querySelector('[role="dialog"] [data-field="provider"] button') !== null`,
    );
    const detailDialogDesc = await evaluate<string>(`(() => {
      const btn = document.querySelector('[role="dialog"] [data-field="provider"] button');
      const ids = (btn?.getAttribute('aria-describedby') ?? '').split(/\\s+/).filter(Boolean);
      return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    })()`);
    expect(detailDialogDesc).toBe(enHint);
    const cancelBtn = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Cancel')`;
    await waitFor(elementAtRest(cancelBtn));
    await evaluate(`${cancelBtn}.click() ?? true`);
    await waitFor(`document.querySelector('[role="dialog"]') === null`);

    await browser("open", `${origin}/zh-CN/w/${workspace.slug}/computer/${otherPublic.id}`);
    await waitFor(
      `${pageHydrated} && (document.querySelector('section[aria-labelledby="computer-runtimes"]')?.innerText.includes(${JSON.stringify(zhHint)}) ?? false)`,
    );
    const detailOtherPublicZh = await evaluate<string>(
      `document.querySelector('section[aria-labelledby="computer-runtimes"]')?.innerText ?? ''`,
    );
    expect(detailOtherPublicZh).toContain(zhHint);

    await browser("open", `${origin}/en/w/${workspace.slug}/computer/${otherEmpty.id}`);
    await waitFor(
      `${pageHydrated} && (document.querySelector('section[aria-labelledby="computer-runtimes"]')?.innerText.includes(${JSON.stringify(enHint)}) ?? false)`,
    );
    const detailOtherEmpty = await evaluate<string>(
      `document.querySelector('section[aria-labelledby="computer-runtimes"]')?.innerText ?? ''`,
    );
    expect(detailOtherEmpty).toContain("No external Code Agents detected");
    expect(detailOtherEmpty).toContain(enHint);

    await browser("open", `${origin}/en/w/${workspace.slug}/computer/${ownComputer.id}`);
    await waitFor(
      `${pageHydrated} && (document.querySelector('section[aria-labelledby="computer-runtimes"]')?.innerText.includes('Claude Code') ?? false)`,
    );
    const detailOwn = await evaluate<string>(
      `document.querySelector('section[aria-labelledby="computer-runtimes"]')?.innerText ?? ''`,
    );
    expect(detailOwn).not.toContain("has made public");

    await browser("open", `${origin}/en/w/${workspace.slug}`);
    await waitFor(`${pageHydrated} && document.querySelector('button[aria-label="New"]') !== null`);
    await browser("click", 'button[aria-label="New"]');
    await browser("find", "role", "menuitem", "click", "--name", "New Agent", "--exact");
    await waitFor(`document.querySelector('[role="dialog"]') !== null`);
    const hasLocalTab = await evaluate<boolean>(
      `[...document.querySelectorAll('[role="dialog"] [role="radiogroup"] label')].some((el) => el.textContent?.trim() === 'Local')`,
    );
    if (hasLocalTab) {
      await evaluate(
        `[...document.querySelectorAll('[role="dialog"] [role="radiogroup"] label')].find((el) => el.textContent?.trim() === 'Local')?.click() ?? true`,
      );
    }
    await waitFor(
      `document.querySelector('[role="dialog"] [data-field="computerId"] button[aria-haspopup="listbox"]') !== null`,
    );

    const readProviderDescribedBy = () =>
      evaluate<string>(`(() => {
        const btn = document.querySelector('[role="dialog"] [data-field="provider"] button');
        const ids = (btn?.getAttribute('aria-describedby') ?? '').split(/\\s+/).filter(Boolean);
        return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      })()`);

    const selectComputer = async (id: string) => {
      await browser(
        "click",
        '[role="dialog"] [data-field="computerId"] button[aria-haspopup="listbox"]',
      );
      await waitFor(`document.querySelector('[role="listbox"] [data-key="${id}"]') !== null`);
      await browser("click", `[role="listbox"] [data-key="${id}"]`);
      await waitFor(`document.querySelector('[role="listbox"]') === null`);
    };

    const readComputerTriggerText = () =>
      evaluate<string>(
        `document.querySelector('[role="dialog"] [data-field="computerId"] button[aria-haspopup="listbox"]')?.textContent?.trim() ?? ''`,
      );

    await selectComputer(otherPublic.id);
    await waitFor(
      `(() => {
        const btn = document.querySelector('[role="dialog"] [data-field="provider"] button');
        const ids = (btn?.getAttribute('aria-describedby') ?? '').split(/\\s+/).filter(Boolean);
        return ids.some((id) => document.getElementById(id)?.textContent?.includes(${JSON.stringify(enHint)}));
      })()`,
    );
    expect(await readComputerTriggerText()).toContain("Alice Public Host");
    expect(await readProviderDescribedBy()).toBe(enHint);

    await selectComputer(otherEmpty.id);
    await waitFor(
      `document.querySelector('[role="dialog"] [data-field="computerId"] button[aria-haspopup="listbox"]')?.textContent?.includes('Alice Private Host') ?? false`,
    );
    expect(await readProviderDescribedBy()).toBe(enHint);

    await selectComputer(ownComputer.id);
    await waitFor(
      `!(document.querySelector('[role="dialog"]')?.innerText.includes('has made public') ?? false)`,
    );
    expect(await readComputerTriggerText()).toContain("Own Host");
    expect(await readProviderDescribedBy()).toBe("");

    await selectComputer(otherPublic.id);
    await waitFor(
      `document.querySelector('[role="dialog"]')?.innerText.includes(${JSON.stringify(enHint)}) ?? false`,
    );
    expect(await readComputerTriggerText()).toContain("Alice Public Host");
    expect(await readProviderDescribedBy()).toBe(enHint);

    await browser("screenshot", join(artifacts, "dialog-other-public-en.png"));

    await Bun.write(
      join(artifacts, "result.json"),
      JSON.stringify(
        {
          detailOtherPublic,
          detailDialogDesc,
          detailOtherPublicZh,
          detailOtherEmpty,
          detailOwn,
          switchedBackDesc: enHint,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser("close").catch(() => undefined);
    for (const computerId of createdComputerIds) {
      await getComputerStatusCache()
        .put({ workspaceId, computerId }, false)
        .catch(() => undefined);
    }
    await db.computerModelCatalog
      .deleteMany({ where: { computerId: { in: createdComputerIds } } })
      .catch(() => undefined);
    await db.computerRuntime
      .deleteMany({ where: { computerId: { in: createdComputerIds } } })
      .catch(() => undefined);
    await db.workspaceComputer
      .deleteMany({ where: { computerId: { in: createdComputerIds } } })
      .catch(() => undefined);
    await db.computer
      .deleteMany({ where: { id: { in: createdComputerIds } } })
      .catch(() => undefined);
    await db.workspaceMembership
      .deleteMany({ where: { workspaceId, userId: otherUser.id } })
      .catch(() => undefined);
    await db.user.deleteMany({ where: { id: otherUser.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
