const TASK_TITLE_ARIA = /^(?:Task|任务) #\d+$/;
const TASK_TRAIL_SELECTOR = 'nav[aria-label="Where this task is"], nav[aria-label="任务所在位置"]';
const TASK_SECTION_SELECTOR = 'section[aria-label^="Task #"], section[aria-label^="任务 #"]';
const TASK_CONTAINER_QUERY = `${TASK_SECTION_SELECTOR}, [role="dialog"]`;

export const taskDetailPanels = `[...document.querySelectorAll(${JSON.stringify(TASK_CONTAINER_QUERY)})].filter((el) => ${TASK_TITLE_ARIA.toString()}.test(el.getAttribute("aria-label") ?? "") || (el.getAttribute("role") === "dialog" && el.querySelector(${JSON.stringify(TASK_TRAIL_SELECTOR)}) !== null))`;

export const taskDetail = `(${taskDetailPanels}[0] ?? null)`;

export const topTaskDetail = `(${taskDetailPanels}.at(-1) ?? null)`;

export function nonTaskDialogs(excludePeeks = false): string {
  const base = `[...document.querySelectorAll('[role="dialog"]')].filter((el) => !${taskDetailPanels}.includes(el)`;
  return excludePeeks ? `${base} && el.dataset.trigger !== "PreviewTrigger")` : `${base})`;
}

export function taskDetailChildSelector(childSelector: string): string {
  return `section[aria-label^="Task #"] ${childSelector}, section[aria-label^="任务 #"] ${childSelector}, [role="dialog"] ${childSelector}`;
}

export const taskDetailClosestSelector = `${TASK_SECTION_SELECTOR}, [role="dialog"]`;

export const taskDetailSheetEntered = `[...document.querySelectorAll("[data-detent-sheet]")].every((sheet) => sheet.getBoundingClientRect().top <= innerHeight * 0.45)`;
