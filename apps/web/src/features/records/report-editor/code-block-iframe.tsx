"use client";

import { cn } from "#src/lib/utils";

interface CodeBlockIframeProps {
  html: string;
  title: string;
  className?: string;
  heightClassName?: string;
}

export function CodeBlockIframe({
  html,
  title,
  className,
  heightClassName = "h-[30rem]",
}: CodeBlockIframeProps) {
  return (
    <iframe
      srcDoc={html}
      sandbox="allow-scripts"
      aria-label={title}
      className={cn(
        "w-full rounded-md border border-secondary bg-primary",
        heightClassName,
        className,
      )}
    />
  );
}
