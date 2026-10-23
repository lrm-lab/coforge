/**
 * Generates the Rive project for the CoForge Agent mascots, builds `mascots-<n>.riv`, and renders
 * the static idle-frame avatars. See README.md.
 *
 *   bun apps/web/assets/mascots/generate.ts          write project/mascots.rml
 *   bun apps/web/assets/mascots/generate.ts --build  also build the .riv and the static avatars
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { MASCOT_IDS, type MascotId } from "#src/features/agents/mascot-contract";
import {
  MASCOT_ACTIVITIES,
  MASCOT_RIVE,
  mascotArtboard,
  mascotRivUrl,
} from "#src/features/agents/mascot-rive-contract";
import { activityAnimation } from "./activity.ts";
import { allocateSharedIds, idPerActivity, nextId, type SharedIds } from "./contract.ts";
import { hoverAnimations } from "./hover.ts";
import { stateMachineXml } from "./machine.ts";
import { buildScene } from "./scene.ts";
import { loadSpec } from "./spec.ts";
import { buildStatics } from "./statics.ts";

const HERE = import.meta.dir;
const PROJECT = join(HERE, "project");
const AVATARS = join(HERE, "..", "..", "public", "agent-avatars");

function artboardXml(id: MascotId, index: number, shared: SharedIds): string {
  const { xml, rig } = buildScene(loadSpec(id));
  const activityIds = idPerActivity();
  const hover = hoverAnimations(rig);
  const machineId = nextId();
  const animations = MASCOT_ACTIVITIES.map((a) => activityAnimation(rig, a, activityIds[a])).join(
    "\n",
  );
  return `<Artboard x="${index * 48}" y="0" defaultStateMachineId="${machineId}" viewModelId="${shared.viewModel}" width="24" height="24" name="${mascotArtboard(id)}" id="${nextId()}">
${xml}
${stateMachineXml(shared, activityIds, hover.ids, machineId)}
${animations}
${hover.xml}
</Artboard>`;
}

function viewModelXml(shared: SharedIds): string {
  const values = MASCOT_ACTIVITIES.map(
    (a) =>
      `<DataEnumValue key="${a}" value="${a[0]?.toUpperCase()}${a.slice(1)}" id="${shared.activityValue[a]}"/>`,
  ).join("\n");
  return `<DataEnumCustom name="Activity" id="${shared.activityEnum}">
${values}
</DataEnumCustom>

<ViewModel defaultInstanceId="${shared.instance}" name="${MASCOT_RIVE.viewModel}" id="${shared.viewModel}">
<ViewModelPropertyEnumCustom enumId="${shared.activityEnum}" name="${MASCOT_RIVE.activityProperty}" id="${shared.activityProp}"/>
<ViewModelPropertyBoolean name="${MASCOT_RIVE.hoveredProperty}" id="${shared.hoveredProp}"/>
<ViewModelInstance exports="true" name="Default" id="${shared.instance}">
<ViewModelInstanceEnum propertyValue="${shared.activityValue.idle}" viewModelPropertyId="${shared.activityProp}"/>
<ViewModelInstanceBoolean propertyValue="false" viewModelPropertyId="${shared.hoveredProp}"/>
</ViewModelInstance>
</ViewModel>`;
}

export function projectRml(): string {
  const shared = allocateSharedIds();
  const artboards = MASCOT_IDS.map((id, i) => artboardXml(id, i, shared)).join("\n\n");
  return `<Rive version="1" kind="fragment">\n${artboards}\n\n${viewModelXml(shared)}\n</Rive>\n`;
}

async function run(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

if (import.meta.main) {
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, "mascots.rml"), projectRml());
  console.log(`wrote ${join(PROJECT, "mascots.rml")}`);
  if (process.argv.includes("--build")) {
    await run(["rive", PROJECT, "--once"]);
    const riv = join(AVATARS, basename(mascotRivUrl()));
    copyFileSync(join(PROJECT, "build", "mascots.riv"), riv);
    console.log(`wrote ${riv}`);
    await buildStatics(PROJECT, AVATARS, run);
  }
}
