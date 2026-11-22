import githubMark from "@lobehub/icons-static-svg/icons/github.svg";

import { cx } from "#src/utils/cx";

export function GitHubMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "size-5 shrink-0 bg-current mask-contain mask-center mask-no-repeat",
        className,
      )}
      style={{ maskImage: `url("${githubMark}")`, WebkitMaskImage: `url("${githubMark}")` }}
    />
  );
}
