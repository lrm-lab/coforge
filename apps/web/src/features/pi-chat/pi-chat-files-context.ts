import { createContext, useContext } from "react";

export const PiChatFilesContext = createContext<{
  supported: boolean;
  open(path?: string): void;
}>({ supported: false, open: () => {} });

export function usePiChatFiles() {
  return useContext(PiChatFilesContext);
}

/** Keep web links and anchors in Markdown; local paths open the Computer's file viewer. */
export function piChatLocalPath(value: string) {
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  )
    return undefined;
  try {
    return decodeURIComponent(value).replace(/#L?\d+(?:-L?\d+)?$/, "");
  } catch {
    return undefined;
  }
}
