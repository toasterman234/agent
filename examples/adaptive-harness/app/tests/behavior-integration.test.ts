import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdaptiveServer } from "../server.js";
import { SessionStore } from "../session-store.js";
import { createConversationActor } from "../conversation.machine.js";
import type { ChatProvider, ProviderMessage } from "../proxy-provider.js";

const servers: Array<{ close: (cb: (e?: Error) => void) => void }> = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

describe("Stately + Tardigrade session behavior integration", () => {
  test("persisted continuation is selected before Luna and survives session-store replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tardie-stately-"));
    try {
      const seen: ProviderMessage[][] = [];
      const provider: ChatProvider = {
        model: "fake-luna",
        baseUrl: "http://fake/v1",
        configured: true,
        generate: async (messages) => {
          seen.push(messages);
          return { text: "Acknowledged", model: "fake-luna" };
        },
      };
      const app = await startAdaptiveServer({
        port: 0,
        store: new SessionStore(directory),
        provider,
      });
      servers.push(app.server);
      const address = app.address()!;
      const base = `http://${address.host}:${address.port}`;
      const created = await fetch(`${base}/api/sessions`, { method: "POST" });
      const session = (await created.json()) as { sessionId: string };
      const cookie = created.headers.get("set-cookie")!.split(";", 1)[0]!;
      const post = (messageId: string, text: string) =>
        fetch(`${base}/api/sessions/${session.sessionId}/messages`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ messageId, text }),
        });
      expect((await post("m1", "Implement the session-aware Stately agent")).status).toBe(200);
      const initial = await new SessionStore(directory).load(session.sessionId);
      expect(initial?.behavior?.goal).toBe("Implement the session-aware Stately agent");
      expect((await post("m2", "continue and use the existing approach")).status).toBe(200);
      const replayed = await new SessionStore(directory).load(session.sessionId);
      expect(replayed?.behavior).toMatchObject({
        messageId: "m2",
        intent: "continue",
        behaviorId: "continue-work",
        goal: initial?.behavior?.goal,
      });
      expect(seen[1]?.[0]?.content).toContain("Behavior: continue-work");
      expect(seen[1]?.[0]?.content).toContain("Implement the session-aware Stately agent");
      const same = await post("m2", "continue and use the existing approach");
      expect(same.status).toBe(200);
      expect((await same.json()).duplicate).toBe(true);
      expect(seen).toHaveLength(2);
      const behaviorUrl = `${base}/api/sessions/${session.sessionId}/behavior`;
      expect((await fetch(behaviorUrl)).status).toBe(401);
      const b = await fetch(behaviorUrl, { headers: { cookie } }).then((r) => r.json());
      expect(b.source).toBe("session-journal");
      expect(b.composer).toBe("tardie/atoms");
      expect(b.selected.behaviorId).toBe("continue-work");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("XState rejects wrong-message behavior events and undeclared routes", () => {
    const actor = createConversationActor("session-x");
    actor.start();
    actor.send({ type: "RECEIVE_MESSAGE", messageId: "m1", text: "Hello" });
    actor.send({ type: "SELECT_BEHAVIOR", messageId: "m-other", behaviorId: "verification" });
    expect(actor.getSnapshot().context.selectedBehavior).toBeNull();
    actor.send({ type: "SELECT_BEHAVIOR", messageId: "m1", behaviorId: "unknown-route" });
    expect(actor.getSnapshot().context.selectedBehavior).toBeNull();
    actor.send({ type: "SELECT_BEHAVIOR", messageId: "m1", behaviorId: "verification" });
    expect(actor.getSnapshot().context.selectedBehavior).toBe("verification");
    actor.stop();
  });
});
