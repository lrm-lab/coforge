import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { handleAgentTaskPost } from "#src/routes/api/agent/v1/tasks";
import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { agentTaskPrincipal } from "#src/server/tasks/task-principal.server";
import { taskAssignmentFixture } from "./helpers/task-assignment-fixture";
import { assignmentNotice } from "./fixtures/assignment-notice";

test("an admin Agent may reserve a Todo task for another Agent with one personal assignment receipt", async () => {
  const f = await taskAssignmentFixture("agent", "admin");
  try {
    const result = await f.board.execute(f.actor, {
      ...f.command(),
      operation: "create",
      messageId: f.sourceMessageId,
      title: "Reserved for peer",
      assignee: `@${f.peerAgent.name}`,
    });
    expect(result.tasks[0]).toMatchObject({
      status: "todo",
      claimedAt: null,
      owner: { id: f.peerAgent.id },
    });
    const receipt = await f.db.message.findUniqueOrThrow({
      where: { id: (await assignmentNotice(f.db, result.tasks[0]!.id)).id },
      include: { deliveries: true },
    });
    expect(receipt.deliveries.map((row) => row.agentId)).toEqual([f.peerAgent.id]);
  } finally {
    await f.close();
  }
});

for (const kind of ["user", "agent"] as const) {
  for (const role of kind === "user"
    ? ["owner", "admin", "member"]
    : ["owner", "admin", "member", "unknown"]) {
    test(`${kind} ${role} moves a Task freely between writable statuses`, async () => {
      const f = await taskAssignmentFixture(kind, role);
      try {
        const task = (
          await f.board.execute(f.ownerActor, {
            ...f.command("user"),
            operation: "create",
            title: "Moves",
            assignee: `@${f.peerAgent.name}`,
          })
        ).tasks[0]!;
        const done = (
          await f.board.execute(f.actor, {
            ...f.command(),
            operation: "update",
            number: task.number,
            status: "done",
          })
        ).tasks[0]!;
        expect(done.status).toBe("done");
        const parked = (
          await f.board.execute(f.actor, {
            ...f.command(),
            operation: "update",
            number: task.number,
            status: "backlog",
          })
        ).tasks[0]!;
        expect(parked.status).toBe("backlog");
        const active = (
          await f.board.execute(f.actor, {
            ...f.command(),
            operation: "update",
            number: task.number,
            status: "in_progress",
          })
        ).tasks[0]!;
        expect(active.status).toBe("in_progress");
      } finally {
        await f.close();
      }
    });
  }
}

