import ai01 from "./v1/ai-01.webp?url";
import ai02 from "./v1/ai-02.webp?url";
import ai03 from "./v1/ai-03.webp?url";
import ai04 from "./v1/ai-04.webp?url";
import ai05 from "./v1/ai-05.webp?url";
import ai06 from "./v1/ai-06.webp?url";
import ai07 from "./v1/ai-07.webp?url";
import ai08 from "./v1/ai-08.webp?url";
import ai09 from "./v1/ai-09.webp?url";
import ai10 from "./v1/ai-10.webp?url";
import ai11 from "./v1/ai-11.webp?url";
import ai12 from "./v1/ai-12.webp?url";
import ai13 from "./v1/ai-13.webp?url";
import ai14 from "./v1/ai-14.webp?url";
import ai15 from "./v1/ai-15.webp?url";
import ai16 from "./v1/ai-16.webp?url";
import ai17 from "./v1/ai-17.webp?url";
import ai18 from "./v1/ai-18.webp?url";
import ai19 from "./v1/ai-19.webp?url";
import ai20 from "./v1/ai-20.webp?url";
import ai21 from "./v1/ai-21.webp?url";
import ai22 from "./v1/ai-22.webp?url";
import ai23 from "./v1/ai-23.webp?url";
import ai24 from "./v1/ai-24.webp?url";

/**
 * The pool's pictures as the browser loads them: Vite's `?url` gives each file a content-hashed
 * address, so replacing a picture invalidates every cached copy by itself. Used only to preview
 * a choice in the change-avatar dialog; an Agent's avatar is always its own stored copy. The
 * server's pool (`server/agents/agent-avatar-pictures.server.ts`) must hold the same ids.
 */
const urls: string[] = [
  ai01,
  ai02,
  ai03,
  ai04,
  ai05,
  ai06,
  ai07,
  ai08,
  ai09,
  ai10,
  ai11,
  ai12,
  ai13,
  ai14,
  ai15,
  ai16,
  ai17,
  ai18,
  ai19,
  ai20,
  ai21,
  ai22,
  ai23,
  ai24,
];

export const agentAvatarPictures: ReadonlyArray<{ id: string; url: string }> = urls.map(
  (url, index) => ({ id: `ai-${String(index + 1).padStart(2, "0")}`, url }),
);
