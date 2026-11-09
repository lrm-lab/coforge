import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { type Job, type Step } from "./workflow-helpers";

// Jobs that hold deploy/release credentials, OIDC tokens, or produce the
// artifacts publish uploads (task #714, approved classification). Each one's
// mise setup must go through the verified binary cache: either the
// setup-verified-mise composite action or, for jobs whose checkout is an older
// commit (inputs.commit / workflow_run head_sha), the same steps inlined.
const credentialJobs = new Set([
  "deploy-staging.yml image",
  "deploy-staging.yml deploy",
  "deploy-production.yml deploy",
  "perf-check.yml check",
  "release-production.yml candidate",
  "release-production.yml publish",
  "release-staging.yml publish",
  "release-installer-staging.yml plan",
  "release-installer-staging.yml build",
  "release-installer-staging.yml publish",
  "release-installer-staging.yml pointer",
  "release-installer-production.yml plan",
  "release-installer-production.yml publish",
  "release-installer-production.yml pointer",
  "release-installer-build.yml build",
  "release-notes.yml notes",
  "cdn-certificates.yml renew",
  "docs-production.yml deploy",
]);

const COMPOSITE = "./.github/actions/setup-verified-mise";

const miseDigests = (() => {
  const text = readFileSync(".github/mise-digests.env", "utf8");
  const digests = {
    version: "",
    bunVersion: "",
    sha: new Map<string, string>(),
    shim: new Map<string, string>(),
    bunSha: new Map<string, string>(),
  };
  for (const line of text.split("\n")) {
    const assign = line.match(/^([A-Z0-9_]+)=(\S+)$/);
    if (!assign) continue;
    const [, key, value] = assign;
    if (key === "MISE_VERSION") digests.version = value!;
    if (key === "BUN_VERSION") digests.bunVersion = value!;
    const sha = line.match(/^SHA256_([A-Z]+)_([A-Z0-9]+?)(_SHIM)?=([0-9a-f]{64})$/);
    if (sha) {
      const target = `${sha[1]}_${sha[2]}`;
      (sha[3] ? digests.shim : digests.sha).set(target, sha[4]!);
    }
    const bunSha = line.match(/^BUN_SHA256_([A-Z]+)_([A-Z0-9]+)=([0-9a-f]{64})$/);
    if (bunSha) digests.bunSha.set(`${bunSha[1]}_${bunSha[2]}`, bunSha[3]!);
  }
  return digests;
})();

const runnerPlatform = (runner: string) => {
  if (runner.includes("ubuntu-24.04-arm") || runner.includes("ubuntu-22.04-arm"))
    return "LINUX_ARM64";
  if (runner.includes("ubuntu")) return "LINUX_X64";
  if (runner.includes("windows-11-arm")) return "WINDOWS_ARM64";
  if (runner.includes("windows")) return "WINDOWS_X64";
  if (runner.includes("macos-13") || runner.includes("macos-15-intel") || runner.includes("x64"))
    return "MACOS_X64";
  if (runner.includes("macos")) return "MACOS_ARM64";
  throw new Error(`unrecognised runner: ${runner}`);
};

const uses = (step: Step) => step.uses?.split("@")[0] ?? "";
const localUses = (step: Step) => step.uses?.startsWith("./") ?? false;

