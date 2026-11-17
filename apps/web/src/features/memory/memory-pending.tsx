import * as m from "#src/paraglide/messages";

export function MemoryPending() {
  return (
    <p role="status" className="p-5 text-sm text-tertiary">
      {m.memory_loading()}
    </p>
  );
}
