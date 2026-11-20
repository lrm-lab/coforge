import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";

const retentionScript = join(__dirname, "deploy-image-retention.sh");

const img = (id: string, repo: string, created: string) => `${id}|${repo}|${created}`;
const WEB = "ghcr.io/lrm-lab/coforge/coforge-web";
const WEB_OLD_ORG = "ghcr.io/lrm-teams/coforge/coforge-web";

// docker() mock shared by the cases: images/ps/inspect/image inspect/rmi are
// answered from the image listing and vars the test controls.
const DOCKER_MOCK = `
docker() {
	case "$1" in
	images) cat "$IMG_FILE" ;;
	ps) printf 'c1\\nc2\\n' ;;
	inspect) case "$4" in c1) printf 'sha256:img-fff\\n' ;; c2) printf 'sha256:img-zzz\\n' ;; esac ;;
	image) case "$5" in *img-fff*) printf 'sha256:img-fff\\n' ;; *img-zzz*) printf 'sha256:img-zzz\\n' ;; *) printf '%s\\n' "$5" ;; esac ;;
	rmi) id="$3"; printf 'rmi %s\\n' "$id" >> "$RMI_LOG"
		# Like docker: an ID tagged under several repositories refuses removal
		# unless -f is passed. MULTI_REPO lists such IDs for the mock.
		case " $MULTI_REPO " in *" $id "*) [ "$2" = "-f" ] || return 1 ;; esac
		[ "$id" != "$RMI_FAIL" ] ;;
	esac
}
`;

async function runRetention(
  body: string,
  images: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string; rmiLog: string }> {
  const dir = await mkdtemp(join(tmpdir(), "coforge-retention-test-"));
  try {
    const imgFile = join(dir, "images.txt");
    const rmiLog = join(dir, "rmi.log");
    await writeFile(imgFile, images);
    await writeFile(rmiLog, "");
    const proc = Bun.spawn(
      ["bash", "-c", `${DOCKER_MOCK}\nsource "$RETENTION_SCRIPT"\n${body}\n`],
      {
        env: {
          ...process.env,
          RETENTION_SCRIPT: retentionScript,
          IMG_FILE: imgFile,
          RMI_LOG: rmiLog,
          RMI_FAIL: "",
          MULTI_REPO: "",
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, rmiLog: await Bun.file(rmiLog).text() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("deploy_images_to_remove keeps the newest N unique web images and protects container references", async () => {
  const images = [
    img("sha256:img-aaa", WEB, "2026-11-16 10:00:00 +0000 UTC"),
    img("sha256:img-bbb", WEB, "2026-11-15 10:00:00 +0000 UTC"),
    img("sha256:img-ccc", WEB_OLD_ORG, "2026-11-14 10:00:00 +0000 UTC"),
    img("sha256:img-ddd", WEB, "2026-11-13 10:00:00 +0000 UTC"),
    // Same image ID listed a second time under another reference.
    img("sha256:img-ddd", WEB, "2026-11-10 10:00:00 +0000 UTC"),
    img("sha256:img-eee", WEB, "2026-11-12 10:00:00 +0000 UTC"),
    // Old but referenced by container c1: must never be removed.
    img("sha256:img-fff", WEB, "2026-11-11 10:00:00 +0000 UTC"),
    // Out of scope repositories.
    img("sha256:img-ggg", "ghcr.io/lrm-lab/coforge/piresearch", "2026-11-09 10:00:00 +0000 UTC"),
    img("sha256:img-hhh", "caddy", "2026-11-08 10:00:00 +0000 UTC"),
  ].join("\n");
  const result = await runRetention("deploy_image_retention=3; deploy_images_to_remove", images);
  expect(result.code).toBe(0);
  const removed = result.stdout.trim().split("\n").filter(Boolean);
  // Newest three unique IDs are aaa/bbb/ccc; candidates are ddd and eee;
  // fff is protected through container c1.
  expect(removed.sort()).toEqual(["sha256:img-ddd", "sha256:img-eee"]);
});

test("prune_deploy_images tolerates rmi failures and reports through deploy_warning", async () => {
  const images = [
    img("sha256:img-aaa", WEB, "2026-11-16 10:00:00 +0000 UTC"),
    img("sha256:img-bbb", WEB, "2026-11-15 10:00:00 +0000 UTC"),
  ].join("\n");
  const result = await runRetention(
    "deploy_image_retention=1\nprune_deploy_images\nprintf 'warning=%s\\n' \"$deploy_warning\"",
    images,
    { RMI_FAIL: "sha256:img-bbb" },
  );
  expect(result.code).toBe(0);
  expect(result.rmiLog.trim()).toBe("rmi sha256:img-bbb");
  expect(result.stderr).toContain("could not remove web image sha256:img-bbb");
  expect(result.stdout).toContain("warning=web image retention left 1 image(s) behind");
});

test("prune_deploy_images removes an ID tagged under multiple repositories", async () => {
  const images = [
    img("sha256:img-aaa", WEB, "2026-11-16 10:00:00 +0000 UTC"),
    // The same image ID under both org names: docker refuses a plain
    // `rmi <id>` for it, so removal needs the -f flag the mock enforces.
    img("sha256:img-multi", WEB, "2026-11-10 10:00:00 +0000 UTC"),
    img("sha256:img-multi", WEB_OLD_ORG, "2026-11-10 10:00:00 +0000 UTC"),
  ].join("\n");
  const result = await runRetention(
    "deploy_image_retention=1\nprune_deploy_images\nprintf 'warning=%s\\n' \"$deploy_warning\"",
    images,
    { MULTI_REPO: "sha256:img-multi" },
  );
  expect(result.code).toBe(0);
  expect(result.rmiLog.trim()).toBe("rmi sha256:img-multi");
  expect(result.stderr).not.toContain("could not remove");
});

test("prune_deploy_images is a no-op when nothing is stale", async () => {
  const images = img("sha256:img-aaa", WEB, "2026-11-16 10:00:00 +0000 UTC");
  const result = await runRetention(
    "deploy_image_retention=5; prune_deploy_images; printf 'done\\n'",
    images,
  );
  expect(result.code).toBe(0);
  expect(result.rmiLog).toBe("");
  expect(result.stdout.trim()).toBe("done");
});

test("deploy_images_to_remove prunes stale coforge-artifact-checker images independently and protects container refs", async () => {
  const CHECKER = "ghcr.io/lrm-lab/coforge/coforge-artifact-checker";
  const images = [
    img("sha256:web-1", WEB, "2026-11-16 10:00:00 +0000 UTC"),
    img("sha256:chk-1", CHECKER, "2026-11-16 10:00:00 +0000 UTC"),
    img("sha256:chk-2", CHECKER, "2026-11-15 10:00:00 +0000 UTC"),
    img("sha256:chk-3", CHECKER, "2026-11-14 10:00:00 +0000 UTC"),
    img("sha256:img-zzz", CHECKER, "2026-11-13 10:00:00 +0000 UTC"),
  ].join("\n");
  const result = await runRetention("deploy_image_retention=2; deploy_images_to_remove", images);
  expect(result.code).toBe(0);
  const removed = result.stdout.trim().split("\n").filter(Boolean);
  expect(removed).toEqual(["sha256:chk-3"]);
});
