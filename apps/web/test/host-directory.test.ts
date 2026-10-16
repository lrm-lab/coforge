import { describe, expect, test } from "bun:test";

import {
  HostDirectory,
  HostDirectoryError,
  type ClusterRecord,
  type ClusterStore,
} from "#src/server/hosts/host-directory.server";
import { createHostHttpHandler } from "#src/server/hosts/host-http.server";

const now = new Date("2026-09-30T06:00:00.000Z");
const token = "cluster-token-value";

class MemoryClusterStore implements ClusterStore {
  records: ClusterRecord[] = [];
  async insert(record: ClusterRecord) {
    if (this.records.some((item) => item.tokenHash === record.tokenHash)) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    this.records.push({ ...record });
  }
  async findByTokenHash(tokenHash: string) {
    return this.records.find((record) => record.tokenHash === tokenHash);
  }
  async findByNodeKey(nodeKey: string) {
    return this.records.find((record) => record.nodeKey === nodeKey);
  }
  async save(record: ClusterRecord) {
    const index = this.records.findIndex((item) => item.id === record.id);
    this.records[index] = { ...record };
  }
}

function directory(configured: string | null = token) {
  return new HostDirectory(new MemoryClusterStore(), configured ?? undefined);
}

describe("cluster directory", () => {
  test("one configured token is one cluster, and a missing token refuses cloud computers", async () => {
    const hosts = directory();
    const first = await hosts.id();
    expect(await hosts.id()).toBe(first);
    await expect(directory(null).id()).rejects.toEqual(
      new HostDirectoryError(503, "cloud cluster is not configured"),
    );
    await expect(directory("short").id()).rejects.toEqual(
      new HostDirectoryError(503, "cloud cluster is not configured"),
    );
  });

  test("the runtime binds its node key once and reports whether it can place a container", async () => {
    const hosts = directory();
    const registered = await hosts.register({
      token,
      nodeKey: "manager-1",
      name: "lab",
      now,
    });
    expect(registered).toMatchObject({ name: "lab", nodeKey: "manager-1", accepting: true });
    expect(await hosts.authenticate(token)).toMatchObject({
      id: registered.id,
      accepting: true,
    });

    const paused = await hosts.heartbeat({ token, accepting: false, now });
    expect(paused.accepting).toBe(false);
    expect(await hosts.authenticate(token)).toMatchObject({ accepting: false });

    await expect(
      hosts.register({ token, nodeKey: "other-manager", name: "lab", now }),
    ).rejects.toEqual(new HostDirectoryError(409, "node key is already bound"));
    expect(await hosts.authenticate("other-token-value")).toBeUndefined();
  });

  test("a cluster token cannot be claimed before the runtime registers", async () => {
    const hosts = directory();
    await hosts.id();
    expect(await hosts.authenticate(token)).toBeUndefined();
    await expect(hosts.heartbeat({ token, accepting: true, now })).rejects.toEqual(
      new HostDirectoryError(422, "host is not registered"),
    );
  });

  test("the operator binding is empty until the runtime registers, then returns that node key", async () => {
    const hosts = directory();
    expect(await hosts.operatorBinding()).toEqual({ clusterName: null, nodeKey: null });
    await hosts.register({ token, nodeKey: "manager-1", name: "lab", now });
    expect(await hosts.operatorBinding()).toEqual({ clusterName: "lab", nodeKey: "manager-1" });
  });
});

describe("cluster HTTP", () => {
  test("register and heartbeat use the cluster token", async () => {
    const http = createHostHttpHandler({
      directory: directory(),
      now: () => now,
    });
    const registered = await http.register(
      new Request("https://server.example/api/hosts/register", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ nodeKey: "manager-1", name: "lab" }),
      }),
    );
    expect(registered.status).toBe(200);
    const heartbeat = await http.heartbeat(
      new Request("https://server.example/api/hosts/heartbeat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ accepting: false }),
      }),
    );
    expect(await heartbeat.json()).toMatchObject({ accepting: false });
    const missing = await http.heartbeat(
      new Request("https://server.example/api/hosts/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token-value", "content-type": "application/json" },
        body: JSON.stringify({ accepting: true }),
      }),
    );
    expect(missing.status).toBe(401);
  });
});
