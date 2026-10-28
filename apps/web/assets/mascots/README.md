# Agent mascots

The seven blob mascots (`blue`, `orange`, `pink`, `green`, `purple`, `black`, `yellow`) as one
Rive file with five activities and a hover reaction, plus a static avatar of each mascot's idle
face. The SVGs in `svg/` are the design source (copied from `public/agent-avatars/`); everything
else is generated from them by `generate.ts`.

## Build

```sh
mise run build:mascots   # or, with the Rive CLI on PATH: cd apps/web && bun run build:mascots
```

- `generate.ts` alone writes `project/mascots.rml` (git-ignored, about 800 KB: generated, so it is
  not committed and the pre-commit size limit never sees it). `--build` also runs `rive`, writes
  `public/agent-avatars/mascots-<RIV_VERSION>.riv`, and renders each idle frame to
  `public/agent-avatars/mascot-<color>-<STATIC_VERSION>.webp` (256 px, transparent).
- The command is the `build:mascots` script of `apps/web`; the mise task only supplies the Rive
  CLI. It needs the Rive CLI 1.7.0 (`mise run build:mascots` installs it: the task pins the release
  artifact with mise's [http backend](https://mise.jdx.dev/dev-tools/backends/http.html), URLs from
  `https://releases.rive.app/cli/v1.7.0/manifest.json`) and `cwebp` (`brew install webp`). Without
  mise: `curl -fsSL https://releases.rive.app/cli/install.sh | RIVE_VERSION=1.7.0 sh`.
- The renderer has no transparent-background option (`rive --help`, `rive docs`), and writes no
  transparency, so `statics.ts` renders each frame over black and over
  white and recovers the alpha (`png.ts`).
- Rive's reference: `rive docs <topic>` (format, drawing, state-machines, data). Preview the
  project with `rive apps/web/assets/mascots/project --artboard=mascot-pink`.

A picture or contract change gets a new file name: bump `RIV_VERSION` / `STATIC_VERSION` in
`src/features/agents/mascot-rive-contract.ts` / `mascot-contract.ts` and rebuild, because browsers cache by name. Delete the superseded files and update
their users in the same change.

## Runtime contract

One file, `mascots-<n>.riv`, seven artboards (24 by 24) named `mascot-<color>`. Every artboard has
the same wiring, so the app drives all of them identically:

| Part          | Name                                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| State machine | `State Machine 1` (two layers, `Activity` and `Hover`, run together)                |
| View model    | `Mascot`, bound by the app to a new instance per canvas (`autoBind: false`)         |
| `activity`    | enum `Activity`: `idle`, `thinking`, `working`, `error`, `offline` (default `idle`) |
| `hovered`     | boolean, set on pointer enter / leave (default `false`)                             |
| `lookX`       | number in [-1, 1], where the eyes look: +1 right (default `0`, straight ahead)      |
| `lookY`       | number in [-1, 1], where the eyes look: +1 down (default `0`)                       |

The names live in `src/features/agents/mascot-rive-contract.ts` (`MASCOT_RIVE`, `MASCOT_ACTIVITIES`, `mascotArtboard`), imported by the generator and the app alike. With `@rive-app/canvas`:
`new Rive({ src, artboard: "mascot-yellow", stateMachine: "State Machine 1", autoBind: true })`,
then `viewModelInstance.enum("activity").value = "working"` and
`viewModelInstance.boolean("hovered").value = true`, `viewModelInstance.number("lookX").value = 1`
(`lookToward` in `mascot-look.ts` maps a pointer offset to the pair). The web runtime (`mascot-rive.tsx`) does not
auto-bind: it creates a new `Mascot` view model instance for each canvas (`autoBind: false`,
`useViewModelInstance(..., { useNew: true })`), so mascots sharing the file never affect each other.

## Design rules

