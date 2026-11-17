import { CliError } from "../cli-error";

type KeyInput = {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
  off: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
};

const CTRL_C = "\u0003";
const BACKSPACE = "\u007f";

function cancelled(): CliError {
  return new CliError({ code: "LOGIN_CANCELLED", message: "Sign-in cancelled.", retryable: false });
}

export function readHiddenLine(input: KeyInput, prompt: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let line = "";
    const finish = (settle: () => void) => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      prompt("\n");
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return finish(() => resolve(line));
        if (char === CTRL_C) return finish(() => reject(cancelled()));
        if (char === BACKSPACE) line = line.slice(0, -1);
        else line += char;
      }
    };
    prompt("Agent key: ");
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
  });
}

export async function readFirstLine(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const end = text.indexOf("\n");
    if (end >= 0) return text.slice(0, end).replace(/\r$/, "");
  }
  return text.replace(/\r$/, "");
}
