import { useId } from "react";

import { cn } from "#src/lib/utils";

function WireframeShadowFilter({ id }: { id: string }) {
  return (
    <defs>
      <filter id={id} x="-15%" y="-15%" width="130%" height="140%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="1.5" result="blur" />
        <feOffset in="blur" dx="0" dy="2" result="offset" />
        <feFlood floodColor="var(--color-empty-shadow)" floodOpacity="1" result="color" />
        <feComposite in="color" in2="offset" operator="in" result="shadow" />
        <feMerge>
          <feMergeNode in="shadow" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

function AccentPlusBadge({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r="9" fill="var(--color-empty-accent)" />
      <path
        d={`M${cx - 3.5} ${cy}H${cx + 3.5}M${cx} ${cy - 3.5}V${cy + 3.5}`}
        stroke="var(--color-white)"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </g>
  );
}

function useFilterId(prefix: string) {
  return `${prefix}-${useId().replaceAll(":", "")}`;
}

export function WorkspaceWireframe({
  accent = true,
  className,
}: {
  accent?: boolean;
  className?: string;
}) {
  const shadow = useFilterId("wf-ws");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 120 90"
      className={cn("h-[5.625rem] w-[7.5rem] shrink-0", className)}
    >
      <WireframeShadowFilter id={shadow} />
      <g filter={`url(#${shadow})`}>
        <rect
          x="16"
          y="15"
          width="88"
          height="60"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
      </g>
      <line
        x1="42"
        y1="15.5"
        x2="42"
        y2="74.5"
        stroke="var(--color-empty-border)"
        strokeWidth="1"
      />
      <rect x="22" y="24" width="14" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="22" y="35" width="14" height="4" rx="2" fill="var(--color-empty-bar)" />
      <rect x="22" y="44" width="11" height="4" rx="2" fill="var(--color-empty-slot)" />
      <rect x="22" y="53" width="13" height="4" rx="2" fill="var(--color-empty-slot)" />
      <rect x="50" y="24" width="28" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="50" y="35" width="44" height="12" rx="4" fill="var(--color-empty-slot)" />
      <rect x="50" y="52" width="32" height="4" rx="2" fill="var(--color-empty-bar)" />
      <rect x="50" y="60" width="22" height="4" rx="2" fill="var(--color-empty-slot)" />
      {accent && <AccentPlusBadge cx={96} cy={67} />}
    </svg>
  );
}

export function ChatWireframe({
  accent = false,
  className,
}: {
  accent?: boolean;
  className?: string;
}) {
  const shadow = useFilterId("wf-chat");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 120 90"
      className={cn("h-[5.625rem] w-[7.5rem] shrink-0", className)}
    >
      <WireframeShadowFilter id={shadow} />
      <g filter={`url(#${shadow})`}>
        <rect
          x="16"
          y="16"
          width="68"
          height="26"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
        <rect
          x="36"
          y="48"
          width="68"
          height="26"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
      </g>
      <circle cx="28" cy="29" r="5" fill="var(--color-empty-slot)" />
      <rect x="38" y="24" width="22" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="38" y="32" width="36" height="4" rx="2" fill="var(--color-empty-bar)" />
      <circle cx="48" cy="61" r="5" fill="var(--color-empty-slot)" />
      <rect x="58" y="56" width="26" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="58" y="64" width="34" height="4" rx="2" fill="var(--color-empty-bar)" />
      {accent && <AccentPlusBadge cx={98} cy={69} />}
    </svg>
  );
}

