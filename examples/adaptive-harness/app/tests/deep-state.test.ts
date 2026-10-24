import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdaptiveServer } from "../server.js";
import { pendingOnlyCaseSink } from "../case-adapter.js";
import { SessionStore } from "../session-store.js";
import {
  MachineConflictError,
  MachineTransitionError,
  SessionMachineStore,
  migrateLegacySessionV1,
} from "../session-machine-store.js";
import { callKeyFor } from "../conversation.machine.js";
import type { ChatProvider } from "../proxy-provider.js";
import type { FeedbackJudge } from "../../feedback-trigger/host.js";

const apps: Array<{ close: () => Promise<void> }> = [];
const closeServer = (server: { close(cb: (e?: Error) => void): void }) =>
  new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function appWith(fixture: { provider?: ChatProvider; judge?: FeedbackJudge } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "stately-deep-"));
  const provider =
    fixture.provider ??
    ({
      baseUrl: "http://fake/v1",
      model: "fake-model",
      configured: true,
      generate: async (messages: Array<{ content: string }>) => ({
        text: `reply:${messages.at(-1)?.content}`,
        model: "fake-model",
      }),
    } satisfies ChatProvider);
  const app = await startAdaptiveServer({
    port: 0,
    store: new SessionStore(directory),
    provider,
    caseSink: pendingOnlyCaseSink,
    judge: fixture.judge,
  });
  apps.push({ close: () => closeServer(app.server) });
  return { app, directory, provider };
}

async function session(app: Awaited<ReturnType<typeof appWith>>["app"]) {
  const address = app.address()!;
  const response = await fetch(`http://${address.host}:${address.port}/api/sessions`, {
    method: "POST",
  });
  const body = (await response.json()) as { sessionId: string };
  const cookie = (
    response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie")!
  ).split(";", 1)[0]!;
  return { sessionId: body.sessionId, cookie };
}