for (const kind of ["user", "agent"] as const) {
  for (const role of kind === "user"
    ? ["owner", "admin", "member"]
    : ["owner", "admin", "member", "unknown"]) {
    test(`${kind} ${role} uses its Workspace role to reserve on create and unassign others, while any member may hand off`, async () => {
      const f = await taskAssignmentFixture(kind, role);
      try {
        const privileged = role === "owner" || role === "admin";
        const creation = f.board.execute(f.actor, {
          ...f.command(),
          operation: "create",
          ...(kind === "agent" ? { messageId: f.sourceMessageId } : {}),
          title: "Other assignee",
          assignee: `@${f.peerAgent.name}`,
        });
        if (privileged) expect((await creation).tasks[0].owner?.id).toBe(f.peerAgent.id);
        else await expect(creation).rejects.toMatchObject({ code: "ACCESS_DENIED" });
        const seed = (
          await f.board.execute(f.ownerActor, {
            ...f.command("user"),
            operation: "create",
            title: "A peer's task",
            assignee: `@${f.peerAgent.name}`,
          })
        ).tasks[0];
        const assigned = (
          await f.board.execute(f.actor, {
            ...f.command(),
            operation: "assign",
            number: seed.number,
            assignee: `@${f.peer.username}`,
            ...(kind === "agent" ? { reason: "Handing over to peer" } : {}),
            expectedRevision: seed.revision,
          })
        ).tasks[0];
        expect(assigned.owner?.id).toBe(f.peer.id);
        if (privileged) {
          expect(
            (
              await f.board.execute(f.actor, {
                ...f.command(),
                operation: "unassign",
                number: seed.number,
                expectedRevision: assigned.revision,
              })
            ).tasks[0].owner,
          ).toBeNull();
        } else {
          await expect(
            f.board.execute(f.actor, {
              ...f.command(),
              operation: "unassign",
              number: seed.number,
              expectedRevision: assigned.revision,
            }),
          ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
        }
      } finally {
        await f.close();
      }
    });
  }

  test(`ordinary ${kind} may assign itself, release itself keeping status, and reassign an existing task`, async () => {
    const f = await taskAssignmentFixture(kind);
    try {
      const self = kind === "user" ? f.user : f.agent;
      const created = (
        await f.board.execute(f.actor, {
          ...f.command(),
          operation: "create",
          ...(kind === "agent" ? { messageId: f.sourceMessageId } : {}),
          title: "Own task",
          assignee: `@${kind === "user" ? f.user.username : f.agent.name}`,
        })
      ).tasks[0];
      expect(created).toMatchObject({ status: "in_progress", owner: { id: self.id } });
      expect(created.claimedAt).not.toBeNull();
      const unassigned = (
        await f.board.execute(f.actor, {
          ...f.command(),
          operation: "unassign",
          number: created.number,
          expectedRevision: created.revision,
        })
      ).tasks[0];
      expect(unassigned).toMatchObject({ status: "in_progress", owner: null, claimedAt: null });
      const assigned = (
        await f.board.execute(f.actor, {
          ...f.command(),
          operation: "assign",
          number: created.number,
          assignee: `@${kind === "user" ? f.user.username : f.agent.name}`,
          expectedRevision: unassigned.revision,
        })
      ).tasks[0];
      expect(assigned).toMatchObject({
        status: "in_progress",
        owner: { id: self.id },
        claimedAt: null,
      });
      const other = (
        await f.board.execute(f.ownerActor, {
          ...f.command("user"),
          operation: "create",
          title: "Another task",
          assignee: `@${f.peerAgent.name}`,
        })
      ).tasks[0];
      const taken = (
        await f.board.execute(f.actor, {
          ...f.command(),
          operation: "assign",
          number: other.number,
          assignee: `@${kind === "user" ? f.user.username : f.agent.name}`,
        })
      ).tasks[0];
      expect(taken.owner?.id).toBe(self.id);
    } finally {
      await f.close();
    }
  });

  test(`${kind} demotion is read again, while a committed creation replay is still idempotent`, async () => {
    const f = await taskAssignmentFixture(kind, "admin");
    try {
      const command = {
        ...f.command(),
        operation: "create" as const,
        ...(kind === "agent" ? { messageId: f.sourceMessageId } : {}),
        title: "Before demotion",
        assignee: `@${f.peerAgent.name}`,
      };
      const created = await f.board.execute(f.actor, command);
      if (kind === "user")
        await f.db.workspaceMembership.update({
          where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.user.id } },
          data: { role: "member" },
        });
      else await f.db.agent.update({ where: { id: f.agent.id }, data: { role: "member" } });
      expect((await f.board.execute(f.actor, command)).tasks[0].id).toBe(created.tasks[0].id);
      await expect(
        f.board.execute(f.actor, {
          ...f.command(),
          operation: "unassign",
          number: created.tasks[0].number,
        }),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    } finally {
      await f.close();
    }
  });
}

test("a reassigned Agent loses its claim and the reserved peer must claim", async () => {
  const f = await taskAssignmentFixture("agent");
  try {
    const owned = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        messageId: f.sourceMessageId,
        title: "Was mine",
        assignee: `@${f.agent.name}`,
      })
    ).tasks[0];
    const assigned = (
      await f.board.execute(f.ownerActor, {
        ...f.command("user"),
        operation: "assign",
        number: owned.number,
        assignee: `@${f.peerAgent.name}`,
        expectedRevision: owned.revision,
      })
    ).tasks[0];
    expect(assigned).toMatchObject({
      status: "in_progress",
      claimedAt: null,
      owner: { id: f.peerAgent.id },
    });
    const refused = await f.board.execute(f.actor, {
      ...f.command(),
      operation: "claim",
      number: owned.number,
    });
    expect(refused.claims?.[0]).toMatchObject({ success: false, reason: "already claimed" });
    const claimed = (
      await f.board.execute(f.peerActor, {
        ...f.command("agent"),
        operation: "claim",
        number: owned.number,
      })
    ).tasks[0];
    expect(claimed.claimedAt).not.toBeNull();
    expect(claimed.owner?.id).toBe(f.peerAgent.id);
  } finally {
    await f.close();
  }
});

