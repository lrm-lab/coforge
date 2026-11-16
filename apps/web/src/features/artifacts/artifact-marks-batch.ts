import { loadArtifactMarks } from "./artifact-gallery.functions";

export type ArtifactMarks = Awaited<ReturnType<typeof loadArtifactMarks>>[number];

const MARKS_PER_REQUEST = 100;

type Waiting = { resolve: (marks: ArtifactMarks | null) => void; reject: (error: unknown) => void };

let waiting = new Map<string, Waiting[]>();
let scheduled = false;

async function flush(): Promise<void> {
  const batch = waiting;
  waiting = new Map();
  scheduled = false;
  const ids = [...batch.keys()];
  const chunks: string[][] = [];
  for (let from = 0; from < ids.length; from += MARKS_PER_REQUEST)
    chunks.push(ids.slice(from, from + MARKS_PER_REQUEST));
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const marks = new Map(
          (await loadArtifactMarks({ data: { artifactIds: chunk } })).map((mark) => [
            mark.id,
            mark,
          ]),
        );
        for (const id of chunk)
          for (const one of batch.get(id) ?? []) one.resolve(marks.get(id) ?? null);
      } catch (error) {
        for (const id of chunk) for (const one of batch.get(id) ?? []) one.reject(error);
      }
    }),
  );
}

export function loadArtifactMarksBatched(artifactId: string): Promise<ArtifactMarks | null> {
  return new Promise((resolve, reject) => {
    const queue = waiting.get(artifactId);
    if (queue) queue.push({ resolve, reject });
    else waiting.set(artifactId, [{ resolve, reject }]);
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => void flush(), 0);
  });
}
