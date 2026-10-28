import type { OwnedProcessTree } from "@lrm/coforge-anvil";
import { cleanupOwnedTree } from "@lrm/coforge-anvil/execution";

/** The byte-stream view a native CLI's auth adapter reads (Kiro, Devin): stdout and stderr merged,
 * written through stdin, disposed through the shared process owner, no second launch path. */
export interface RuntimeAuthProcess {
  readonly output: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  write(text: string): void;
  dispose(): Promise<void>;
}

export function runtimeAuthProcess(tree: OwnedProcessTree): RuntimeAuthProcess {
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
