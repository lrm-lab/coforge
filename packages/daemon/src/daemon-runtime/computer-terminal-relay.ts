import type {
  ComputerTerminalControl,
  ComputerTerminalFrame,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";
import { isCurrentTerminalAttach } from "@lrm/coforge-sdk/internal/computer-terminal-replay";
import { createComputerTerminalSession } from "./computer-terminal-composition";

const FRAME_OVERHEAD_BYTES = 2048;
const OUTPUT_QUEUE_BYTES = 2 * 1024 * 1024;
const TERMINAL_EVENT_RESERVE_BYTES = 2 * FRAME_OVERHEAD_BYTES;

type FrameQueueItem = { frame: ComputerTerminalFrame; bytes: number };
export type ComputerTerminalSessionFactory = typeof createComputerTerminalSession;

export class ComputerTerminalRelay {
  #session: ReturnType<ComputerTerminalSessionFactory> | undefined;
  #queue: FrameQueueItem[] = [];
  #queuedBytes = 0;
  #sending = false;
  #stopped = false;

  constructor(
    private readonly options: {
      workspaceId: string;
      computerId: string;
      daemonInstanceId: string;
      send(frame: ComputerTerminalFrame): Promise<void>;
      create?: ComputerTerminalSessionFactory;
    },
  ) {}

  async control(command: ComputerTerminalControl): Promise<void> {
    if (
      this.#stopped ||
      command.workspaceId !== this.options.workspaceId ||
      command.computerId !== this.options.computerId
    )
      return;

    if (!this.#session && command.command.case === "openOrAttach") {
      const {
        workspaceId,
        computerId,
        daemonInstanceId,
        create = createComputerTerminalSession,
      } = this.options;
      this.#session = create({
        workspaceId,
        computerId,
        daemonInstanceId,
        ownerUserId: command.ownerUserId,
        emit: (frame) => this.#emit(frame),
        canReplay: ({ frames, bytes }) =>
          this.#queuedBytes + (frames + 1) * FRAME_OVERHEAD_BYTES + bytes <= OUTPUT_QUEUE_BYTES,
      });
    }
    await this.#session?.control(command);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearQueue();
    await this.#session?.stop();
  }

  #emit(frame: ComputerTerminalFrame): boolean {
    if (this.#stopped) return false;
    const event = frame.event;
    const isOutput = event.case === "output" || event.case === "snapshot";
    const bytes = FRAME_OVERHEAD_BYTES + (isOutput ? event.value.bytes.byteLength : 0);
    const limit =
      event.case === "error" || event.case === "closed"
        ? OUTPUT_QUEUE_BYTES + TERMINAL_EVENT_RESERVE_BYTES
        : OUTPUT_QUEUE_BYTES;
    if (this.#queuedBytes + bytes > limit) return false;
    this.#queuedBytes += bytes;
    this.#queue.push({ frame, bytes });
    if (!this.#sending) void this.#drain();
    return true;
  }

  async #drain(): Promise<void> {
    this.#sending = true;
    try {
      for (let item = this.#queue.shift(); item; item = this.#queue.shift()) {
        try {
          await this.options.send(item.frame);
        } catch {
          this.#session?.suspendAttachment(item.frame);
          this.#queue = this.#queue.filter(
            ({ frame }) => !isCurrentTerminalAttach(item.frame, frame),
          );
          this.#queuedBytes = this.#queue.reduce((sum, queued) => sum + queued.bytes, item.bytes);
        }
        this.#queuedBytes = Math.max(0, this.#queuedBytes - item.bytes);
      }
    } finally {
      this.#sending = false;
    }
  }

  #clearQueue(): void {
    this.#queue = [];
    this.#queuedBytes = 0;
  }
}
