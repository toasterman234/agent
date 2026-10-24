import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdaptiveServer } from "../server.js";
import { SessionStore } from "../session-store.js";
import type { ChatProvider } from "../proxy-provider.js";
import type { FeedbackJudge } from "../../feedback-trigger/host.js";
import { TemperGateway } from "../temper-gateway.js";
import { pendingOnlyCaseSink } from "../case-adapter.js";

const apps: Array<{ close: () => Promise<void> }> = [];
const close = (server: { close(callback: (error?: Error) => void): void }) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

async function appWith(
  fixture: {
    judge?: FeedbackJudge;
    provider?: ChatProvider;
    allowedOrigin?: string;
    temperGateway?: TemperGateway;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "stately-app-"));
  const provider =
    fixture.provider ??
    ({
      baseUrl: "http://fake/v1",
      model: "fake-model",
      configured: true,
      generate: async (
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      ) => ({ text: `reply:${messages.at(-1)?.content}`, model: "fake-model" }),
    } satisfies ChatProvider);
  const app = await startAdaptiveServer({
    port: 0,
    store: new SessionStore(directory),
    provider,
    caseSink: pendingOnlyCaseSink,
    judge: fixture.judge,
    allowedOrigin: fixture.allowedOrigin,
    temperGateway: fixture.temperGateway,
  });
  apps.push({ close: () => close(app.server) });
  return { app, directory, provider };
}

