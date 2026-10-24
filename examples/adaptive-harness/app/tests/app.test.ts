import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdaptiveServer } from "../server.js";
import { SessionStore } from "../session-store.js";
import type { ChatProvider } from "../proxy-provider.js";
import type { FeedbackJudge } from "../../feedback-trigger/host.js";

const apps: Array<{ close: () => Promise<void> }> = [];
const close = (server: { close(callback: (error?: Error) => void): void }) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

async function appWith(fixture: { judge?: FeedbackJudge; provider?: ChatProvider } = {}) {
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
    judge: fixture.judge,
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
