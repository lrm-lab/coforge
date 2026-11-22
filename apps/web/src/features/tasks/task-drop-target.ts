export type DropState = "open" | "blocked" | "idle";

export function dropTargetClass(state: DropState, isOver: boolean) {
  const base = "relative *:transition-opacity";
  if (state === "blocked") return `${base} *:opacity-40`;
  if (state !== "open") return base;
  return `${base} after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-brand-solid/10 after:ring-inset ${
    isOver ? "after:ring-2 after:ring-brand" : "after:ring-1 after:ring-brand/60"
  }`;
}
