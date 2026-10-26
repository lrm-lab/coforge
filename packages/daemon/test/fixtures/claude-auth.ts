import {
  ClaudeRuntimeAuthAdapter,
  type ClaudeAuthProcess,
  type ClaudeAuthProcessFactory,
} from "#src/code-agent/claude-code/auth";

/** A scripted `claude auth ...` child: the test pushes stdout text and decides when it exits. */
export class FakeAuthProcess implements ClaudeAuthProcess {
  readonly written: string[] = [];
  killed = false;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  #push!: (text: string) => void;
  #pushError!: (text: string) => void;
  #close!: () => void;
  #closeError!: () => void;
  #exit!: (code: number) => void;
  constructor() {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        this.#push = (text) => controller.enqueue(encoder.encode(text));
        this.#close = () => controller.close();
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        this.#pushError = (text) => controller.enqueue(encoder.encode(text));
        this.#closeError = () => controller.close();
      },
    });
    this.exited = new Promise<number>((resolve) => (this.#exit = resolve));
  }
  write(text: string) {
    this.written.push(text);
  }
  kill() {
    this.killed = true;
    this.finish(143);
  }
  say(text: string) {
    this.#push(text);
  }
  complain(text: string) {
    this.#pushError(text);
  }
  finish(code: number) {
    try {
      this.#close();
      this.#closeError();
    } catch {
      // Already closed by an earlier finish.
    }
    this.#exit(code);
  }
}

export const OAUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&state=xyz";
export const STATUS_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "someone.long@example.com",
  subscriptionType: "max",
});

/** `claude auth status --json` answers `statusOutput`; `claude auth login` is the scripted child. */
export function adapterWith(
  login: FakeAuthProcess,
  statusOutput = STATUS_IN,
  version = "2.1.310 (Claude Code)",
) {
  const commands: string[][] = [];
  const create: ClaudeAuthProcessFactory = (command) => {
    commands.push([...command]);
    if (command[2] === "login") return login;
    const process = new FakeAuthProcess();
    queueMicrotask(() => {
      process.say(command[1] === "--version" ? version : statusOutput);
      process.finish(command[2] === "logout" ? 0 : 0);
    });
    return process;
  };
  return { adapter: new ClaudeRuntimeAuthAdapter({ create }), commands };
}
