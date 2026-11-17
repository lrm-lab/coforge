import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An SVG attachment (task #131) is drawn from the signed delivery (CDN) URL as an `<img>` when this
 * deployment has one, and is a file card when it has none; never an `<img>` on the app's own
 * `/api/attachments/:id`, which serves an SVG only as a download. Its script runs in neither. The
 * Web says which case it is in (`/health`'s `X-CoForge-File-Delivery`), and the test checks that
 * one: the CI stack has no CDN, so the drawn case is also pinned by `attachment-view.test.ts`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const storageRoot = Bun.env.COFORGE_FILE_STORAGE_DIR;
if (!storageRoot) throw new Error("COFORGE_FILE_STORAGE_DIR is required");

const SVG_SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>window.__svgScriptRan=true</script><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

test("an SVG attachment is an image from the CDN, or a file card without one, and never runs", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const files = new LocalFileStorage(storageRoot);
  const { browser, evaluate } = browserSession(browserPath, `svg-attachment-${process.pid}`);
  const suffix = String(process.pid);
  const slug = `e2e-svg-card-${suffix}`;
  const fileName = `icon-${suffix}.svg`;
  const objectKey = `e2e/svg-card/${suffix}/original`;
  const workspacePath = `/en/w/${slug}`;
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug,
    name: "E2E SVG card",
    userId: DEV_BROWSER_USER.id,
  });
  let conversationId = "";
  try {
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `svg-card-${suffix}`,
        members: { create: [{ userId: DEV_BROWSER_USER.id }] },
      },
      include: { members: true },
    });
    conversationId = channel.id;
    const message = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId,
        senderMemberId: channel.members[0]!.id,
        body: fileName,
        sequence: 1,
      },
    });
    const bytes = new TextEncoder().encode(SVG_SAMPLE);
    await files.put(objectKey, new Blob([bytes]), "image/svg+xml");
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId,
        messageId: message.id,
        uploaderId: DEV_BROWSER_USER.id,
        objectKey,
        fileName,
        contentType: "image/svg+xml",
        sizeBytes: bytes.byteLength,
      },
    });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/channel/${conversationId}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.textContent.includes("${fileName}")`,
    );

    const delivery = (await fetch(`${origin}/health`)).headers.get("X-CoForge-File-Delivery");
    const check = await evaluate<{
      imageSources: string[];
      routeImages: number;
      scriptRan: boolean;
    }>(
      `({
        imageSources: [...document.querySelectorAll('img[alt="${fileName}"]')].map((img) => new URL(img.src).origin),
        routeImages: document.querySelectorAll('img[src*="/api/attachments/${attachment.id}"]').length,
        scriptRan: Boolean(window.__svgScriptRan),
      })`,
    );
    // The app's own origin never serves the SVG to be drawn: its route sends it to the CDN, as it
    // does a PDF, or streams it as a download (the dev user needs no cookie).
    const route = await fetch(`${origin}/api/attachments/${attachment.id}`, { redirect: "manual" });
    const download = await fetch(`${origin}/api/attachments/${attachment.id}?download`);

    if (delivery === "configured") {
      expect(check.imageSources.length).toBeGreaterThan(0);
      for (const source of check.imageSources) expect(source).not.toBe(new URL(origin).origin);
      expect(route.status).toBe(302);
      expect(new URL(route.headers.get("location")!).origin).not.toBe(new URL(origin).origin);
    } else {
      expect(check.imageSources).toEqual([]);
      expect(
        await evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(fileName)})`),
      ).toBe(true);
    }
    expect(check.routeImages).toBe(0);
    // An <img> that broke on the route and gave way to the file card leaves only its request.
    const routeImageLoads = JSON.parse(
      await browser(
        "network",
        "requests",
        "--filter",
        `/api/attachments/${attachment.id}`,
        "--json",
      ),
    ).data.requests.filter((request: { resourceType: string }) => request.resourceType === "Image");
    expect(routeImageLoads).toEqual([]);
    expect(check.scriptRan).toBe(false);
    if (delivery !== "configured") {
      expect(route.status).toBe(200);
      expect(route.headers.get("content-disposition")).toContain("attachment");
    }
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
  } finally {
    if (conversationId) {
      await deleteAttachmentRows(db, { conversationId }).catch(() => {});
    }
    await files.remove(objectKey).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.$disconnect();
  }
});