test("admin Agent assignments preserve CAS, one receipt and one personal delivery", async () => {
  const f = await taskAssignmentFixture("agent", "admin");
  try {
    const seed = (
      await f.board.execute(f.actor, {
        ...f.command(),
        operation: "create",
        messageId: f.sourceMessageId,
        title: "CAS task",
      })
    ).tasks[0];
    const command = {
      ...f.command(),
      operation: "assign" as const,
      number: seed.number,
      assignee: `@${f.peerAgent.name}`,
      reason: "Please take over this work",
      expectedRevision: seed.revision,
    };
    const first = await f.board.execute(f.actor, command);
    const receiptId = first.assignmentReceipts![0]!.messageId;
    expect((await f.board.execute(f.actor, command)).assignmentReceipts?.[0]?.messageId).toBe(
      receiptId,
    );
    expect(await f.db.message.count({ where: { id: receiptId } })).toBe(1);
    expect(
      await f.db.agentMessageDelivery.count({
        where: { messageId: receiptId, agentId: f.peerAgent.id },
      }),
    ).toBe(1);
    await expect(
      f.board.execute(f.actor, {
        ...f.command(),
        operation: "unassign",
        number: seed.number,
        expectedRevision: seed.revision,
      }),
    ).rejects.toEqual(new AppError("CONFLICT"));
  } finally {
    await f.close();
  }
});

test("assignment refusal explains the Workspace owner/admin requirement through the real Agent HTTP seam", async () => {
  const f = await taskAssignmentFixture("agent");
  try {
    const response = await handleAgentTaskPost(
      new Request("http://coforge.local/api/agent/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...f.command(),
          operation: "create",
          messageId: f.sourceMessageId,
          title: "Forbidden assignment",
          assignee: `@${f.peerAgent.name}`,
        }),
      }),
      agentTaskPrincipal(f.actor as { workspaceId: string; agentId: string }),
      f.board,
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("ACCESS_DENIED");
    expect(body.error).toContain("Workspace owner or admin");
  } finally {
    await f.close();
  }
});

test("an admin Agent retains its own role when its creator is an ordinary member", async () => {
  const f = await taskAssignmentFixture("agent", "admin");
  try {
    await f.db.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.owner.id } },
      data: { role: "member" },
    });
    expect(
      (
        await f.board.execute(f.actor, {
          ...f.command(),
          operation: "create",
          messageId: f.sourceMessageId,
          title: "Agent authority",
          assignee: `@${f.peerAgent.name}`,
        })
      ).tasks[0].owner?.id,
    ).toBe(f.peerAgent.id);
  } finally {
    await f.close();
  }
});

