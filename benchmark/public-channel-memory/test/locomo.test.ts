import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLocomoDateTime, turnBody } from "../src/locomo-time";
import { loadLocomoSample, LOCOMO10_SHA256, sha256Hex } from "../src/locomo";

test("parses LoCoMo session stamps into UTC instants", () => {
  expect(parseLocomoDateTime("9:36 am on 2 April, 2023", 0).toISOString()).toBe(
    "2023-04-02T09:36:00.000Z",
  );
  expect(parseLocomoDateTime("2:05 pm on 15 December, 2022", 0).toISOString()).toBe(
    "2022-12-15T14:05:00.000Z",
  );
});

test("renders photo turns as caption text without image URLs", () => {
  expect(turnBody({ text: "look", blipCaption: "a lake", query: "lake" })).toContain(
    "image description: a lake",
  );
  expect(turnBody({ text: "look", blipCaption: "a lake" })).not.toContain("http");
});

// A made-up sample in the LoCoMo layout, so the test reads neither the dataset nor its location.
const SAMPLE = [
  { sample_id: "other", conversation: { speaker_a: "X", speaker_b: "Y" }, qa: [] },
  {
    sample_id: "conv-fixture",
    conversation: {
      speaker_a: "Ada",
      speaker_b: "Ben",
      session_10_date_time: "2:05 pm on 15 December, 2022",
      session_10: [{ speaker: "Ben", text: "late" }],
      session_2_date_time: "9:36 am on 2 April, 2023",
      session_2: [
        { speaker: "Ada", text: "hello" },
        { speaker: "Ben", text: "look", blip_caption: "a lake", query: "lake" },
      ],
    },
    qa: [
      { question: "q0", answer: "a0", category: 1, evidence: ["D2:1"] },
      { question: "q1", answer: "a1", category: 5 },
      { question: "q2", answer: 2022, category: 2, question_time: "t" },
      { question: "q3", answer: "a3", category: 4 },
    ],
  },
];

async function withSampleFile(run: (path: string, pin: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "locomo-test-"));
  try {
    const raw = JSON.stringify(SAMPLE);
    const path = join(dir, "locomo.json");
    await writeFile(path, raw, "utf8");
    await run(path, sha256Hex(raw));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loads a pinned sample's sessions in number order and its headline questions", async () => {
  await withSampleFile(async (path, pin) => {
    const sample = await loadLocomoSample(path, "conv-fixture", 2, pin, [1, 2, 3, 4]);
    expect(sample.speakerA).toBe("Ada");
    expect(sample.speakerB).toBe("Ben");
    expect(sample.sessions.map((session) => session.sessionNumber)).toEqual([2, 10]);
    expect(sample.sessions[0]!.occurredAt.toISOString()).toBe("2023-04-02T09:36:00.000Z");
    expect(sample.sessions[0]!.turns[1]).toEqual({
      speaker: "Ben",
      text: "look",
      blipCaption: "a lake",
      query: "lake",
    });
    // Category 5 is outside the headline scope; the limit counts kept questions only.
    expect(sample.questions.map((question) => [question.questionIndex, question.answer])).toEqual([
      [0, "a0"],
      [2, "2022"],
    ]);
  });
});

test("refuses, by default, a dataset that is not the pinned locomo10", async () => {
  await withSampleFile(async (path) => {
    await expect(loadLocomoSample(path, "conv-fixture", 2)).rejects.toThrow(
      `locomo pin mismatch expected=${LOCOMO10_SHA256}`,
    );
  });
});
