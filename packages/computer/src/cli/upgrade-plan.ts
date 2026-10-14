import { compareReleaseVersions, parseReleaseVersion } from "@lrm/coforge-sdk/internal";
import { terminalText } from "#src/terminal-output";

/** What `coforge-computer upgrade` would do, worked out before anything is downloaded or changed. */
export type UpgradePlan =
  | { kind: "up-to-date"; version: string }
  | {
      /** `unordered`: one side is not SemVer, so the installer cannot tell which is newer. */
      kind: "install" | "upgrade" | "downgrade" | "unordered";
      current: string | null;
      target: string;
      /** Refused by the installer (`UPGRADE_DOWNGRADE_REFUSED`) unless `--allow-downgrade`. */
      refused: boolean;
    };

/**
 * Classifies the move from the installed version to the resolved target the way the installer
 * gates it (docs/release/upgrade-operations.md, "Downgrade and recovery"): nothing installed, the
 * same, or a newer version needs no flag; an older version, or one that is not SemVer and so cannot
 * be ordered, is refused without `--allow-downgrade`.
 */
export function planUpgrade(
  current: string | null,
  target: string,
  allowDowngrade: boolean,
): UpgradePlan {
  if (current === target) return { kind: "up-to-date", version: target };
  if (current === null) return { kind: "install", current, target, refused: false };
  if (!parseReleaseVersion(current) || !parseReleaseVersion(target))
    return { kind: "unordered", current, target, refused: !allowDowngrade };
  const downgrade = compareReleaseVersions(target, current) < 0;
  return {
    kind: downgrade ? "downgrade" : "upgrade",
    current,
    target,
    refused: downgrade && !allowDowngrade,
  };
}

/**
 * The dry run's report and exit status: 0 when the upgrade would go ahead (or there is nothing to
 * do), 1 when the installer would refuse it. The command it names pins the exact resolved version,
 * so applying it moves to what the dry run showed even if `latest` moves meanwhile. Versions come
 * from the release feed and the install, so they are made terminal-safe.
 */
export function describeUpgradePlan(plan: UpgradePlan): { lines: string[]; exitCode: number } {
  const header = "Dry run: nothing was downloaded, installed, or stopped.";
  if (plan.kind === "up-to-date")
    return { lines: [header, `Already up to date: ${terminalText(plan.version)}`], exitCode: 0 };
  const current = plan.current === null ? "none" : terminalText(plan.current);
  const target = terminalText(plan.target);
  const lines = [header, `Installed: ${current}`, `Target: ${target}`];
  const needsFlag = plan.kind === "downgrade" || plan.kind === "unordered";
  if (plan.refused) {
    lines.push(
      plan.kind === "downgrade"
        ? `Would refuse: ${target} is older than the installed ${current}.`
        : `Would refuse: ${target} cannot be ordered against the installed ${current}.`,
      `To go ahead anyway, run: coforge-computer upgrade --version ${target} --allow-downgrade`,
    );
    return { lines, exitCode: 1 };
  }
  const move =
    plan.kind === "install"
      ? `Would install: ${target}`
      : plan.kind === "unordered"
        ? `Would replace: ${current} -> ${target}`
        : `Would ${plan.kind}: ${current} -> ${target}`;
  lines.push(
    move,
    `To apply, run: coforge-computer upgrade --version ${target}${needsFlag ? " --allow-downgrade" : ""}`,
  );
  return { lines, exitCode: 0 };
}
