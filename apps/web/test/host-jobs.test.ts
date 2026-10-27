import { describe, expect, test } from "bun:test";
import { HostJobError } from "#src/server/hosts/host-jobs.server";
import { createHostJobHttpHandler } from "#src/server/hosts/host-job-http.server";
import {
  now,
  daemonKey,
  defaultCloudName,
  extraCloudName,
  request,
  hostsFor,
  harness,
} from "./support/host-jobs-harness";

describe("cloud computer quota", () => {
  test("a submitted nickname names the computer once", async () => {
    let nickname = "Ada Lovelace";
    const { hosts } = harness({ accounts: { displayName: async () => nickname } });
    const created = await hosts.ensureDefault({ ...request, displayName: "李建" });
    expect(created.name).toBe("李建的默认云电脑");
    nickname = "别人";
    expect((await hosts.ensureDefault(request)).name).toBe(created.name);
  });

  test("the first request creates the default computer and the cluster claims its daemon key", async () => {
    const { hosts, jobs, issued } = harness();
    const created = await hosts.ensureDefault(request);

    expect(created).toMatchObject({
      slot: "default",
      name: defaultCloudName,
      containerReady: false,
    });
    expect(JSON.stringify(created)).not.toContain(daemonKey);
    expect(issued).toEqual([daemonKey]);
    expect(jobs.records[0]?.daemonApiKey).toBe(daemonKey);

    const again = await hosts.ensureDefault(request);
    expect(again.computerId).toBe(created.computerId);
    expect(jobs.records).toHaveLength(1);

    const claimed = await hosts.claim({ token: "host-token" });
    expect(claimed).toMatchObject({
      operation: "create",
      computerId: created.computerId,
      workspaceSlug: "alpha",
      daemonApiKey: daemonKey,
    });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });
    expect(jobs.records[0]?.daemonApiKey).toBeNull();
    expect((await hosts.ensureDefault(request)).containerReady).toBe(true);
    expect(await hosts.claim({ token: "host-token" })).toBeUndefined();
  });

  test("a second workspace attaches the same default computer", async () => {
    const { hosts, fleet, jobs } = harness();
    const created = await hosts.ensureDefault(request);
    const claimed = await hosts.claim({ token: "host-token" });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });

    const hostsWithBeta = hostsFor(fleet, jobs);
    const attached = await hostsWithBeta.ensureDefault({
      userId: "user-a",
      workspaceId: "workspace-2",
      now,
    });
    expect(attached.computerId).toBe(created.computerId);
    expect(fleet.computers).toHaveLength(1);
    expect(jobs.records.map((job) => job.operation)).toEqual(["create", "attach"]);
    const attach = await hosts.claim({ token: "host-token" });
    expect(attach?.operation).toBe("attach");
    expect(attach?.workspaceSlug).toBe("beta");
  });

  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "link during creation is attached (report races: %p, format: %p)",
    async (raceReport, format) => {
      const { hosts, fleet, jobs } = harness();
      const created = await hosts.ensureDefault(request);
      const beta = hostsFor(fleet, jobs, async () => ({ id: "workspace-2", slug: "beta" }));
      const betaRequest = { ...request, workspaceId: "workspace-2" };
      if (format) {
        const first = await hosts.claim({ token: "host-token" });
        await hosts.report({
          token: "host-token",
          jobId: first!.jobId,
          containerId: "old-service",
          now,
        });
        await beta.ensureDefault(betaRequest);
        const oldAttach = await hosts.claim({ token: "host-token" });
        await hosts.report({ token: "host-token", jobId: oldAttach!.jobId, now });
        fleet.links = fleet.links.filter((link) => link.workspaceId !== "workspace-2");
        await hosts.format({
          ...request,
          computerId: created.computerId,
          confirmName: defaultCloudName,
        });
        const removal = await hosts.claim({ token: "host-token" });
        await hosts.report({ token: "host-token", jobId: removal!.jobId, now });
      }
      const before = jobs.records.length;
      const claimed = await hosts.claim({ token: "host-token" });
      const report = () =>
        hosts.report({ token: "host-token", jobId: claimed!.jobId, containerId: "service-1", now });
      const link = fleet.link.bind(fleet);
      fleet.link = async (computerId, workspaceId, slug) => {
        if (raceReport && workspaceId === "workspace-2") await report();
        await link(computerId, workspaceId, slug);
      };
      expect((await beta.ensureDefault(betaRequest)).computerId).toBe(created.computerId);
      await beta.ensureDefault(betaRequest);
      expect(await fleet.isLinked(created.computerId, "workspace-2")).toBe(true);
      if (!raceReport) {
        expect(jobs.records).toHaveLength(before);
        await report();
      }
      const attach = await hosts.claim({ token: "host-token" });
      expect(attach).toMatchObject({
        operation: "attach",
        workspaceId: "workspace-2",
        computerId: created.computerId,
      });
    },
  );

  test("one extra computer is allowed only after the default container exists, and a second extra is refused", async () => {
    const { hosts } = harness();
    await hosts.ensureDefault(request);
    await expect(hosts.addExtra(request)).rejects.toEqual(
      new HostJobError(409, "default cloud computer is not ready"),
    );
    const claimed = await hosts.claim({ token: "host-token" });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });

    const extra = await hosts.addExtra(request);
    expect(extra).toMatchObject({ slot: "extra", name: extraCloudName });
    await expect(hosts.addExtra(request)).rejects.toEqual(
      new HostJobError(409, "an extra cloud computer already exists"),
    );
  });

  test("another workspace can add its own extra computer", async () => {
    const { hosts, fleet, jobs } = harness();
    await hosts.ensureDefault(request);
    const claimed = await hosts.claim({ token: "host-token" });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });
    const first = await hosts.addExtra(request);

    const hostsWithBeta = hostsFor(fleet, jobs);
    const second = await hostsWithBeta.addExtra({
      userId: "user-a",
      workspaceId: "workspace-2",
      now,
    });

    expect(second.slot).toBe("extra");
    expect(second.computerId).not.toBe(first.computerId);
    expect(fleet.computers.filter((computer) => computer.slot === "extra")).toHaveLength(2);
    await expect(
      hostsWithBeta.addExtra({ userId: "user-a", workspaceId: "workspace-2", now }),
    ).rejects.toEqual(new HostJobError(409, "an extra cloud computer already exists"));
  });

  test("the default computer cannot be deleted, and the extra slot frees only after the cluster reports removal", async () => {
    const { hosts, fleet } = harness();
    const created = await hosts.ensureDefault(request);
    await expect(hosts.deleteExtra({ ...request, computerId: created.computerId })).rejects.toEqual(
      new HostJobError(409, "the default cloud computer cannot be deleted"),
    );

    const claimed = await hosts.claim({ token: "host-token" });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });
    const extra = await hosts.addExtra(request);
    const removal = await hosts.deleteExtra({ ...request, computerId: extra.computerId });
    await expect(hosts.addExtra(request)).rejects.toEqual(
      new HostJobError(409, "an extra cloud computer already exists"),
    );

    const job = await hosts.claim({ token: "host-token" });
    expect(job).toMatchObject({ operation: "delete", jobId: removal.jobId, daemonApiKey: null });
    await hosts.report({ token: "host-token", jobId: job!.jobId, now });
    expect(fleet.computers.find((computer) => computer.id === extra.computerId)?.deletedAt).toEqual(
      now,
    );
    expect((await hosts.addExtra(request)).slot).toBe("extra");
  });

  test("formatting keeps the same cloud computer after its disk is removed", async () => {
    const cleared: string[] = [];
    const { hosts, fleet, jobs } = harness({
      clearDisk: async (computerId) => {
        cleared.push(computerId);
      },
    });
    const created = await hosts.ensureDefault(request);
    const claimed = await hosts.claim({ token: "host-token" });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });
    const hostsWithBeta = hostsFor(fleet, jobs);
    await hostsWithBeta.ensureDefault({ userId: "user-a", workspaceId: "workspace-2", now });

    await expect(
      hosts.format({ ...request, computerId: created.computerId, confirmName: "cloud" }),
    ).rejects.toEqual(new HostJobError(409, "confirmation does not match"));
    const formatted = await hosts.format({
      ...request,
      computerId: created.computerId,
      confirmName: defaultCloudName,
    });
    const again = await hosts.format({
      ...request,
      computerId: created.computerId,
      confirmName: defaultCloudName,
    });
    expect(again.jobId).toBe(formatted.jobId);
    expect(fleet.computers).toHaveLength(1);
    expect(fleet.computers[0]?.deletedAt).toBeNull();

    const removal = await hosts.claim({ token: "host-token" });
    expect(removal).toMatchObject({ operation: "delete", computerId: created.computerId });
    await hosts.report({ token: "host-token", jobId: removal!.jobId, now });
    expect(fleet.computers[0]?.deletedAt).toBeNull();
    expect(fleet.computers[0]?.containerReady).toBe(false);
    expect(cleared).toEqual([created.computerId]);

    const placed = await hosts.claim({ token: "host-token" });
    expect(placed).toMatchObject({ operation: "create", computerId: created.computerId });
    await hosts.report({
      token: "host-token",
      jobId: placed!.jobId,
      containerId: "service-2",
      now,
    });
    const attach = await hosts.claim({ token: "host-token" });
    expect(attach).toMatchObject({
      operation: "attach",
      computerId: created.computerId,
      workspaceSlug: "beta",
    });
    expect(fleet.computers[0]?.containerReady).toBe(true);
    expect(fleet.computers[0]?.id).toBe(created.computerId);
  });

  test("an image update is claimed without a daemon key and does not delete the computer", async () => {
    const { hosts, fleet, jobs } = harness();
    const created = await hosts.ensureDefault(request);
    await hosts.report({
      token: "host-token",
      jobId: (await hosts.claim({ token: "host-token" }))!.jobId,
      containerId: "service-1",
      now,
    });
    const updated = await hosts.requestImageUpdate({
      ...request,
      computerId: created.computerId,
      imageId: "sha256:new",
    });
    expect(updated.jobId).toBeTruthy();
    expect(jobs.records.at(-1)?.daemonApiKey).toBeNull();
    const claimed = await hosts.claim({ token: "host-token" });
    expect(claimed).toMatchObject({
      operation: "update",
      computerId: created.computerId,
      daemonApiKey: null,
    });
    await hosts.report({ token: "host-token", jobId: claimed!.jobId, now });
    expect(fleet.computers[0]?.deletedAt).toBeNull();
    expect(fleet.computers[0]?.containerReady).toBe(true);
  });

  test("a runtime update is claimed with the release in the job name", async () => {
    const { hosts, fleet, jobs } = harness();
    const created = await hosts.ensureDefault(request);
    await hosts.report({
      token: "host-token",
      jobId: (await hosts.claim({ token: "host-token" }))!.jobId,
      containerId: "service-1",
      now,
    });
    await hosts.requestRuntimeUpdate({
      ...request,
      computerId: created.computerId,
      version: "0.1.9-dev.1",
    });
    expect(jobs.records.at(-1)?.daemonApiKey).toBeNull();
    expect(jobs.records.at(-1)?.name).toBe("0.1.9-dev.1");
    const claimed = await hosts.claim({ token: "host-token" });
    expect(claimed).toMatchObject({
      operation: "runtime",
      computerId: created.computerId,
      name: "0.1.9-dev.1",
      daemonApiKey: null,
    });
    await hosts.report({ token: "host-token", jobId: claimed!.jobId, now });
    expect(fleet.computers[0]?.deletedAt).toBeNull();
  });

  test("an image update stays queued while the cluster is not accepting placements", async () => {
    const { hosts, setAccepting } = harness();
    const created = await hosts.ensureDefault(request);
    await hosts.report({
      token: "host-token",
      jobId: (await hosts.claim({ token: "host-token" }))!.jobId,
      containerId: "service-1",
      now,
    });
    await hosts.requestImageUpdate({
      ...request,
      computerId: created.computerId,
      imageId: "sha256:new",
    });
    setAccepting(false);
    expect(await hosts.claim({ token: "host-token" })).toBeUndefined();
    setAccepting(true);
    expect((await hosts.claim({ token: "host-token" }))?.operation).toBe("update");
  });

  test("a create stays queued while the cluster is not accepting placements", async () => {
    const { hosts, setAccepting } = harness();
    await hosts.ensureDefault(request);
    setAccepting(false);
    expect(await hosts.claim({ token: "host-token" })).toBeUndefined();
    setAccepting(true);
    expect((await hosts.claim({ token: "host-token" }))?.operation).toBe("create");
  });

  test("someone outside the workspace cannot create a cloud computer", async () => {
    const { hosts, fleet } = harness({ member: false });
    await expect(hosts.ensureDefault(request)).rejects.toEqual(
      new HostJobError(403, "workspace access denied"),
    );
    expect(fleet.computers).toEqual([]);
  });

  test("another cluster token cannot report the job", async () => {
    const { hosts } = harness();
    await hosts.ensureDefault(request);
    const claimed = await hosts.claim({ token: "host-token" });
    await expect(
      hosts.report({
        token: "other-token",
        jobId: claimed!.jobId,
        containerId: "service-1",
        now,
      }),
    ).rejects.toEqual(new HostJobError(401, "invalid host token"));
  });
});

describe("host job HTTP", () => {
  test("a user session cannot claim, and a cluster token can", async () => {
    const { hosts } = harness();
    await hosts.ensureDefault(request);
    const http = createHostJobHttpHandler({
      jobs: hosts,
      now: () => now,
    });
    const claimAsUser = await http.claim(
      new Request("https://server.example/api/hosts/jobs/claim", {
        method: "POST",
        headers: { cookie: "session=user-a" },
      }),
    );
    expect(claimAsUser.status).toBe(401);

    const claimAsHost = await http.claim(
      new Request("https://server.example/api/hosts/jobs/claim", {
        method: "POST",
        headers: { authorization: "Bearer host-token" },
      }),
    );
    const body = await claimAsHost.json();
    expect(body.job.daemonApiKey).toBe(daemonKey);
    expect(body.job.operation).toBe("create");
  });
});
