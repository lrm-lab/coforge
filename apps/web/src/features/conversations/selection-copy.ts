import { readableBody } from "@lrm/coforge-sdk/internal";

import { copyText } from "#src/lib/clipboard";

type TurndownInstance = {
  turndown: (html: string) => string;
};

let turndownPromise: Promise<TurndownInstance> | undefined;

async function loadTurndown(): Promise<TurndownInstance> {
  if (!turndownPromise) {
    turndownPromise = Promise.all([import("turndown"), import("turndown-plugin-gfm")])
      .then(([{ default: TurndownService }, { gfm }]) => {
        const service = new TurndownService({
          bulletListMarker: "-",
          codeBlockStyle: "fenced",
          emDelimiter: "*",
          headingStyle: "atx",
        });
        service.use(gfm);
        service.addRule("channelReference", {
          filter: (node) =>
            node.nodeName === "A" &&
            (node.hasAttribute("data-channel-id") || node.hasAttribute("data-thread-root-id")),
          replacement: (content) => content,
        });
        service.addRule("inlineArtifactEmbed", {
          filter: (node) => node.nodeType === 1 && node.hasAttribute("data-artifact-inline-embed"),
          replacement: () => "",
        });
        return service;
      })
      .catch((error) => {
        turndownPromise = undefined;
        throw error;
      });
  }
  return turndownPromise;
}

export function selectionFragmentHtml(range: Range): string {
  const holder = document.createElement("div");
  holder.appendChild(range.cloneContents());
  return holder.innerHTML;
}

export async function fragmentHtmlToMarkdown(html: string): Promise<string> {
  const service = await loadTurndown();
  return service.turndown(html).trim();
}

export async function copyFragmentStyled(html: string, plainText: string): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
      return true;
    } catch {}
  }
  return copyText(plainText);
}

export async function copyFragmentMarkdown(html: string): Promise<boolean> {
  return copyText(await fragmentHtmlToMarkdown(html));
}

export function messagePlainText(
  message: {
    body: string;
    mentions?: readonly {
      kind: "user" | "agent";
      actorId: string;
      handle: string;
      label: string;
    }[];
  },
  channelNames?: ReadonlyMap<string, string>,
): string {
  return readableBody(message.body, {
    mention: (kind, id) =>
      message.mentions?.find(
        (candidate) => candidate.kind === kind && candidate.actorId.toLowerCase() === id,
      )?.label,
    channelName: (id) => channelNames?.get(id),
  });
}
