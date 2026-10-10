export type MemoryWeek = { year: number; week: number };

export type WeeklyReportMemory = {
  version: 1;
  habits: Array<{ statement: string; status: "active" | "retired" }>;
  observations: Array<{ statement: string; weeks: MemoryWeek[] }>;
  threads: Array<{
    title: string;
    status: "open" | "done";
    /** Settlements that skipped this thread after any done-item carry was used. */
    quiet: number;
    /** A just-finished thread stays through the next settlement before quiet starts. */
    carry: boolean;
  }>;
};

export type MemorySettlement = {
  year: number;
  week: number;
  preferences: string[];
  explicitRules: Array<{ statement: string; effect: "adopt" | "retire" }>;
  factCorrections: string[];
  threads: Array<{ title: string; status: "open" | "done" }>;
};

export function buildWeeklyReportMemoryWakeText(input: {
  reportId: string;
  year: number;
  week: number;
  draftMarkdown: string;
  finalMarkdown: string;
  userLines: readonly string[];
}): string {
  const lines = input.userLines.map((line) => line.trim()).filter((line) => line.length > 0);
  return [
    "[weekly-report-memory]",
    `reportId: ${input.reportId}`,
    `week: ${input.year} W${input.week}`,
    "",
    "请对照助手原稿和作者最终正文，总结这份周报的写作偏好、明示规则、事实纠正和事项状态。",
    "事实纠正只属于本周，不要写成以后的习惯。",
    "用户说出「以后都这样写」时，explicitRules.effect 用 adopt；说出「不要再这样写」时用 retire。",
    "没有助手原稿时，preferences 和 explicitRules 留空，只根据最终正文填写 threads。",
    "然后用下面的命令提交 JSON 文件，不要用 body-edit Confirm：",
    "",
    `coforge weekly-report-memory submit --report-id ${input.reportId} --idempotency-key <uuid> --file <json>`,
    "",
    "JSON 形状（按对照结果填写，不要原样提交示例）：",
    '{"year":2026,"week":40,"preferences":["一条偏好"],"explicitRules":[{"statement":"一条明示规则","effect":"adopt"}],"factCorrections":["一条本周事实纠正"],"threads":[{"title":"一件事项","status":"open"}]}',
    "",
    "## 助手原稿",
    input.draftMarkdown.trim() || "(无)",
    "",
    "## 最终正文",
    input.finalMarkdown.trim() || "(无)",
    "",
    "## 用户原话",
    ...(lines.length > 0 ? lines.map((line) => `- ${line}`) : ["(无)"]),
  ].join("\n");
}

export function parseStoredWeeklyReportMemory(value: unknown): WeeklyReportMemory {
  if (!value || typeof value !== "object") return emptyWeeklyReportMemory();
  const record = value as Partial<WeeklyReportMemory>;
  if (record.version !== 1) return emptyWeeklyReportMemory();
  return {
    version: 1,
    habits: Array.isArray(record.habits) ? record.habits : [],
    observations: Array.isArray(record.observations) ? record.observations : [],
    threads: Array.isArray(record.threads) ? record.threads : [],
  };
}

export function emptyWeeklyReportMemory(): WeeklyReportMemory {
  return { version: 1, habits: [], observations: [], threads: [] };
}

export function formatMemoryPromptSection(prompt: {
  writingHabits: readonly string[];
  openThreads: ReadonlyArray<{ title: string; status: "open" | "done" }>;
}): string {
  const habits =
    prompt.writingHabits.length > 0
      ? prompt.writingHabits.map((habit) => `- ${habit}`).join("\n")
      : "(无)";
  const threads =
    prompt.openThreads.length > 0
      ? prompt.openThreads
          .map(
            (thread) => `- ${thread.title}：${thread.status === "done" ? "上周已完成" : "进行中"}`,
          )
          .join("\n")
      : "(无)";
  return [
    "## 写作习惯",
    habits,
    "",
    "## 事项延续",
    threads,
    "",
    "整理时参照上一份已提交周报。没有历史内容时不要编造延续。",
  ].join("\n");
}

export function memoryForPrompt(memory: WeeklyReportMemory): {
  writingHabits: string[];
  openThreads: Array<{ title: string; status: "open" | "done" }>;
} {
  return {
    writingHabits: memory.habits
      .filter((habit) => habit.status === "active")
      .map((habit) => habit.statement),
    openThreads: memory.threads.map((thread) => ({
      title: thread.title,
      status: thread.status,
    })),
  };
}

function memoryText(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function sameWeek(left: MemoryWeek, right: MemoryWeek): boolean {
  return left.year === right.year && left.week === right.week;
}

export function applyMemorySettlement(
  memory: WeeklyReportMemory,
  settlement: MemorySettlement,
): WeeklyReportMemory {
  const week = { year: settlement.year, week: settlement.week };
  const habits = memory.habits.map((habit) => ({ ...habit }));
  const observations = memory.observations.map((observation) => ({
    statement: observation.statement,
    weeks: observation.weeks.map((item) => ({ ...item })),
  }));

  const setHabit = (statement: string, status: "active" | "retired") => {
    const existing = habits.find((habit) => habit.statement === statement);
    if (existing) {
      existing.status = status;
      return;
    }
    habits.push({ statement, status });
  };

  for (const preference of settlement.preferences) {
    const statement = memoryText(preference);
    if (!statement) continue;
    const observation = observations.find((item) => item.statement === statement);
    if (!observation) {
      observations.push({ statement, weeks: [week] });
      continue;
    }
    if (!observation.weeks.some((item) => sameWeek(item, week))) {
      observation.weeks.push(week);
    }
    if (observation.weeks.length >= 2 && !habits.some((habit) => habit.statement === statement)) {
      habits.push({ statement, status: "active" });
    }
  }

  for (const rule of settlement.explicitRules) {
    const statement = memoryText(rule.statement);
    if (!statement) continue;
    setHabit(statement, rule.effect === "adopt" ? "active" : "retired");
  }

  const mentioned = settlement.threads
    .map((thread) => ({ title: memoryText(thread.title), status: thread.status }))
    .filter((thread) => thread.title.length > 0);
  const threads = memory.threads
    .map((thread) => {
      const incoming = mentioned.find((item) => item.title === thread.title);
      if (incoming) {
        return {
          title: thread.title,
          status: incoming.status,
          quiet: 0,
          carry: incoming.status === "done",
        };
      }
      if (thread.carry) return { ...thread, carry: false };
      return { ...thread, quiet: thread.quiet + 1 };
    })
    .filter((thread) => thread.quiet < 2);
  for (const incoming of mentioned) {
    if (threads.some((thread) => thread.title === incoming.title)) continue;
    threads.push({
      title: incoming.title,
      status: incoming.status,
      quiet: 0,
      carry: incoming.status === "done",
    });
  }

  return { version: 1, habits, observations, threads };
}
