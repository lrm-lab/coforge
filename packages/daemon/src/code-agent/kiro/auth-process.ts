import type { OwnedProcessTree } from "@lrm/coforge-anvil";
import { cleanupOwnedTree } from "@lrm/coforge-anvil/execution";
import type { KiroAuthProcess } from "@lrm/coforge-anvil/kiro";

/** Adapt the shared process owner to Kiro's byte stream without owning another launch path. */
export function kiroAuthProcess(tree: OwnedProcessTree): KiroAuthProcess {
  let cancelled = false;
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      const pump = async (stream: AsyncIterable<Uint8Array>) => {
        for await (const bytes of stream) if (!cancelled) controller.enqueue(bytes);
      };
      void Promise.all([pump(tree.child.stdout), pump(tree.child.stderr)]).then(
        () => {
          if (!cancelled) controller.close();
        },
        () => {
          if (!cancelled) controller.error(new Error("Authentication output closed"));
        },
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  let disposal: Promise<void> | undefined;
  return {
    output,
    exited: tree.child.exited,
    write(text) {
      tree.child.stdin.write(text);
    },
    dispose() {
      return (disposal ??= cleanupOwnedTree(tree, tree.child));
    },
  };
}