async function session(app: Awaited<ReturnType<typeof appWith>>["app"]) {
  const address = app.address()!;
  const response = await fetch(`http://${address.host}:${address.port}/api/sessions`, {
    method: "POST",
  });
  const body = (await response.json()) as { sessionId?: string; error?: string };
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
  if (!setCookie)
    throw new Error(
      `session creation failed (${response.status}): ${body.error ?? "missing cookie"}`,
    );
  return { session: body as { sessionId: string }, cookie: setCookie.split(";", 1)[0]! };
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

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("standalone adaptive harness", () => {
  test("keeps two-turn context, skips judge for ordinary messages, and deduplicates completed IDs", async () => {
    let providerCalls = 0;
    let judgeCalls = 0;
    const provider: ChatProvider = {
      baseUrl: "http://fake/v1",
      model: "fake-model",
      configured: true,
      generate: async (messages) => {
        providerCalls += 1;
        return {
          text: `reply:${messages.map((message) => message.content).join("|")}`,
          model: "fake-model",
        };
      },
    };
    const judge: FeedbackJudge = {
      evaluate: async () => {
        judgeCalls += 1;
        return { kind: "dismiss", reason: "not used" };
      },
    };
    const { app } = await appWith({ provider, judge });
    const { session: created, cookie } = await session(app);
    const first = await post(app, cookie, `/api/sessions/${created.sessionId}/messages`, {
      messageId: "m1",
      text: "hello",
    });
    expect(first.status).toBe(200);
    const second = await post(app, cookie, `/api/sessions/${created.sessionId}/messages`, {
      messageId: "m2",
      text: "what did I say?",
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { text: string };
    expect(secondBody.text).toContain("hello");
    const duplicate = await post(app, cookie, `/api/sessions/${created.sessionId}/messages`, {
      messageId: "m2",
      text: "what did I say?",
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).duplicate).toBe(true);
    expect(providerCalls).toBe(2);
    expect(judgeCalls).toBe(0);
  });

  test("blocks a case nomination, prevents the model call, and resumes only after a reasoned dismissal", async () => {
    let providerCalls = 0;
    let judgeCalls = 0;
    const provider: ChatProvider = {
      baseUrl: "http://fake/v1",
      model: "fake-model",
      configured: true,
      generate: async () => {
        providerCalls += 1;
        return { text: "normal answer", model: "fake-model" };
      },
    };
    const judge: FeedbackJudge = {
      evaluate: async () => {
        judgeCalls += 1;
        return { kind: "case", reason: "specific failure candidate", category: "verification" };
      },
    };
    const { app, directory } = await appWith({ provider, judge });
    const { session: created, cookie } = await session(app);
    const blocked = await post(app, cookie, `/api/sessions/${created.sessionId}/messages`, {
      messageId: "feedback-1",
      text: "???",
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).feedback.status).toBe("pending");
    expect(providerCalls).toBe(0);
    expect(judgeCalls).toBe(1);
    const retry = await post(app, cookie, `/api/sessions/${created.sessionId}/messages`, {
      messageId: "feedback-1",
      text: "???",
    });
    expect(retry.status).toBe(409);
    expect(judgeCalls).toBe(1);
    const file = await post(
      app,
      cookie,
      `/api/sessions/${created.sessionId}/feedback/feedback-1/disposition`,
      { action: "file" },
    );
    expect(file.status).toBe(409);
    const dismissed = await post(
      app,
      cookie,
      `/api/sessions/${created.sessionId}/feedback/feedback-1/disposition`,
      { action: "dismiss", reason: "Human review found no concrete failure" },
    );
    expect(dismissed.status).toBe(200);
    expect(providerCalls).toBe(1);
    const persisted = await new SessionStore(directory).load(created.sessionId);
    expect(persisted?.feedback[0]?.status).toBe("dismissed");
    expect(persisted?.messages.some((message) => message.role === "assistant")).toBe(true);
  });

  test("enforces the configured mobile origin", async () => {
    const { app } = await appWith({ allowedOrigin: "https://mobile.example" });
    const address = app.address()!;
    const allowed = await fetch(`http://${address.host}:${address.port}/healthz`, {
      headers: { origin: "https://mobile.example" },
    });
    expect(allowed.status).toBe(200);
    const rejected = await fetch(`http://${address.host}:${address.port}/healthz`, {
      headers: { origin: "https://other.example" },
    });
    expect(rejected.status).toBe(403);
  });

  test("exposes only the bounded Temper read capability and persists sanitized traces", async () => {
    const temperGateway = new TemperGateway({
      readToken: async () => "test-jwt",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/identity/resolve"))
          return new Response(
            JSON.stringify({
              agent_instance_id: "stately",
              agent_type_name: "stately",
              verified: true,
            }),
            { status: 200 },
          );
        if (url.endsWith("/$metadata"))
          return new Response(
            '<Schema><EntityType Name="Incident"/><EntityType Name="Remediation"/></Schema>',
            { status: 200 },
          );
        return new Response(JSON.stringify({ entity_id: "inc-1", status: "Investigating" }), {
          status: 200,
        });
      },
    });
    const { app } = await appWith({ temperGateway });
    const { session: created, cookie } = await session(app);
    const metadata = await post(app, cookie, `/api/sessions/${created.sessionId}/temper`, {
      capability: "metadata",
    });
    expect(metadata.status).toBe(200);
    expect((await metadata.json()).result.entityTypes).toEqual(["Incident", "Remediation"]);
    const entity = await post(app, cookie, `/api/sessions/${created.sessionId}/temper`, {
      capability: "read-entity",
      entityType: "Incident",
      entityId: "inc-1",
    });
    expect(entity.status).toBe(200);
    expect((await entity.json()).result.entity.entity_id).toBe("inc-1");
    const activity = await fetch(
      `http://${app.address()!.host}:${app.address()!.port}/api/sessions/${created.sessionId}/activity`,
      { headers: { cookie } },
    ).then((response) => response.json());
    expect(activity.recentTemper[0]).toMatchObject({
      capability: "read-entity",
      tenant: "incident-rca",
      principal: "stately",
      state: "succeeded",
    });
    expect(activity.recentTemper[0].steps.map((step: { state: string }) => step.state)).toEqual([
      "requested",
      "authenticating",
      "reading",
      "succeeded",
    ]);
    expect(activity.recentTemper[0].error).toBeUndefined();
  });

  test("does not allow a token from another session to read or post", async () => {
    const { app } = await appWith();
    const first = await session(app);
    const second = await session(app);
    const response = await post(
      app,
      second.cookie,
      `/api/sessions/${first.session.sessionId}/messages`,
      { messageId: "cross", text: "no" },
    );
    expect(response.status).toBe(401);
  });
});

describe("runtime agent identity, policy and prompt skills", () => {
  test("every normal turn receives the Stately system prompt before conversation messages", async () => {
    const calls: Array<Array<{ role: string; content: string }>> = [];
    const provider: ChatProvider = {
      baseUrl: "http://fake/v1",
      model: "gpt-5.6-luna",
      configured: true,
      generate: async (messages) => {
        calls.push(messages);
        return { text: "I am Stately, your custom agent.", model: "gpt-5.6-luna" };
      },
    };
    const { app } = await appWith({ provider });
    const { session: created, cookie } = await session(app);
    for (const [id, text] of [
      ["identity-1", "Who are you?"],
      ["identity-2", "And your role?"],
    ]) {
      const response = await post(app, cookie, `/api/sessions/${created.sessionId}/messages`, {
        messageId: id,
        text,
      });
      expect(response.status).toBe(200);
    }
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[0]?.role).toBe("system");
      expect(call[0]?.content).toContain("You are **Stately**");
      expect(call[0]?.content).toContain("pending-only");
      expect(call[0]?.content).toContain("Runtime behavior contract");
      expect(call.at(-1)?.role).toBe("user");
      expect(call.filter((m) => m.role === "system")).toHaveLength(1);
    }
    // The current user message must not be duplicated in model context.
    expect(calls[1]?.filter((m) => m.content === "And your role?")).toHaveLength(1);
  });

  test("config readback requires a session token and reports real capability statuses", async () => {
    const { app } = await appWith();
    const { session: created, cookie } = await session(app);
    const { host, port } = app.address()!;
    const endpoint = `http://${host}:${port}/api/sessions/${created.sessionId}/config`;
    expect((await fetch(endpoint)).status).toBe(401);
    const response = await fetch(endpoint, { headers: { cookie } });
    expect(response.status).toBe(200);
    const config = await response.json();
    expect(config.name).toBe("Stately");
    expect(config.version).toMatch(/^[a-f0-9]{16}$/);
    expect(config.documents.identity).toContain("Stately");
    expect(config.skills.map((s: { id: string }) => s.id)).toEqual([
      "inspect-harness",
      "summarize-session",
      "draft-feedback-case",
    ]);
    expect(config.skills.every((s: { mode: string }) => s.mode === "prompt-only")).toBe(true);
    expect(config.capabilities.githubCaseFiling).toBe("pending-only");
    expect(config.capabilities.remoteToolExecution).toBe("not-connected");
  });

  test("a selected skill affects only the requested turn and unknown names fail closed", async () => {
    const instructions: string[] = [];
    const provider: ChatProvider = {
      baseUrl: "http://fake/v1",
      model: "fake-model",
      configured: true,
      generate: async (messages) => {
        instructions.push(messages[0]!.content);
        return { text: "ok", model: "fake-model" };
      },
    };
    const { app } = await appWith({ provider });
    const { session: created, cookie } = await session(app);
    const endpoint = `/api/sessions/${created.sessionId}/messages`;
    const skill = await post(app, cookie, endpoint, {
      messageId: "skill-1",
      text: "/skill summarize-session What happened?",
    });
    expect(skill.status).toBe(200);
    expect(instructions[0]).toContain("Selected prompt skill: summarize-session");
    expect(instructions[0]).toContain("bounded recent");

    const ordinary = await post(app, cookie, endpoint, {
      messageId: "ordinary-1",
      text: "Thank you.",
    });
    expect(ordinary.status).toBe(200);
    expect(instructions[1]).not.toContain("Selected prompt skill:");

    const unknown = await post(app, cookie, endpoint, {
      messageId: "invalid-1",
      text: "/skill nonexistent Try it",
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain("Unknown runtime skill");
    expect(instructions).toHaveLength(2);
    const { host, port } = app.address()!;
    const saved = await fetch(`http://${host}:${port}/api/sessions/${created.sessionId}`, {
      headers: { cookie },
    }).then((r) => r.json());
    expect(
      saved.messages.some((message: { messageId: string }) => message.messageId === "invalid-1"),
    ).toBe(false);
  });

  test("runtime identity is required and deterministic; missing config never silently falls back", async () => {
    const { loadRuntimeAgentConfig } = await import("../agent-config.js");
    const one = loadRuntimeAgentConfig();
    const two = loadRuntimeAgentConfig();
    expect(one.version).toBe(two.version);
    const directory = await mkdtemp(join(tmpdir(), "missing-stately-config-"));
    try {
      expect(() => loadRuntimeAgentConfig(directory)).toThrow();
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("authenticated live activity and persistent host traces", () => {
  test("exposes live Luna wait, elapsed time and a durable completion trace without extra calls", async () => {
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const provider: ChatProvider = {
      baseUrl: "http://fake/v1",
      model: "gpt-5.6-luna",
      configured: true,
      generate: async () => {
        calls += 1;
        await latch;
        return {
          text: "Done",
          model: "gpt-5.6-luna",
          usage: { inputTokens: 14, outputTokens: 7, totalTokens: 21 },
        };
      },
    };
    const { app, directory } = await appWith({ provider });
    const { session: created, cookie } = await session(app);
    const { host, port } = app.address()!;
    const url = `http://${host}:${port}/api/sessions/${created.sessionId}/activity`;
    expect((await fetch(url)).status).toBe(401);
    const running = post(app, cookie, `/api/sessions/${created.sessionId}/messages`, {
      messageId: "trace-m1",
      text: "Do a task",
    });
    try {
      await expect
        .poll(async () => {
          const response = await fetch(url, { headers: { cookie } });
          return (await response.json()).active?.stage;
        })
        .toBe("calling-luna");
      const inFlight = await fetch(url, { headers: { cookie } }).then((r) => r.json());
      expect(inFlight.agentState).toBe("calling-luna");
      expect(inFlight.active.messageId).toBe("trace-m1");
      expect(inFlight.active.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(inFlight.active.steps.map((s: { stage: string }) => s.stage)).toEqual([
        "received",
        "checking-feedback",
        "calling-luna",
      ]);
      expect(inFlight.active).not.toHaveProperty("prompt");
      expect(inFlight.active).not.toHaveProperty("response");
      expect(inFlight.serverUptimeSeconds).toBeGreaterThanOrEqual(0);
    } finally {
      release();
    }
    expect((await running).status).toBe(200);
    expect(calls).toBe(1);
    const complete = await fetch(url, { headers: { cookie } }).then((r) => r.json());
    expect(complete.active).toBeNull();
    expect(complete.agentState).toBe("idle");
    expect(complete.recent[0]).toMatchObject({
      messageId: "trace-m1",
      status: "completed",
      model: "gpt-5.6-luna",
      usage: { totalTokens: 21 },
    });
    expect(complete.recent[0].steps.at(-1).stage).toBe("completed");
    const persisted = await new SessionStore(directory).load(created.sessionId);
    expect(persisted?.traces.at(-1)?.status).toBe("completed");
  });

  test("shows judge stage, then a pending feedback trace without calling normal Luna generation", async () => {
    let release!: (result: { kind: "case"; reason: string; category: "verification" }) => void;
    const latch = new Promise<{ kind: "case"; reason: string; category: "verification" }>(
      (resolve) => {
        release = resolve;
      },
    );
    let normalCalls = 0;
    const provider: ChatProvider = {
      baseUrl: "http://fake/v1",
      model: "fake-model",
      configured: true,
      generate: async () => {
        normalCalls += 1;
        return { text: "not allowed", model: "fake-model" };
      },
    };
    const { app } = await appWith({
      provider,
      judge: { evaluate: async () => latch },
    });
    const { session: created, cookie } = await session(app);
    const { host, port } = app.address()!;
    const url = `http://${host}:${port}/api/sessions/${created.sessionId}/activity`;
    const running = post(app, cookie, `/api/sessions/${created.sessionId}/messages`, {
      messageId: "candidate",
      text: "???",
    });
    try {
      await expect
        .poll(async () =>
          fetch(url, { headers: { cookie } })
            .then((r) => r.json())
            .then((v) => v.active?.stage),
        )
        .toBe("judging-feedback");
    } finally {
      release({
        kind: "case",
        reason: "Evidence of a verification error",
        category: "verification",
      });
    }
    expect((await running).status).toBe(409);
    const result = await fetch(url, { headers: { cookie } }).then((r) => r.json());
    expect(result.active).toBeNull();
    expect(result.recent[0].status).toBe("blocked");
    expect(result.recent[0].steps.at(-1).stage).toBe("feedback-pending");
    expect(normalCalls).toBe(0);
  });

  test("errors become redacted failed traces with no raw provider secrets", async () => {
    const provider: ChatProvider = {
      baseUrl: "http://fake/v1",
      model: "fake-model",
      configured: true,
      generate: async () => {
        throw new Error("secret: private credential material");
      },
    };
    const { app } = await appWith({ provider });
    const { session: created, cookie } = await session(app);
    expect(
      (
        await post(app, cookie, `/api/sessions/${created.sessionId}/messages`, {
          messageId: "failed-1",
          text: "Hello",
        })
      ).status,
    ).toBe(500);
    const { host, port } = app.address()!;
    const activity = await fetch(
      `http://${host}:${port}/api/sessions/${created.sessionId}/activity`,
      { headers: { cookie } },
    ).then((r) => r.json());
    expect(activity.recent[0].status).toBe("failed");
    expect(activity.recent[0].steps.at(-1).stage).toBe("failed");
    expect(JSON.stringify(activity)).not.toContain("private credential material");
  });
});