for (const kind of ["user", "agent"] as const) {
  test(`${kind} channel admin gains no Workspace task assignment authority`, async () => {
    const f = await taskAssignmentFixture(kind);
    try {
      await f.db.conversationMember.update({
        where: { id: f.member.id },
        data: { channelRole: "admin" },
      });
      await expect(
        f.board.execute(f.actor, {
          ...f.command(),
          operation: "create",
          ...(kind === "agent" ? { messageId: f.sourceMessageId } : {}),
          title: "No channel escalation",
          assignee: `@${f.peerAgent.name}`,
        }),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    } finally {
      await f.close();
    }
  });
  for (const cause of ["left-channel", "identity-gone"] as const) {
    test(`${kind} manager cannot assign after ${cause}`, async () => {
      const f = await taskAssignmentFixture(kind, "admin");
      try {
        if (cause === "left-channel")
          await f.db.conversationMember.update({
            where: { id: f.member.id },
            data: { leftAt: new Date() },
          });
        else if (kind === "user")
          await f.db.workspaceMembership.delete({
            where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.user.id } },
          });
        else
          await f.db.agent.update({ where: { id: f.agent.id }, data: { deletedAt: new Date() } });
        await expect(
          f.board.execute(f.actor, {
            ...f.command(),
            operation: "create",
            ...(kind === "agent" ? { messageId: f.sourceMessageId } : {}),
            title: "No stale manager",
            assignee: `@${f.peerAgent.name}`,
          }),
        ).rejects.toMatchObject({
          code: kind === "agent" && cause === "left-channel" ? "NOT_FOUND" : "ACCESS_DENIED",
        });
      } finally {
        await f.close();
      }
    });
  }
}
for (const cause of ["left", "deleted", "foreign", "missing"] as const) {
  test(`an assignment cannot reserve a ${cause} assignee`, async () => {
    const f = await taskAssignmentFixture("agent", "admin");
    const foreign = cause === "foreign" ? await taskAssignmentFixture("agent", "admin") : null;
    try {
      let assignee = `agent:${f.peerAgent.id}`;
      if (cause === "left")
        await f.db.conversationMember.update({
          where: {
            conversationId_agentId: { conversationId: f.conversation.id, agentId: f.peerAgent.id },
          },
          data: { leftAt: new Date() },
        });
      if (cause === "deleted")
        await f.db.agent.update({ where: { id: f.peerAgent.id }, data: { deletedAt: new Date() } });
      if (foreign) assignee = `agent:${foreign.agent.id}`;
      if (cause === "missing") assignee = `agent:${crypto.randomUUID()}`;
      await expect(
        f.board.execute(f.actor, {
          ...f.command(),
          operation: "create",
          messageId: f.sourceMessageId,
          title: "No stale assignee",
          assignee,
        }),
      ).rejects.toEqual(new AppError("NOT_FOUND"));
    } finally {
      await foreign?.close();
      await f.close();
    }
  });
}

test("a platform assistant uses its bound human's current assignment role", async () => {
  const f = await taskAssignmentFixture("user", "admin");
  try {
    const assistant = await new WorkspaceAssistants(f.db).ensure(f.workspace.id, f.user.id);
    const principal = { workspaceId: f.workspace.id, agentId: assistant.agentId };
    expect(
      (
        await f.board.execute(principal, {
          ...f.command("user"),
          operation: "create",
          messageId: f.sourceMessageId,
          title: "Delegated role",
          assignee: `@${f.peerAgent.name}`,
        })
      ).tasks[0].owner?.id,
    ).toBe(f.peerAgent.id);
    await f.db.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.user.id } },
      data: { role: "member" },
    });
    await expect(
      f.board.execute(principal, {
        ...f.command("user"),
        operation: "create",
        messageId: f.sourceMessageId,
        title: "No stale delegation",
        assignee: `@${f.peerAgent.name}`,
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  } finally {
    await f.close();
  }
});

test("an Agent's assignment manager role does not grant deletion or resource-receipt authority on others' Tasks", async () => {
  const f = await taskAssignmentFixture("agent", "admin");
  try {
    const seed = (
      await f.board.execute(f.ownerActor, {
        ...f.command("user"),
        operation: "create",
        title: "Human-created resource",
        assignee: `@${f.peerAgent.name}`,
      })
    ).tasks[0]!;
    await f.db.task.update({ where: { id: seed.id }, data: { createsResource: true } });
    await expect(
      f.board.execute(f.actor, { ...f.command(), operation: "delete", number: seed.number }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      f.board.execute(f.actor, {
        ...f.command(),
        operation: "receipt",
        number: seed.number,
        receipt: {
          object: "Fixture resource",
          purpose: "Verify scope",
          teardownOwner: `@${f.peerAgent.name}`,
          securityPrivacy: "No user data",
          expiry: new Date(Date.now() + 3600000).toISOString(),
          runbook: "Delete fixture",
          tracking: "Task regression",
        },
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  } finally {
    await f.close();
  }
});
