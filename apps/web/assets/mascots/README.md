# Agent mascots

The seven blob mascots (`blue`, `orange`, `pink`, `green`, `purple`, `black`, `yellow`) as one
Rive file with five activities and a hover reaction, plus a static avatar of each mascot's idle
face. The SVGs in `svg/` are the design source (copied from `public/agent-avatars/`); everything
else is generated from them by `generate.ts`.

## Build

```sh
mise run build:mascots   # or, with the Rive CLI on PATH: cd apps/web && bun run build:mascots
```

- `generate.ts` alone writes `project/mascots.rml` (git-ignored, about 370 KB: generated, so it is
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

- Motion is slow and small: loops of 2.4 s or more, 400 ms blends between activities.
- Idle: both eyes open round, an occasional blink, a faint float. Thinking: eyes look up and right
  and three dots pulse. Working: squinted eyes scan two "lines" left to right with a quick return,
  a slight forward lean and one small nod per loop (no bouncing). Error: worried brows, frown, a
  slow sway. Offline: closed eyes, muted colours, slow breathing.
- The look is not a state machine layer: data binds drive two nodes no animation keys, so the look
  composes with every activity, blink and hover pose. The pupil nodes (`Pupil L` / `Pupil R`,
  inside the eyes) take `lookX` x 1.0 and `lookY` x 0.8 artboard units; a `Face look` node
  wrapping the face (brows, eyes, mouth) takes 0.3 on both. Each bind owns a
  `DataConverterGroup` of a 0.2 s `DataConverterInterpolator` (the smoothing) and a clamped
  `DataConverterRangeMapper` (the reach), so the app writes raw values and never animates.
  Closed eyes (offline) stay shut: only the face moves with the look. `look.ts` holds the reach.
- The activity layer keys the `Mascot` node, the eyes, brows, mouth, dots and colours. The hover
  layer keys different nodes (`Hover root`, `Face`, each accessory), so hover composes with any
  activity: a short soft squash and rise, then a held "noticed" pose; leaving blends back.
- A state machine does not reset a property its next state leaves unkeyed, so every animation keys
  every property any state touches (`activity.ts`).

## Modules

| File                                      | Responsibility                                                     |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `contract.ts`                             | Rive object id allocation (the names are in `src/features/agents`) |
| `spec.ts`, `svg-source.ts`, `svg-path.ts` | Per-mascot design data read from `svg/`; SVG path to Rive vertices |
| `scene.ts`                                | Node tree of one artboard and the `Rig` of animatable objects      |
| `look.ts`                                 | The `lookX` / `lookY` data binds, their converters and reach       |
| `timeline.ts`, `activity.ts`, `hover.ts`  | Keyframes: the five activities, the three hover poses              |
| `machine.ts`                              | The two state machine layers and their transitions                 |
| `generate.ts`, `statics.ts`, `png.ts`     | Project writer, build driver, static avatars and alpha recovery    |
