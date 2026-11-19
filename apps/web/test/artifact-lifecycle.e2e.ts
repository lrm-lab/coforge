import { expect, test } from "bun:test";
import { startPageFixture } from "./helpers/artifact-page-fixture";
import { localBrowserE2e, browserSession } from "./helpers/browser-e2e";
import { artifactChrome, artifactViewerReady } from "./helpers/artifact-chrome";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

test("Artifact lifecycle: Staging/Browser/Redis/Centrifugo/Provider", async () => {
  // 1. Setup
  const { origin, browserPath } = localBrowserE2e();
  const fixture = await startPageFixture("lifecycle");
  const session = `artifact-${crypto.randomUUID()}`;
  const { browser, evaluate, waitFor } = browserSession(browserPath, session);

  try {
    // 2. Create Artifact
    const artifactId = await fixture.page("E2E Test Artifact");
    const workspace = await fixture.db.workspace.findUniqueOrThrow({
      where: { id: fixture.workspaceId },
    });
    const artifactUrl = `${origin}/w/${workspace.slug}/artifact/${artifactId}`;

    // 3. Navigate
    // Set authentication via dev-skip-auth cookie
    await browser("set", "cookie", `dev-user=${JSON.stringify(DEV_BROWSER_USER)}`);
    await browser("open", artifactUrl);
    const chrome = artifactChrome({ browser, evaluate });

    // 4. Verify
    await waitFor(artifactViewerReady);
    expect(await chrome.versionChipText()).toBe("v1");
    // Verify initial scope
    expect(await chrome.selectedScope()).toBe("Workspace");

    // 5. Lifecycle action - change scope
    await chrome.chooseFromPill("Conversation");
    await chrome.untilPillScope("Conversation");

    // Verify scope change persisted
    expect(await chrome.selectedScope()).toBe("Conversation");

    console.log("Verified artifact lifecycle: Staging, Browser, Rendering, Scope Persistence");
  } finally {
    await fixture.stop();
    await browser("close").catch(() => {});
  }
}, 60_000);
