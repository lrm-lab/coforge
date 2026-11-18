import { expect, test } from "bun:test";
import { publishConcurrently } from "#src/server/conversations/concurrent-publication.server";

const gate = () => {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release };
};

test("the push starts while the browser announcement is still pending", async () => {
  const events: string[] = [];
  const browser = gate();
  const sent = publishConcurrently(
    (async () => {
      events.push("browser:start");
      await browser.opened;
      events.push("browser:end");
    })(),
    async () => {
      events.push("push:start");
      return "pushed";
    },
  );
  await Bun.sleep(5);
  expect(events).toEqual(["browser:start", "push:start"]);
  browser.release();
  expect(await sent).toBe("pushed");
  expect(events).toEqual(["browser:start", "push:start", "browser:end"]);
});

test("a push that rejects fails the send only after the announcement has finished", async () => {
  const browser = gate();
  let announced = false;
  const sent = publishConcurrently(
    browser.opened.then(() => void (announced = true)),
    async () => {
      throw new Error("push failed");
    },
  );
  const outcome = sent.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  await Bun.sleep(5);
  expect(announced).toBe(false);
  browser.release();
  expect(await outcome).toBe("push failed");
  expect(announced).toBe(true);
});

test("a push that throws before returning a promise still waits for the announcement", async () => {
  const browser = gate();
  let announced = false;
  const outcome = publishConcurrently(
    browser.opened.then(() => void (announced = true)),
    () => {
      throw new Error("sync failure");
    },
  ).then(
    () => "resolved",
    (error: Error) => error.message,
  );
  browser.release();
  expect(await outcome).toBe("sync failure");
  expect(announced).toBe(true);
});

test("an announcement that rejects fails the send when the push succeeded, and the push error wins otherwise", async () => {
  await expect(
    publishConcurrently(Promise.reject(new Error("announce failed")), async () => "ok"),
  ).rejects.toThrow("announce failed");
  await expect(
    publishConcurrently(Promise.reject(new Error("announce failed")), async () => {
      throw new Error("push failed");
    }),
  ).rejects.toThrow("push failed");
});
