import {
  MASCOT_ACTIVITIES,
  MASCOT_RIVE,
  type MascotActivity,
} from "#src/features/agents/mascot-rive-contract";
import { idPerActivity, nextId, type SharedIds } from "./contract.ts";
import type { HoverPose } from "./hover.ts";
import { EASE_IN_OUT } from "./timeline.ts";

/** Blend time between two activities, milliseconds. Frank found anything faster uncomfortable. */
const ACTIVITY_BLEND_MS = 500;
/** Every blend eases in and out, so a change of pose never starts or stops with a jolt. */
const EASED = `interpolationType="cubic"`;
const HOVER_IN_MS = 180;
const HOVER_OUT_MS = 350;
const HELLO_TO_NOTICED_MS = 300;

function enumCondition(shared: SharedIds, to: MascotActivity): string {
  return (
    `<TransitionViewModelCondition><TransitionPropertyViewModelComparator><BindablePropertyEnum>` +
    `<DataBindContext sourcePathIds="${shared.viewModel}-${shared.activityProp}" propertyKey="637"/>` +
    `</BindablePropertyEnum></TransitionPropertyViewModelComparator>` +
    `<TransitionValueEnumComparator value="${shared.activityValue[to]}"/></TransitionViewModelCondition>`
  );
}

function hoveredCondition(shared: SharedIds, value: boolean): string {
  return (
    `<TransitionViewModelCondition><TransitionPropertyViewModelComparator><BindablePropertyBoolean>` +
    `<DataBindContext sourcePathIds="${shared.viewModel}-${shared.hoveredProp}" propertyKey="634"/>` +
    `</BindablePropertyBoolean></TransitionPropertyViewModelComparator>` +
    `<TransitionValueBooleanComparator value="${value}"/></TransitionViewModelCondition>`
  );
}

const layerFrame = (x: number): string =>
  `<AnyState x="${x}" y="-120"/><ExitState x="${x + 200}" y="-120"/>`;

function activityLayer(shared: SharedIds, animationIds: Record<MascotActivity, string>): string {
  const stateIds = idPerActivity();
  const states = MASCOT_ACTIVITIES.map((from, i) => {
    const transitions = MASCOT_ACTIVITIES.filter((to) => to !== from)
      .map(
        (to) =>
          `<StateTransition stateToId="${stateIds[to]}" duration="${ACTIVITY_BLEND_MS}" ${EASED}>${EASE_IN_OUT}${enumCondition(shared, to)}</StateTransition>`,
      )
      .join("\n");
    return `<AnimationState x="${200 + 240 * i}" y="0" animationId="${animationIds[from]}" id="${stateIds[from]}">\n${transitions}\n</AnimationState>`;
  }).join("\n");
  return (
    `<StateMachineLayer name="Activity" id="${nextId()}">\n${layerFrame(200)}\n` +
    `<EntryState><StateTransition stateToId="${stateIds.idle}"/></EntryState>\n${states}\n</StateMachineLayer>`
  );
}

function hoverLayer(shared: SharedIds, animationIds: Record<HoverPose, string>): string {
  const rest = nextId();
  const hello = nextId();
  const noticed = nextId();
  const toRest = (): string =>
    `<StateTransition stateToId="${rest}" duration="${HOVER_OUT_MS}" ${EASED}>${EASE_IN_OUT}${hoveredCondition(shared, false)}</StateTransition>`;
  return (
    `<StateMachineLayer name="Hover" id="${nextId()}">\n${layerFrame(200)}\n` +
    `<EntryState><StateTransition stateToId="${rest}"/></EntryState>\n` +
    `<AnimationState x="200" y="0" animationId="${animationIds.rest}" id="${rest}">\n` +
    `<StateTransition stateToId="${hello}" duration="${HOVER_IN_MS}" ${EASED}>${EASE_IN_OUT}${hoveredCondition(shared, true)}</StateTransition>\n</AnimationState>\n` +
    // Hello plays once (the exit-time transition waits for its end), unless the pointer leaves first.
    `<AnimationState x="440" y="0" animationId="${animationIds.hello}" reset="true" id="${hello}">\n${toRest()}\n` +
    `<StateTransition stateToId="${noticed}" duration="${HELLO_TO_NOTICED_MS}" ${EASED} enableExitTime="true" exitTimeIsPercetange="true" exitTime="100">${EASE_IN_OUT}</StateTransition>\n</AnimationState>\n` +
    `<AnimationState x="680" y="0" animationId="${animationIds.noticed}" id="${noticed}">\n${toRest()}\n</AnimationState>\n` +
    `</StateMachineLayer>`
  );
}

export function stateMachineXml(
  shared: SharedIds,
  activityAnimations: Record<MascotActivity, string>,
  hoverAnimations: Record<HoverPose, string>,
  id: string,
): string {
  return (
    `<StateMachine name="${MASCOT_RIVE.stateMachine}" id="${id}">\n` +
    `${activityLayer(shared, activityAnimations)}\n${hoverLayer(shared, hoverAnimations)}\n</StateMachine>`
  );
}