- Each mascot is a sticker: one white edge (`OUTLINE`, 2 source units) runs around the whole
  silhouette, body and accessories together, drawn as white twins behind the body (`Outline`
  node; an accessory's twin moves with it). Every mascot is drawn at the same scale (0.87) and
  centred so the outlined figure fits its 24 by 24 artboard with a margin, more above (1.8) than
  below (1.2) for the hover hop (`fit.ts`); the build fails if one does not fit. The web draws the
  picture a little larger than the avatar's box (`.avatar-sticker-figure`).
- Motion is slow and small: loops of 4 s or more, 500 ms eased blends between activities. The
  figure's size and place are the same in every activity (each loop starts and ends at rest), so
  a change of activity only reshapes the face, poses an accessory, mutes the colours or fades the
  bubble or sweat drop in and out.
- At rest a mascot looks at the viewer (Frank, 2026-10-23): the source faces sit high on the
  right of each body and tilt up toward that corner, so the scene moves the whole face across to
  the middle of the body's round mass and a little down, short of any front accessory it would
  crowd, and turns it most of the way level (`face.ts`). Every line mouth sits under the eyes.
  Only thinking glances up, a little, toward its bubble.
- Idle: both eyes open round, a quick double blink every 4–5 s at uneven gaps (4.2 s, 4.8 s,
  4.5 s over a 13.5 s loop), a faint float. Thinking ("pondering"): a small white-edged thought bubble within
  the avatar's box, above the head and a little right (`thought.ts`; the build fails if it
  leaves the circle inscribed in the box, though no circle is drawn), three neutral dark-grey dots lighting in turn every 2 s, one trail circle
  toward the head; the eyes glance up a little and wander slowly, the right brow arches, the mouth is a
  short tilted "hmm", the head tips toward the bubble and back. Working: squinted eyes scan two
  "lines" left to right with a quick return, a slight lean and one small nod per pass (no
  bouncing). Error: wider eyes, worried brows, a lowered frown, a slow sway; pink's shades slip
  down the head and askew off the brows and a sweat drop shows; green's top sparkle steps right,
  off the raised or worried brow, in thinking and error. Offline: closed eyes, muted
  colours, slow breathing. The busy states blink now and then too.
- The mouth morphs (`mouth.ts`): one set of shapes whose vertices every activity keys. Idle is
  the mascot's own mouth; every other activity reshapes it into a small line (its middle raised
  or lowered per activity): an open stroke spreads its vertices along the line, a closed shape
  lies flat on it and a stroke of the line's width draws it, and teeth or a tongue band fold
  onto the line and fade.
- The look is not a state machine layer: data binds drive nodes no animation keys, so the look
  composes with every activity, blink and hover pose. The pupil nodes (`Pupil L` / `Pupil R`,
  inside the eyes) take `lookX` x 0.65 and `lookY` x 0.4 source units, a `Brows look` node 0.4
  and 0.28, and a `Face look` node wrapping the face (brows, eyes, mouth) 0.25 and 0.16, so the
  eyes move about 0.8 artboard units across and 0.5 up and down: a glance that reads at 24 px and
  never pins them to a corner. The app sends the full range (`lookToward`); only this file scales it. Each bind
  owns a `DataConverterGroup` of a 0.2 s `DataConverterInterpolator` (the smoothing) and a
  clamped `DataConverterRangeMapper` (the reach), so the app writes raw values and never
  animates. Closed eyes (offline) stay shut: only the face moves with the look. `look.ts` holds
  the reach.
- The activity layer keys the `Mascot` node, the eyes, the brow and mouth vertices, the thought
  bubble, the sweat drop, each accessory's pose node and
  the colours. The hover layer keys different nodes (`Hover root`,
  `Face`, each accessory's hover node), so hover composes with any activity: a gentle hop (a
  squash, a rise under a unit, a soft landing), then a held "noticed" pose; leaving blends back.
- A state machine does not reset a property its next state leaves unkeyed, so every animation keys
  every property any state touches (`activity.ts`).

## Modules

| File                                      | Responsibility                                                     |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `contract.ts`                             | Rive object id allocation (the names are in `src/features/agents`) |
| `spec.ts`, `svg-source.ts`, `svg-path.ts` | Per-mascot design data read from `svg/`; SVG path to Rive vertices |
| `scene.ts`                                | Node tree of one artboard and the `Rig` of animatable objects      |
| `fit.ts`                                  | The common scale and place of each outlined figure in its artboard |
| `face.ts`                                 | Where the face sits on the body: re-centred and levelled           |
| `mouth.ts`                                | The mouth's shapes and each activity's vertex pose (the morph)     |
| `color.ts`                                | Source colours as Rive `AARRGGBB`; the offline tint                |
| `brows.ts`                                | The brows' strokes and each activity's vertex pose                 |
| `thought.ts`                              | The thinking bubble and its dots, within the avatar's box          |
| `look.ts`                                 | The `lookX` / `lookY` data binds, their converters and reach       |
| `timeline.ts`, `activity.ts`, `hover.ts`  | Keyframes: the five activities, the three hover poses              |
| `machine.ts`                              | The two state machine layers and their transitions                 |
| `generate.ts`, `statics.ts`, `png.ts`     | Project writer, build driver, static avatars and alpha recovery    |