export function TaskBoardWireframe({
  accent = true,
  className,
}: {
  accent?: boolean;
  className?: string;
}) {
  const shadow = useFilterId("wf-tasks");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 120 90"
      className={cn("h-[5.625rem] w-[7.5rem] shrink-0", className)}
    >
      <WireframeShadowFilter id={shadow} />
      <g filter={`url(#${shadow})`}>
        <rect
          x="16"
          y="16"
          width="40"
          height="58"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
        <rect
          x="64"
          y="16"
          width="40"
          height="58"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
      </g>
      <rect x="23" y="24" width="18" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="23" y="34" width="26" height="14" rx="5" fill="var(--color-empty-slot)" />
      <rect x="23" y="52" width="26" height="14" rx="5" fill="var(--color-empty-slot)" />
      <rect x="71" y="24" width="20" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="71" y="34" width="26" height="14" rx="5" fill="var(--color-empty-slot)" />
      <rect x="71" y="53" width="16" height="4" rx="2" fill="var(--color-empty-bar)" />
      {accent && <AccentPlusBadge cx={98} cy={68} />}
    </svg>
  );
}

export function MembersWireframe({
  accent = true,
  className,
}: {
  accent?: boolean;
  className?: string;
}) {
  const shadow = useFilterId("wf-members");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 120 90"
      className={cn("h-[5.625rem] w-[7.5rem] shrink-0", className)}
    >
      <WireframeShadowFilter id={shadow} />
      <g filter={`url(#${shadow})`}>
        <rect
          x="16"
          y="17"
          width="41"
          height="56"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
        <rect
          x="63"
          y="17"
          width="41"
          height="56"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
      </g>
      <circle cx="36.5" cy="34" r="7" fill="var(--color-empty-slot)" />
      <rect x="25" y="47" width="23" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="28" y="56" width="17" height="4" rx="2" fill="var(--color-empty-bar)" />
      <circle cx="83.5" cy="34" r="7" fill="var(--color-empty-slot)" />
      <rect x="72" y="47" width="23" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="75" y="56" width="17" height="4" rx="2" fill="var(--color-empty-bar)" />
      {accent && <AccentPlusBadge cx={98} cy={67} />}
    </svg>
  );
}

export function ComputersWireframe({
  accent = true,
  className,
}: {
  accent?: boolean;
  className?: string;
}) {
  const shadow = useFilterId("wf-comp");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 120 90"
      className={cn("h-[5.625rem] w-[7.5rem] shrink-0", className)}
    >
      <WireframeShadowFilter id={shadow} />
      <g filter={`url(#${shadow})`}>
        <rect
          x="18"
          y="16"
          width="84"
          height="52"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
      </g>
      <rect x="44" y="72" width="32" height="4" rx="2" fill="var(--color-empty-bar)" />
      <rect x="27" y="25" width="26" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="27" y="35" width="38" height="4" rx="2" fill="var(--color-empty-bar)" />
      <rect x="27" y="45" width="22" height="12" rx="4" fill="var(--color-empty-slot)" />
      <rect x="53" y="45" width="22" height="12" rx="4" fill="var(--color-empty-slot)" />
      {accent && <AccentPlusBadge cx={96} cy={62} />}
    </svg>
  );
}

export function GalleryWireframe({
  accent = false,
  className,
}: {
  accent?: boolean;
  className?: string;
}) {
  const shadow = useFilterId("wf-gallery");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 120 90"
      className={cn("h-[5.625rem] w-[7.5rem] shrink-0", className)}
    >
      <WireframeShadowFilter id={shadow} />
      <g filter={`url(#${shadow})`}>
        <rect
          x="16"
          y="16"
          width="41"
          height="58"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
        <rect
          x="63"
          y="16"
          width="41"
          height="58"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
      </g>
      <rect x="22" y="22" width="29" height="24" rx="5" fill="var(--color-empty-slot)" />
      <rect x="22" y="52" width="22" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="22" y="61" width="16" height="4" rx="2" fill="var(--color-empty-bar)" />
      <rect x="69" y="22" width="29" height="24" rx="5" fill="var(--color-empty-slot)" />
      <rect x="69" y="52" width="22" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="69" y="61" width="16" height="4" rx="2" fill="var(--color-empty-bar)" />
      {accent && <AccentPlusBadge cx={98} cy={68} />}
    </svg>
  );
}

