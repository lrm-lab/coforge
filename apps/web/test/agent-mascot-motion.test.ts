import { expect, test } from "bun:test";

import { mascotActivity } from "#src/features/agents/mascot-activity";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import {
  MASCOT_ACTIVITIES,
  MASCOT_RIVE,
  RIV_VERSION,
  mascotArtboard,
  mascotRivUrl,
} from "#src/features/agents/mascot-rive-contract";
import {
  MASCOT_IDS,
  STATIC_VERSION,
  isMascotPicture,
  mascotStaticUrl,
} from "#src/features/agents/mascot-contract";

// Frank, 2026-10-24: a mascot animates what its Agent is doing. The Rive file is driven by the
// five `activity` values its designer named; the presented state (`agentDisplay`) says which.
test("a presented state picks the mascot's activity, and nothing known is idle", () => {
  const of = (activityKind: "online" | "working" | "thinking" | "error" | "offline") =>
    mascotActivity(
      agentDisplay({
        activityKind,
        protocolMajor: 1,
        workspaceId: "w",
        computerId: "c",
        agentId: "a",
        revision: 1,
        detailKind: "tool_start",
        detail: "",
        entries: [],
        expiresAt: 1,
      }).kind,
    );
  expect(of("working")).toBe("working");
  expect(of("thinking")).toBe("thinking");
  expect(of("error")).toBe("error");
  expect(of("offline")).toBe("offline");
  expect(of("online")).toBe("idle");
  // Not yet heard from: unknown is not offline, so the mascot rests rather than sleeps.
  expect(mascotActivity(agentDisplay(undefined).kind)).toBe("idle");
});

// The browser, the server and the generator in `assets/mascots/` all build names from this one
// contract, so a file the generator writes is the file the app asks for.
test("the contract names one artboard and one picture per mascot, and one Rive file", () => {
  const artboards = MASCOT_IDS.map(mascotArtboard);
  expect(new Set(artboards).size).toBe(MASCOT_IDS.length);
  expect(artboards).toContain("mascot-yellow");
  expect(mascotRivUrl()).toBe(`/agent-avatars/mascots-${RIV_VERSION}.riv`);
  expect(mascotStaticUrl("pink")).toBe(`/agent-avatars/mascot-pink-${STATIC_VERSION}.webp`);
  expect(MASCOT_RIVE.activityProperty).toBe("activity");
  expect(MASCOT_RIVE.lookXProperty).toBe("lookX");
  expect(MASCOT_RIVE.lookYProperty).toBe("lookY");
  expect(MASCOT_ACTIVITIES).toEqual(["idle", "thinking", "working", "error", "offline"]);
});

test("a mascot picture is recognised for drawing it as a sticker, and nothing else is", () => {
  for (const id of MASCOT_IDS) expect(isMascotPicture(mascotStaticUrl(id))).toBeTrue();
  expect(isMascotPicture("/uploads/someone.png")).toBeFalse();
  expect(isMascotPicture(null)).toBeFalse();
  expect(isMascotPicture(undefined)).toBeFalse();
});