async function post(
  app: Awaited<ReturnType<typeof appWith>>["app"],
  cookie: string,
  path: string,
  body: unknown,
) {
  const address = app.address()!;
  return fetch(`http://${address.host}:${address.port}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(app: Awaited<ReturnType<typeof appWith>>["app"], cookie: string, path: string) {
  const address = app.address()!;
  return fetch(`http://${address.host}:${address.port}${path}`, { headers: { cookie } });
}

describe("durable XState session lifecycle (DEEP_STATE_PLAN)", () => {
  test("three messages across two independent store instances restore with behavior and checkpoint", async () => {
    const { app, directory } = await appWith();
    const { sessionId, cookie } = await session(app);
    for (const [id, text] of [
      ["m1", "Implement the deep state plan"],
      ["m2", "continue and use the existing approach"],
      ["m3", "keep going"],
    ] as const) {
      expect(
        (await post(app, cookie, `/api/sessions/${sessionId}/messages`, { messageId: id, text }))
          .status,
      ).toBe(200);
    }
    // A fully independent store + machine store over the same journal.
    const restored = await new SessionMachineStore(new SessionStore(directory)).restore(sessionId);
    expect(restored.value).toBe("awaitingMessage");
    expect(restored.record.machineVersion).toBe("2");
    expect(restored.record.revision).toBeGreaterThanOrEqual(12);
    expect(restored.record.checkpointUsed).toBe(true);
    expect(restored.context.activeGoal).toBe("Implement the deep state plan");
    expect(restored.context.activeBehaviorId).toBe("continue-work");
    expect(restored.record.pendingCall).toBeNull();
    expect(restored.record.calls.every((c) => c.outcome === "completed")).toBe(true);
    const state = await get(app, cookie, `/api/sessions/${sessionId}/state`);
    expect(state.status).toBe(200);
    const view = await state.json();
    expect(view.state).toBe("awaitingMessage");
    expect(view.legalNextEvents).toEqual(["RECEIVE_MESSAGE"]);
    expect(view.lastCheckpointAt).toBeTruthy();
    expect(JSON.stringify(view)).not.toContain("snapshot");
  });

  test("restart while blocked on feedback restores to blocked and dismissal resumes the turn", async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      baseUrl: "http://fake/v1",
      model: "fake-model",
      configured: true,
      generate: async () => {
        providerCalls += 1;
        return { text: "resumed answer", model: "fake-model" };
      },
    };
    const judge: FeedbackJudge = {
      evaluate: async () => ({ kind: "case", reason: "failure candidate", category: "logic" }),
    };
    const { app, directory } = await appWith({ provider, judge });
    const { sessionId, cookie } = await session(app);
    const blocked = await post(app, cookie, `/api/sessions/${sessionId}/messages`, {
      messageId: "fb-1",
      text: "???",
    });
    expect(blocked.status).toBe(409);
    expect(providerCalls).toBe(0);
    // Independent restore: the machine is a first-class blocked state.
    const restored = await new SessionMachineStore(new SessionStore(directory)).restore(sessionId);
    expect(restored.value).toBe("blocked");
    expect(restored.record.checkpointUsed).toBe(true);
    expect(restored.context.pendingFeedback?.messageId).toBe("fb-1");
    const view = await (await get(app, cookie, `/api/sessions/${sessionId}/state`)).json();
    expect(view.state).toBe("blocked");
    expect(view.legalNextEvents).toContain("FEEDBACK_DISMISSED");
    // Dismissal resumes exactly the suspended turn through the restored actor.
    const dismissed = await post(
      app,
      cookie,
      `/api/sessions/${sessionId}/feedback/fb-1/disposition`,
      { action: "dismiss", reason: "Human review: not a failure" },
    );
    expect(dismissed.status).toBe(200);
    expect(providerCalls).toBe(1);
    const after = await new SessionMachineStore(new SessionStore(directory)).restore(sessionId);
    expect(after.value).toBe("awaitingMessage");
    expect(after.context.pendingFeedback).toBeNull();
  });

  test("duplicate messageId returns the recorded response with exactly one model call and one call record", async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      baseUrl: "http://fake/v1",
      model: "fake-model",
      configured: true,
      generate: async () => {
        providerCalls += 1;
        return { text: "once", model: "fake-model" };
      },
    };
    const { app, directory } = await appWith({ provider });
    const { sessionId, cookie } = await session(app);
    const first = await post(app, cookie, `/api/sessions/${sessionId}/messages`, {
      messageId: "dup-1",
      text: "hello",
    });
    expect(first.status).toBe(200);
    const duplicate = await post(app, cookie, `/api/sessions/${sessionId}/messages`, {
      messageId: "dup-1",
      text: "hello",
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).duplicate).toBe(true);
    expect(providerCalls).toBe(1);
    const state = await new SessionStore(directory).load(sessionId);
    expect(state?.machineEvents.filter((e) => e.event.type === "CALL_INITIATED")).toHaveLength(1);
  });

  test("stale revision and illegal or unknown events are rejected without touching the journal", async () => {
    const { app, directory } = await appWith();
    const { sessionId, cookie } = await session(app);
    await post(app, cookie, `/api/sessions/${sessionId}/messages`, {
      messageId: "m1",
      text: "hello",
    });
    const storeA = new SessionStore(directory);
    const storeB = new SessionStore(directory);
    const a = await new SessionMachineStore(storeA).restore(sessionId);
    const revision = a.record.revision;
    const b = await new SessionMachineStore(storeB).restore(sessionId);
    await storeB.withSession(sessionId, async () => {
      await b.apply({ type: "RECEIVE_MESSAGE", messageId: "other", text: "x" });
    });
    const before = (await storeA.load(sessionId))!.eventCount;
    await storeA.withSession(sessionId, async () => {
      // Instance A's actor is now stale: the journal moved past its revision.
      await expect(
        a.apply(
          { type: "RECEIVE_MESSAGE", messageId: "stale", text: "x" },
          { expectedRevision: revision },
        ),
      ).rejects.toBeInstanceOf(MachineConflictError);
    });
    // A freshly restored actor rejects illegal and unknown events instead.
    const fresh = await new SessionMachineStore(storeA).restore(sessionId);
    await storeA.withSession(sessionId, async () => {
      await expect(
        fresh.apply({ type: "MODEL_RESPONSE", messageId: "assistant-x", text: "x" }),
      ).rejects.toBeInstanceOf(MachineTransitionError);
      await expect(fresh.apply({ type: "NOPE" } as never)).rejects.toBeInstanceOf(
        MachineTransitionError,
      );
    });
    expect((await storeA.load(sessionId))!.eventCount).toBe(before);
  });

  test("mismatched checkpoint version rebuilds from the journal instead of silent acceptance", async () => {
    const { app, directory } = await appWith();
    const { sessionId, cookie } = await session(app);
    await post(app, cookie, `/api/sessions/${sessionId}/messages`, {
      messageId: "m1",
      text: "hello",
    });
    const store = new SessionStore(directory);
    const state = await store.load(sessionId);
    await store.append(sessionId, [
      {
        type: "machine.checkpoint",
        checkpoint: {
          machineId: "stately-adaptive-conversation",
          machineVersion: "999",
          revision: state!.machineEvents.length,
          anchorSeq: state!.eventCount - 1,
          anchorHash: state!.lastHash,
          snapshot: { bogus: true },
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    const restored = await new SessionMachineStore(new SessionStore(directory)).restore(sessionId);
    expect(restored.checkpointDiscarded).toBe(true);
    expect(restored.checkpointUsed).toBe(false);
    expect(restored.value).toBe("awaitingMessage");
  });

  test("corrupt checkpoint with an intact journal recovers by replay", async () => {
    const { app, directory } = await appWith();
    const { sessionId, cookie } = await session(app);
    await post(app, cookie, `/api/sessions/${sessionId}/messages`, {
      messageId: "m1",
      text: "hello",
    });
    const store = new SessionStore(directory);
    const state = await store.load(sessionId);
    await store.append(sessionId, [
      {
        type: "machine.checkpoint",
        checkpoint: {
          machineId: "stately-adaptive-conversation",
          machineVersion: "2",
          revision: state!.machineEvents.length,
          anchorSeq: state!.eventCount - 1,
          anchorHash: state!.lastHash,
          snapshot: { context: { sessionId: "someone-else" }, value: 42 },
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    const restored = await new SessionMachineStore(new SessionStore(directory)).restore(sessionId);
    expect(restored.checkpointDiscarded).toBe(true);
    expect(restored.value).toBe("awaitingMessage");
    expect(restored.context.lastMessageId).toBe("m1");
  });

  test("corrupt journal fails closed", async () => {
    const { app, directory } = await appWith();
    const { sessionId, cookie } = await session(app);
    await post(app, cookie, `/api/sessions/${sessionId}/messages`, {
      messageId: "m1",
      text: "hello",
    });
    const path = join(directory, `${encodeURIComponent(sessionId)}.jsonl`);
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const entry = JSON.parse(lines.at(-1)!);
    entry.event = { type: "session.created", sessionId, createdAt: "2020-01-01T00:00:00.000Z" };
    lines[lines.length - 1] = JSON.stringify(entry);
    await writeFile(path, `${lines.join("\n")}\n`);
    await expect(new SessionStore(directory).load(sessionId)).rejects.toThrow();
    await expect(
      new SessionMachineStore(new SessionStore(directory)).restore(sessionId),
    ).rejects.toThrow();
  });

  test("legacy v1 journals migrate: completed -> awaiting, pending feedback -> blocked, incomplete -> interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stately-legacy-"));
    const store = new SessionStore(directory);
    const completed = await store.create("legacy-complete");
    void completed;
    await store.append("legacy-complete", [
      {
        type: "message.user",
        message: { messageId: "u1", role: "user", text: "hi", createdAt: new Date().toISOString() },
      },
      {
        type: "message.assistant",
        message: {
          messageId: "assistant-u1",
          role: "assistant",
          text: "hello",
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    const restoredComplete = await new SessionMachineStore(store).restore("legacy-complete");
    expect(restoredComplete.value).toBe("awaitingMessage");
    expect(restoredComplete.migrated).toBe(true);
    expect(restoredComplete.record.machineVersion).toBe("2");

    await store.create("legacy-blocked");
    await store.append("legacy-blocked", [
      {
        type: "message.user",
        message: {
          messageId: "u2",
          role: "user",
          text: "???",
          createdAt: new Date().toISOString(),
        },
      },
      {
        type: "feedback.updated",
        feedback: {
          messageId: "u2",
          status: "pending",
          reason: "needs review",
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    const restoredBlocked = await new SessionMachineStore(store).restore("legacy-blocked");
    expect(restoredBlocked.value).toBe("blocked");
    expect(restoredBlocked.context.pendingFeedback?.messageId).toBe("u2");

    await store.create("legacy-incomplete");
    await store.append("legacy-incomplete", [
      {
        type: "message.user",
        message: {
          messageId: "u3",
          role: "user",
          text: "unfinished",
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    const restoredIncomplete = await new SessionMachineStore(store).restore("legacy-incomplete");
    expect(restoredIncomplete.value).toBe("interrupted");
    // The pure migration function agrees and never invents an assistant reply.
    const seed = migrateLegacySessionV1((await store.load("legacy-incomplete"))!);
    expect(seed.value).toBe("interrupted");
  });

  test("crash after call initiated but before result surfaces interrupted and never re-calls the model", async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      baseUrl: "http://fake/v1",
      model: "fake-model",
      configured: true,
      generate: async () => {
        providerCalls += 1;
        return { text: "should not happen", model: "fake-model" };
      },
    };
    const { app, directory } = await appWith({ provider });
    const { sessionId, cookie } = await session(app);
    // Simulate a crash mid-turn on this live session's journal: user message
    // plus machine events through CALL_INITIATED, with no result recorded.
    const store = new SessionStore(directory);
    const at = new Date().toISOString();
    const events = [
      { type: "RECEIVE_MESSAGE", messageId: "crash-1", text: "do it" },
      { type: "SELECT_BEHAVIOR", messageId: "crash-1", behaviorId: "conversation" },
      {
        type: "CALL_INITIATED",
        messageId: "crash-1",
        callKey: callKeyFor(sessionId, "crash-1"),
      },
    ] as const;
    await store.append(sessionId, [
      {
        type: "message.user",
        message: { messageId: "crash-1", role: "user", text: "do it", createdAt: at },
      },
      ...events.map((event, i) => ({
        type: "machine.event" as const,
        record: {
          eventId: `${sessionId}:${i + 1}:${event.type}:crash-1`,
          messageId: "crash-1",
          event: event as unknown as { type: string; [key: string]: unknown },
          recordedAt: at,
        },
      })),
    ]);
    const restored = await new SessionMachineStore(new SessionStore(directory)).restore(sessionId);
    expect(restored.record.status).toBe("interrupted");
    expect(restored.record.reconciliationNeeded).toBe(true);
    expect(restored.record.pendingCall?.callKey).toBe(callKeyFor(sessionId, "crash-1"));
    expect(restored.record.calls[0]?.outcome).toBe("initiated");
    // A same-id retry is refused as reconciliation-needed, model untouched.
    const retry = await post(app, cookie, `/api/sessions/${sessionId}/messages`, {
      messageId: "crash-1",
      text: "do it",
    });
    expect(retry.status).toBe(409);
    expect((await retry.json()).status).toBe("interrupted");
    expect(providerCalls).toBe(0);
    const view = await (await get(app, cookie, `/api/sessions/${sessionId}/state`)).json();
    expect(view.state).toBe("interrupted");
    expect(view.pending.reconciliationNeeded).toBe(true);
  });

  test("state endpoint requires auth and reports redacted machine metadata", async () => {
    const { app } = await appWith();
    const { sessionId, cookie } = await session(app);
    const address = app.address()!;
    const unauthenticated = await fetch(
      `http://${address.host}:${address.port}/api/sessions/${sessionId}/state`,
    );
    expect(unauthenticated.status).toBe(401);
    const view = await (await get(app, cookie, `/api/sessions/${sessionId}/state`)).json();
    expect(view.machineVersion).toBe("2");
    expect(view.state).toBe("awaitingMessage");
    expect(view.policyVersion).toMatch(/^[a-f0-9]{16}$/);
    expect(view.behaviorVersion).toBe("1");
  });
});
