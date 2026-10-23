import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { MASCOT_IDS, mascotStaticUrl, type MascotId } from "#src/features/agents/mascot-contract";
import { MASCOT_RIVE, mascotArtboard } from "#src/features/agents/mascot-rive-contract";
import { decodePng, encodePng, matte } from "./png.ts";

type Run = (cmd: string[], cwd?: string) => Promise<void>;

/** A copy of the project whose artboards all paint one flat backdrop, so a render has no transparency to lose. */
function backdropProject(project: string, name: string, argb: string): string {
  const dir = join(project, "build", name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(project, "rive.yaml"), join(dir, "rive.yaml"));
  const rml = readFileSync(join(project, "mascots.rml"), "utf8").replace(
    /<Artboard\b[^>]*>/g,
    (open) =>
      `${open}\n<Fill name="Backdrop"><SolidColor colorValue="${argb}" name="Color"/></Fill>`,
  );
  writeFileSync(join(dir, "mascots.rml"), rml);
  return dir;
}

async function render(dir: string, id: MascotId, run: Run): Promise<ReturnType<typeof decodePng>> {
  const png = join(dir, `${id}-idle.png`);
  await run([
    "rive",
    dir,
    `--artboard=${mascotArtboard(id)}`,
    `--screenshot=${png}`,
    "--fit=contain",
    "--viewport=256x256",
    `--data=${MASCOT_RIVE.activityProperty}=idle`,
    "--advance=1",
    "--quiet",
  ]);
  return decodePng(readFileSync(png));
}

/** Render each mascot's idle frame with a transparent background and encode `mascot-<id>-<n>.webp`. */
export async function buildStatics(project: string, out: string, run: Run): Promise<void> {
  const black = backdropProject(project, "backdrop-black", "FF000000");
  const white = backdropProject(project, "backdrop-white", "FFFFFFFF");
  for (const id of MASCOT_IDS) {
    const image = matte(await render(black, id, run), await render(white, id, run));
    const png = join(project, "build", `${id}-idle.png`);
    writeFileSync(png, encodePng(image));
    const webp = join(out, basename(mascotStaticUrl(id)));
    await run(["cwebp", "-quiet", "-q", "95", "-alpha_q", "100", png, "-o", webp]);
    console.log(`wrote ${webp}`);
  }
}
