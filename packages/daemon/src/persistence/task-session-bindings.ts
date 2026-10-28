import type { TaskExecutionScope } from "@lrm/coforge-sdk/internal";
import type { TaskSessionBindings } from "#src/agent-runtime/task-execution-sessions";
import { writePrivateJsonRecord } from "./private-json-record";

/** Session bindings and recovery metadata only; never a message queue or job scheduler. */
export class FileTaskSessionBindings implements TaskSessionBindings {
  #pending = Promise.resolve();
  constructor(private readonly path: string) {}

  async read(control: string): Promise<TaskExecutionScope[]> {
    await this.#pending;
    return (await this.#read())[control] ?? [];
  }

  write(control: string, tasks: TaskExecutionScope[]): Promise<void> {
    const write = this.#pending.then(async () => {
      const records = await this.#read();
      records[control] = tasks;
      await writePrivateJsonRecord(this.path, records);
    });
    this.#pending = write.catch(() => {});
    return write;
  }

  end(executionSessionId: string, attempt: number): Promise<void> {
    const write = this.#pending.then(async () => {
      const records = await this.#read();
      for (const control of Object.keys(records))
        records[control] = records[control]!.filter(
          (task) => task.executionSessionId !== executionSessionId || task.attempt !== attempt,
        );
      await writePrivateJsonRecord(this.path, records);
    });
    this.#pending = write.catch(() => {});
    return write;
  }

  async #read(): Promise<Record<string, TaskExecutionScope[]>> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return {};
    const value: unknown = await file.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid task session bindings");
    for (const tasks of Object.values(value)) {
      if (
        !Array.isArray(tasks) ||
        tasks.some(
          (task) =>
            !task ||
            typeof task !== "object" ||
            typeof task.executionSessionId !== "string" ||
            typeof task.target !== "string" ||
            typeof task.conversationId !== "string" ||
            typeof task.messageId !== "string" ||
            typeof task.title !== "string" ||
            !Number.isSafeInteger(task.attempt) ||
            task.attempt < 1 ||
            !Number.isSafeInteger(task.number) ||
            task.number < 1 ||
            !Number.isSafeInteger(task.revision),
        )
      )
        throw new Error("Invalid task session binding");
    }
    return value as Record<string, TaskExecutionScope[]>;
  }
}
