import { cx } from "#src/utils/cx";

export interface CascadeFolderIconProps {
  open: boolean;
  className?: string;
}

export function CascadeFolderIcon({ open, className }: CascadeFolderIconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 18 18"
      fill="none"
      data-folder-open={open ? "true" : "false"}
      className={cx("size-[18px] shrink-0", className)}
    >
      <path
        d="M2.25 4.75C2.25 3.92157 2.92157 3.25 3.75 3.25H6.88C7.34 3.25 7.77 3.46 8.05 3.82L8.95 4.93C9.23 5.29 9.66 5.5 10.12 5.5H14.25C15.0784 5.5 15.75 6.17157 15.75 7V13.25C15.75 14.0784 15.0784 14.75 14.25 14.75H3.75C2.92157 14.75 2.25 14.0784 2.25 13.25V4.75Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        className="cascade-folder-front-closed"
        d="M2.25 7.25H15.75V13.25C15.75 14.0784 15.0784 14.75 14.25 14.75H3.75C2.92157 14.75 2.25 14.0784 2.25 13.25V7.25Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        className="cascade-folder-front-open"
        d="M3.4 7.75H16.25L14.85 13.55C14.68 14.26 14.05 14.75 13.32 14.75H3.75C2.82 14.75 2.13 13.88 2.34 12.97L3.4 7.75Z"
        fill="currentColor"
        fillOpacity="0.22"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