export function RecordsWireframe({
  accent = false,
  className,
}: {
  accent?: boolean;
  className?: string;
}) {
  const shadow = useFilterId("wf-rec");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 120 90"
      className={cn("h-[5.625rem] w-[7.5rem] shrink-0", className)}
    >
      <WireframeShadowFilter id={shadow} />
      <g filter={`url(#${shadow})`}>
        <rect
          x="22"
          y="15"
          width="76"
          height="60"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
      </g>
      <rect x="32" y="25" width="30" height="5" rx="2.5" fill="var(--color-empty-title-bar)" />
      <rect x="32" y="36" width="56" height="4" rx="2" fill="var(--color-empty-bar)" />
      <rect x="32" y="45" width="46" height="4" rx="2" fill="var(--color-empty-bar)" />
      <rect x="32" y="55" width="56" height="10" rx="4" fill="var(--color-empty-slot)" />
      {accent && <AccentPlusBadge cx={92} cy={67} />}
    </svg>
  );
}

export function InboxDoneWireframe({ className }: { className?: string }) {
  const shadow = useFilterId("wf-done");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 120 90"
      className={cn("h-[5.625rem] w-[7.5rem] shrink-0", className)}
    >
      <WireframeShadowFilter id={shadow} />
      <g filter={`url(#${shadow})`}>
        <rect
          x="24"
          y="16"
          width="72"
          height="16"
          rx="8"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
        <rect
          x="18"
          y="28"
          width="84"
          height="46"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
      </g>
      <circle cx="60" cy="51" r="11" fill="var(--color-empty-slot)" />
      <path
        d="M55.5 51.2L58.6 54.3L64.8 48"
        fill="none"
        stroke="var(--color-empty-title-bar)"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NoResultsWireframe({ className }: { className?: string }) {
  const shadow = useFilterId("wf-nores");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 80 60"
      className={cn("h-[3.75rem] w-[5rem] shrink-0", className)}
    >
      <WireframeShadowFilter id={shadow} />
      <g filter={`url(#${shadow})`}>
        <rect
          x="14"
          y="14"
          width="52"
          height="32"
          rx="9"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
      </g>
      <circle
        cx="27"
        cy="29"
        r="4.5"
        fill="none"
        stroke="var(--color-empty-title-bar)"
        strokeWidth="1.5"
      />
      <path
        d="M30.4 32.4L33 35"
        stroke="var(--color-empty-title-bar)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <rect x="38" y="24" width="20" height="4.5" rx="2.25" fill="var(--color-empty-bar)" />
      <rect x="38" y="32" width="14" height="4" rx="2" fill="var(--color-empty-slot)" />
    </svg>
  );
}

export function LockedWireframe({ className }: { className?: string }) {
  const shadow = useFilterId("wf-lock");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 120 90"
      className={cn("h-[5.625rem] w-[7.5rem] shrink-0", className)}
    >
      <WireframeShadowFilter id={shadow} />
      <g filter={`url(#${shadow})`}>
        <rect
          x="20"
          y="16"
          width="80"
          height="58"
          rx="10"
          fill="var(--color-empty-card)"
          stroke="var(--color-empty-border)"
          strokeWidth="1"
        />
      </g>
      <rect x="30" y="26" width="24" height="5" rx="2.5" fill="var(--color-empty-slot)" />
      <rect x="30" y="36" width="60" height="4" rx="2" fill="var(--color-empty-slot)" />
      <rect x="30" y="45" width="44" height="4" rx="2" fill="var(--color-empty-slot)" />
      <rect x="30" y="55" width="52" height="9" rx="4" fill="var(--color-empty-slot)" />
      <circle
        cx="84"
        cy="56"
        r="13"
        fill="var(--color-empty-card)"
        stroke="var(--color-empty-border)"
        strokeWidth="1"
      />
      <rect
        x="79"
        y="55.5"
        width="10"
        height="7.5"
        rx="2"
        fill="var(--color-empty-bar)"
        stroke="var(--color-empty-title-bar)"
        strokeWidth="1.4"
      />
      <path
        d="M81 55.5V53.2C81 51.5 82.3 50.2 84 50.2C85.7 50.2 87 51.5 87 53.2V55.5"
        fill="none"
        stroke="var(--color-empty-title-bar)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
