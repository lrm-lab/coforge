import { sleep } from "./cdp-browser.mjs";

export function buildSurfaces(ids, { baseUrl: BASE_URL, locale: LOCALE }) {
  const missing = [];
  if (!ids.agentId) missing.push("agentId");
  if (!ids.computerId) missing.push("computerId");
  if (!ids.channelId) missing.push("channelId");
  if (!ids.dmId) missing.push("dmId");

  const url = (p) => `${BASE_URL}/${LOCALE}/w/${ids.workspaceSlug}${p}`;

  const taskChannelId = ids.channelTaskChannelId ?? ids.channelId;

  const surfaces = [
    { key: "agents-list", url: url("/members") },
    ids.agentId && {
      key: "agent-detail",
      url: url(`/members?profile=agent:${ids.agentId}`),
    },
    { key: "messages-index", url: url("") },
    ids.channelId && { key: "channel-chat", url: url(`/channel/${ids.channelId}`) },
    ids.channelId && {
      key: "channel-tasks-tab",
      url: url(`/channel/${ids.channelId}`),
      prepare: async (page) => {
        const ok = await page.clickText("^Tasks", { within: '[aria-label="Chat / Tasks"]' });
        if (!ok) return "could not find the channel Tasks tab";
      },
    },
    ids.channelId && {
      key: "channel-thread-open",
      url: url(`/channel/${ids.channelId}`),
      prepare: async (page) => {
        const ok = await page.clickText("repl");
        if (!ok) return "could not find a message with replies to open the thread panel";
      },
      postEscape: true,
    },
    ids.channelId && {
      key: "channel-message-hover",
      url: url(`/channel/${ids.channelId}`),
      prepare: async (page) => {
        const rect = await page.findRectBySelector("main li, main article, main [data-message-id]");
        if (!rect) return "could not find a message row to hover";
        await page.mouseMove(rect.x, rect.y);
        await sleepScript(300);
      },
    },
    ids.dmId && { key: "dm-conversation", url: url(`/dm/${ids.dmId}`) },
    ids.dmId &&
      ids.agentId && {
        key: "dm-agent-profile",
        url: url(`/dm/${ids.dmId}?profile=agent:${ids.agentId}`),
        prepare: async (page) => {
          await waitForPanelSettled(page, '[data-split-slot="profile"]');
        },
      },
    ids.channelId && {
      key: "channel-settings-panel",
      url: url(`/channel/${ids.channelId}?details=panel`),
      prepare: async (page) => {
        await waitForPanelSettled(page, '[data-split-slot="details"]');
      },
    },
    ids.channelId && {
      key: "channel-settings-members",
      url: url(`/channel/${ids.channelId}?details=members`),
      prepare: async (page) => {
        await waitForPanelSettled(page, '[data-split-slot="details"]');
      },
    },
    taskChannelId &&
      ids.channelTaskNumber && {
        key: "channel-task-split",
        url: url(`/channel/${taskChannelId}?task=${ids.channelTaskNumber}`),
        prepare: async (page) => {
          await waitForPanelSettled(page, "[data-task-detail]");
        },
      },
    {
      key: "activity-detail-split",
      url: url("/activity"),
      prepare: async (page) => {
        const rect = await page.findRectBySelector(
          "[data-tab-home-scroll] [data-activity-row]:not([data-activity-artifact]) a[href]",
        );
        if (!rect) return "could not find an activity row to open the detail pane";
        await page.clickRect(rect);
        await sleepScript(700);
      },
    },
    { key: "tasks-board", url: url("/tasks?layout=board") },
    { key: "tasks-list", url: url("/tasks?layout=list") },
    { key: "computers-list", url: url("/computers") },
    ids.computerId && {
      key: "computer-detail-runtime-popover",
      url: url(`/computer/${ids.computerId}`),
      prepare: async (page) => {
        const ok =
          (await page.hoverText("Claude Code")) ||
          (await page.hoverText("Codex")) ||
          (await page.hoverText("^Pi$"));
        if (!ok) return "could not find a runtime row to hover for the usage popover";
      },
    },
    { key: "settings-account", url: url("/settings?section=account") },
    { key: "settings-preferences", url: url("/settings?section=preferences") },
    { key: "settings-notifications", url: url("/settings?section=notifications") },
    { key: "settings-members", url: url("/settings?section=members") },
    {
      key: "settings-account-edit-form",
      url: url("/settings?section=account"),
      prepare: async (page) => {
        const ok = await page.clickText("^Edit$");
        if (!ok) return "could not find the profile Edit button";
      },
    },
    {
      key: "dialog-create-channel",
      url: url(""),
      prepare: async (page) => {
        const ok = await page.clickText("Create Channel");
        if (!ok) return "could not find the Create channel trigger";
      },
      postEscape: true,
    },
    {
      key: "dialog-new-agent",
      url: url("/members"),
      prepare: async (page) => {
        const ok = await page.clickText("New Agent");
        if (!ok) return "could not find the New Agent trigger";
      },
      postEscape: true,
    },
    {
      key: "dialog-add-computer-step1",
      url: url("/computers"),
      prepare: async (page) => {
        const ok = await page.clickText("Add Computer");
        if (!ok) return "could not find the Add computer trigger";
      },
      postEscape: true,
    },
    {
      key: "dialog-add-computer-step2",
      url: url("/computers"),
      prepare: async (page) => {
        if (!(await page.clickText("Add Computer")))
          return "could not find the Add computer trigger";
        if (!(await page.clickText("Your computer")))
          return "could not select the local computer option";
        if (!(await page.clickText("^Next$"))) return "could not advance to the install step";
      },
      postEscape: true,
    },
    ids.channelId && {
      key: "dialog-create-task",
      url: url(`/channel/${ids.channelId}`),
      prepare: async (page) => {
        if (!(await page.clickText("^Tasks", { within: '[aria-label="Chat / Tasks"]' })))
          return "could not find the channel Tasks tab";
        await sleepScript(500);
        const ok = await page.clickText("New task");
        if (!ok) return "could not find the Create task trigger";
      },
      postEscape: true,
    },
    {
      key: "menu-workspace-switcher",
      url: url("/members"),
      prepare: async (page) => {
        const opened = await page.clickText("Current workspace");
        if (!opened) return "could not find the workspace switcher trigger";
      },
      postEscape: true,
    },
    {
      key: "menu-user-menu",
      url: url("/members"),
      prepare: async (page) => {
        const ok = await page.clickText("Current user");
        if (!ok) return "could not find the user menu trigger";
      },
      postEscape: true,
    },
    {
      key: "sidebar-collapsed-tooltip",
      url: url("/members"),
      prepare: async (page) => {
        const collapsed = await page.clickText("Hide Sidebar");
        if (!collapsed) return "could not find the sidebar collapse control";
        const hovered = await page.hoverText("Show sidebar");
        if (!hovered) return "collapsed sidebar, but could not hover its expand tooltip";
      },
    },
    {
      key: "sidebar-mid-resize",
      url: url("/members"),
      prepare: async (page) => {
        const rect = await page.findRectBySelector('[aria-label="Resize sidebar"]');
        if (!rect) return "could not find the sidebar resize handle";
        await page.mouseDown(rect.x, rect.y);
        await page.mouseMove(rect.x + 60, rect.y);
        await sleepScript(150);
      },
      cleanup: async (page) => {
        await page.mouseUp(0, 0);
      },
    },
  ];

  return { surfaces: surfaces.filter(Boolean), missing };
}

function sleepScript(ms) {
  return sleep(ms);
}

async function waitForPanelSettled(page, selector) {
  for (let waited = 0; waited < 2000; waited += 100) {
    const settled = await page.evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.right > window.innerWidth + 1) return false;
      let cur = el;
      while (cur && cur !== document.body) {
        const t = getComputedStyle(cur).transform;
        if (t && t !== "none" && t !== "matrix(1, 0, 0, 1, 0, 0)") return false;
        cur = cur.parentElement;
      }
      return true;
    })()`);
    if (settled) {
      await sleepScript(100);
      break;
    }
    await sleepScript(100);
  }
}