// A job that checks out an older commit resolves local actions from that
// commit's tree, where setup-verified-mise may not exist yet.
const pinnedCheckout = (steps: Step[]) =>
  /inputs\.|inputs\[|head_sha|github\.event\.before/.test(
    String(steps.filter((s) => uses(s) === "actions/checkout").at(-1)?.with?.ref ?? ""),
  );

test("the verified-mise composite restores, verifies, then sets up mise", async () => {
  const action = Bun.YAML.parse(
    await Bun.file(".github/actions/setup-verified-mise/action.yml").text(),
  ) as { runs: { steps: Step[] } };
  const steps = action.runs.steps;
  const at = (name: string) => steps.findIndex((s) => s.name === name);
  const pin = at("Resolve the mise pin");
  const cache = at("Restore the mise binary");
  const verify = at("Verify the restored mise binaries");
  const bunCache = at("Restore the bun binary");
  const bunVerify = at("Verify the restored bun binary");
  const setup = at("Set up mise");
  const shim = at("Verify the downloaded mise shim");
  expect([pin, cache, verify, bunCache, bunVerify, setup, shim].every((i) => i >= 0)).toBe(true);
  expect(pin).toBeLessThan(cache);
  expect(cache).toBeLessThan(verify);
  expect(verify).toBeLessThan(bunCache);
  expect(bunCache).toBeLessThan(bunVerify);
  expect(bunVerify).toBeLessThan(setup);
  expect(setup).toBeLessThan(shim);

  // The pin comes from the digest file, never from call-site inputs, so the
  // version and sha256 cannot drift between the cache key, the verify step,
  // and the action's own inputs.
  expect(String(steps[pin]?.run ?? "")).toContain("mise-digests.env");
  // A conditional or fault-tolerant cache, verify, or setup step would let a
  // poisoned binary through or hide a failed check.
  for (const index of [cache, verify, setup]) {
    expect(steps[index]?.if, `composite step ${index} if`).toBeUndefined();
    expect(steps[index]?.["continue-on-error"], `composite step ${index} coe`).toBeUndefined();
  }
  const cacheStep = steps[cache];
  expect(String(cacheStep?.with?.path ?? "")).toBe("${{ steps.pin.outputs.cache_paths }}");
  // The cache must hold binary files only: a directory entry could carry an
  // unverified executable that bin/'s PATH entry would run.
  const pinRun = String(steps[pin]?.run ?? "");
  expect(pinRun).toContain("cache_paths");
  expect(pinRun).toContain("mise-shim.exe");
  expect(String(cacheStep?.with?.key ?? "")).toContain("mise-bin-");
  expect(String(cacheStep?.with?.key ?? "")).toContain("${{ steps.pin.outputs.sha256 }}");
  const verifyRun = String(steps[verify]?.run ?? "");
  expect(verifyRun).toContain("sha256sum");
  expect(verifyRun).toContain("MISE_SHA256");
  // bin/ lands on PATH wholesale: anything restored beside the known binaries
  // would run unchecked, so the verify step must reject unexpected entries.
  expect(verifyRun).toContain("unexpected entry in restored mise bin");
  const setupWith = steps[setup]?.with ?? {};
  expect(setupWith.cache).toBe(false);
  expect(setupWith.version).toBe("${{ steps.pin.outputs.version }}");
  expect(setupWith.sha256).toBe("${{ steps.pin.outputs.sha256 }}");
  expect(String(steps[shim]?.run ?? "")).toContain("MISE_SHIM_SHA256");

  // bun downloads from GitHub releases too, so the composite restores and
  // verifies the installed binary before `mise install` can run. Both bun
  // steps are conditional: a caller opts out with bun:"false" and a platform
  // without a digest skips them.
  const pinRunBun = String(steps[pin]?.run ?? "");
  expect(pinRunBun).toContain("BUN_VERSION");
  expect(pinRunBun).toContain("BUN_SHA256_");
  for (const index of [bunCache, bunVerify]) {
    expect(String(steps[index]?.if ?? ""), `bun step ${index} if`).toContain("inputs.bun");
    expect(String(steps[index]?.if ?? ""), `bun step ${index} if`).toContain("bun_sha256");
    expect(steps[index]?.["continue-on-error"], `bun step ${index} coe`).toBeUndefined();
  }
  expect(String(steps[bunCache]?.with?.path ?? "")).toBe(
    "${{ steps.pin.outputs.bun_cache_paths }}",
  );
  expect(String(steps[bunCache]?.with?.key ?? "")).toContain("bun-bin-");
  expect(String(steps[bunCache]?.with?.key ?? "")).toContain("${{ steps.pin.outputs.bun_sha256 }}");
  const bunVerifyRun = String(steps[bunVerify]?.run ?? "");
  expect(bunVerifyRun).toContain("unexpected entry in restored bun bin");
  expect(bunVerifyRun).toContain("BUN_SHA256");
  // A cache hit restores only bun; the bunx symlink a real install has must
  // be recreated or `bunx` calls fail.
  expect(bunVerifyRun).toContain("ln -s bun");
});

test("deploy and release jobs use only the verified mise binary cache", async () => {
  // Each setup action's input that turns its cache off; docs/release/github-actions.md.
  const cacheInputs: Record<string, string> = {
    "jdx/mise-action": "cache",
    "docker/setup-buildx-action": "cache-binary",
  };
  const allowedCompositeInputs = new Set(["install", "install-args", "working-directory", "bun"]);
  let checked = 0;
  let compositeSites = 0;
  let inlineCredentialSites = 0;
  let binaryCaches = 0;
  let bunCaches = 0;
  // BUN_VERSION mirrors the `bun` pin in mise.toml; drift would cache the
  // wrong binary.
  const tomlBun = readFileSync("mise.toml", "utf8").match(/^bun = "([^"]+)"/m)?.[1];
  expect(miseDigests.bunVersion).toBe(tomlBun);
  for (const file of new Bun.Glob("*.{yml,yaml}").scanSync(".github/workflows")) {
    const { jobs } = Bun.YAML.parse(await Bun.file(`.github/workflows/${file}`).text()) as {
      jobs: Record<string, Job>;
    };
    for (const [name, job] of Object.entries(jobs)) {
      const jobKey = `${file} ${name}`;
      const steps = job.steps ?? [];
      const composites = steps.filter((s) => s.uses === COMPOSITE);
      const isCredential = credentialJobs.has(jobKey);
      if (composites.length > 0) {
        // Only credential jobs may use the verified-mise composite; class-2
        // jobs keep the action's default full miseDir cache (ci.yml included).
        expect(isCredential, `${jobKey} composite`).toBe(true);
        compositeSites += 1;
        // The composite derives version and digests itself; call sites may
        // only pass through the action's optional install inputs. bun:"false"
        // is for jobs that install no bun — only the Rust installer build.
        expect(composites).toHaveLength(1);
        for (const key of Object.keys(composites[0]?.with ?? {})) {
          expect(allowedCompositeInputs.has(key), `${jobKey} input ${key}`).toBe(true);
        }
        expect(composites[0]?.with?.bun, jobKey).toBe(
          jobKey === "release-installer-staging.yml build" ? "false" : undefined,
        );
        // A composite site passing neither install-args nor install:"false"
        // makes mise-action run a bare `mise install` — every tool in
        // mise.toml from GitHub releases, the outage this task removes.
        const compositeWith = composites[0]?.with ?? {};
        expect(
          compositeWith["install-args"] !== undefined || compositeWith.install === "false",
          `${jobKey} composite install scope`,
        ).toBe(true);
        // The cache, verify, and setup steps live inside the composite; none
        // may also appear inline, and a job checking out an older commit
        // cannot resolve the local action.
        expect(
          steps.filter((s) => uses(s) === "actions/cache" || uses(s) === "jdx/mise-action"),
        ).toHaveLength(0);
        expect(pinnedCheckout(steps), jobKey).toBe(false);
      }
      // Matrix builds that stay inline pin one digest per runner; every entry
      // must match the digest for the platform its runner actually is.
      for (const entry of composites.length > 0 ? [] : (job.strategy?.matrix?.include ?? [])) {
        if (!isCredential) continue;
        const platform = runnerPlatform(entry.runner ?? "");
        expect(entry.mise_sha256, `${jobKey} ${entry.release_target}`).toBe(
          miseDigests.sha.get(platform),
        );
        if (platform.startsWith("WINDOWS")) {
          expect(entry.mise_shim_sha256, `${jobKey} ${entry.release_target}`).toBe(
            miseDigests.shim.get(platform),
          );
        }
      }
      for (const [index, step] of steps.entries()) {
        // Credential jobs name the tools they install. A bare `mise install`
        // pulls every tool in mise.toml — node, actionlint, shellcheck — from
        // GitHub releases on every run, the outage surface task #714 removes.
        if (isCredential) {
          expect(String(step.run ?? "").trim(), `${jobKey} bare mise install`).not.toBe(
            "mise install",
          );
        }
        const action = uses(step);
        if (action === "actions/cache") {
          const path = String(step.with?.path ?? "");
          const key = String(step.with?.key ?? "");
          if (file === "ci.yml") {
            // ci.yml keeps the action's built-in full miseDir cache; a mise
            // cache smuggled in as an actions/cache step would bypass the
            // bin-only rule, so only unrelated caches (e.g. Bun's) may appear.
            expect(key.startsWith("mise-bin-") || path.includes("mise"), jobKey).toBe(false);
            continue;
          }
          if (key.startsWith("bun-bin-")) {
            // The bun binary cache follows the same contract as mise's:
            // credential jobs only, one verified file, platform digest.
            expect(isCredential, `${jobKey} bun cache`).toBe(true);
            expect(path, `${jobKey} bun cache path ${path}`).toBe(
              `~/.local/share/mise/installs/bun/${miseDigests.bunVersion}/bin/bun`,
            );
            const bunSha = miseDigests.bunSha.get(runnerPlatform(String(job["runs-on"] ?? "")));
            expect(key, jobKey).toBe(
              `bun-bin-${miseDigests.bunVersion}-\${{ runner.os }}-\${{ runner.arch }}-${bunSha}`,
            );
            const bunVerify = steps[index + 1];
            const bunVerifyRun = String(bunVerify?.run ?? "");
            expect(bunVerifyRun, jobKey).toContain("unexpected entry in restored bun bin");
            expect(bunVerifyRun, jobKey).toContain(String(bunSha));
            expect(bunVerifyRun, jobKey).toContain("ln -s bun");
            expect(bunVerify?.if, `${jobKey} bun verify if`).toBeUndefined();
            expect(bunVerify?.["continue-on-error"], `${jobKey} bun verify coe`).toBeUndefined();
            bunCaches += 1;
            continue;
          }
          // Only credential jobs may cache at all, and only the mise binary
          // files — never the bin directory (an extra entry would reach PATH
          // unverified) and never the whole miseDir with its installed tools.
          expect(isCredential, jobKey).toBe(true);
          const resolved = path === "${{ steps.mise-bin-path.outputs.cache_paths }}";
          if (resolved) {
            const resolver = steps.find((s) => s.id === "mise-bin-path");
            const resolverRun = String(resolver?.run ?? "");
            expect(resolverRun, jobKey).toContain("mise/bin");
            expect(resolverRun, jobKey).toContain("mise-shim.exe");
          } else {
            expect(path.endsWith("/mise/bin/mise"), `${jobKey} cache path ${path}`).toBe(true);
          }
          expect(key, jobKey).toStartWith(`mise-bin-${miseDigests.version}-`);
          binaryCaches += 1;
          continue;
        }
        if (!(action in cacheInputs)) continue;
        if (action !== "jdx/mise-action") {
          // docker/setup-buildx-action keeps its binary cache off everywhere
          // but ci.yml, which does not run it.
          if (file !== "ci.yml") {
            checked += 1;
            expect(step.with?.[cacheInputs[action]], jobKey).toBe(false);
          }
          continue;
        }
        // The digest file is the single version pin; every inline workflow
        // setup must agree with it.
        expect(step.with?.version, jobKey).toBe(miseDigests.version);
        if (file === "ci.yml") continue;
        const sha256 = String(step.with?.sha256 ?? "");
        if (!isCredential) {
          // Class-2 jobs hold no credentials and publish nothing, so they
          // keep the action's default full miseDir cache (task #714): a
          // cache:false here would make every run download bun again.
          expect(step.with?.cache, jobKey).not.toBe(false);
          expect(sha256, jobKey).toBe("");
          continue;
        }
        checked += 1;
        expect(step.with?.cache, jobKey).toBe(false);
        inlineCredentialSites += 1;
        expect(
          sha256 === "${{ matrix.mise_sha256 }}" || /^[0-9a-f]{64}$/.test(sha256),
          jobKey,
        ).toBe(true);
        // mise-action executes a restored binary before its own sha256 check
        // (getInstalledMiseVersion runs `mise version` on a cache hit), so the
        // restore must be followed by a verify step that rejects a poisoned
        // binary before setup runs it. The bun cache pair may sit between the
        // mise verify and setup, so locate the steps by content, not index.
        const verifyIndex = steps
          .slice(0, index)
          .findLastIndex((s) =>
            String(s.run ?? "").includes("unexpected entry in restored mise bin"),
          );
        const verify = steps[verifyIndex];
        const verifyRun = String(verify?.run ?? "");
        const cacheIndex = steps
          .slice(0, verifyIndex)
          .findLastIndex((s) => uses(s) === "actions/cache");
        const cache = steps[cacheIndex];
        expect(verifyIndex, `${jobKey} mise verify position`).toBeGreaterThanOrEqual(0);
        expect(cacheIndex, `${jobKey} mise cache position`).toBeGreaterThanOrEqual(0);
        expect(verifyIndex, `${jobKey} verify after cache`).toBeGreaterThan(cacheIndex);
        expect(verifyIndex, `${jobKey} verify before setup`).toBeLessThan(index);
        expect(localUses(verify ?? {}), jobKey).toBe(false);
        expect(verify?.if, `${jobKey} verify if`).toBeUndefined();
        expect(verify?.["continue-on-error"], `${jobKey} verify coe`).toBeUndefined();
        expect(step.if, `${jobKey} setup if`).toBeUndefined();
        expect(step["continue-on-error"], `${jobKey} setup coe`).toBeUndefined();
        expect(verifyRun, jobKey).toContain("sha256sum");
        expect(verifyRun, jobKey).toContain("unexpected entry in restored mise bin");
        expect(verifyRun, jobKey).toContain(
          sha256 === "${{ matrix.mise_sha256 }}" ? "${{ matrix.mise_sha256 }}" : sha256,
        );
        if (sha256 === "${{ matrix.mise_sha256 }}") {
          expect(verifyRun, jobKey).toContain("${{ matrix.mise_shim_sha256 }}");
        }
        expect(String(cache?.with?.key ?? ""), jobKey).toContain(
          sha256 === "${{ matrix.mise_sha256 }}" ? "${{ matrix.mise_sha256 }}" : sha256,
        );
        // On a cache miss the action downloads the archive itself; its sha256
        // input covers mise.exe only, so the Windows shim still needs the
        // post-setup check for the freshly downloaded copy.
        if (sha256 === "${{ matrix.mise_sha256 }}") {
          const shimCheck = steps
            .slice(index + 1)
            .some((s) => String(s.run ?? "").includes("mise_shim_sha256"));
          expect(shimCheck, `${jobKey} post-setup shim verify`).toBe(true);
        }
        // A literal sha256 must be the digest for this job's runner platform.
        if (/^[0-9a-f]{64}$/.test(sha256)) {
          const platform = runnerPlatform(String(job["runs-on"] ?? ""));
          expect(sha256, jobKey).toBe(miseDigests.sha.get(platform));
        }
      }
    }
  }
  // 18 credential jobs split between the composite (default-checkout jobs) and
  // the inline trio (jobs that check out inputs.commit / head_sha).
  expect(compositeSites + inlineCredentialSites).toBe(18);
  expect(compositeSites).toBe(13);
  expect(inlineCredentialSites).toBe(5);
  // The five inline credential jobs each keep one bin-only actions/cache;
  // the composite's own cache step is asserted in the first test. Four of
  // them also keep an inline bun binary cache — the Rust installer build
  // installs no bun.
  expect(binaryCaches).toBe(5);
  expect(bunCaches).toBe(4);
  // 6 cache-disabled setup steps remain in workflows (5 inline credential
  // mise-action plus docker/setup-buildx-action's cache-binary); class-2 jobs
  // and ci.yml keep the default full miseDir cache. The composite's inner
  // mise-action is covered by the first test.
  expect(checked).toBe(6);
});
