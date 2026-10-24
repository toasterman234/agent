import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdaptiveServer } from "../server.js";
import { SessionStore } from "../session-store.js";
import type { ChatProvider } from "../proxy-provider.js";
import { TemperGateway } from "../temper-gateway.js";

const FIXTURE_ID = "fixture-incident-1";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stateful fake Temper kernel: one fixture Incident whose BeginInvestigation
 * either denies with 403 (Cedar gate -> pending decision) or applies, per `deny`.
 */
function fakeTemper(initial: { status: string; investigator?: string }) {
  const fixture: { status: string; InvestigatorId?: string } = { status: initial.status };
  if (initial.investigator) fixture.InvestigatorId = initial.investigator;
  const calls = { reads: 0, actions: 0, total: 0 };
  let deny = false;
  const fetchImpl = async (input: RequestInfo | URL) => {
    calls.total += 1;
    const url = String(input);
    if (url.endsWith("/api/identity/resolve"))
      return json({ agent_instance_id: "stately", agent_type_name: "stately", verified: true });
    if (url.includes("Temper.IncidentRCA.BeginInvestigation")) {
      calls.actions += 1;
      if (deny) return json({ error: "AuthorizationDenied" }, 403);
      fixture.status = "Investigating";
      fixture.InvestigatorId = "stately";
      return json({ entity_id: FIXTURE_ID, ...fixture });
    }
    if (url.includes(`/tdata/Incidents('${FIXTURE_ID}')`)) {
      calls.reads += 1;
      return json({ entity_id: FIXTURE_ID, ...fixture });
    }
    return json({}, 404);
  };
  return {
    fixture,
    calls,
    fetchImpl,
    setDeny(value: boolean) {
      deny = value;
    },
  };
}

const apps: Array<{ close: () => Promise<void> }> = [];
const closeServer = (server: { close(callback: (error?: Error) => void): void }) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

async function appWith(fixture: { temperGateway?: TemperGateway } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "stately-p3-"));
  const provider = {
    baseUrl: "http://fake/v1",
    model: "fake-model",
    configured: true,
    generate: async () => ({ text: "reply", model: "fake-model" }),
  } satisfies ChatProvider;
  const app = await startAdaptiveServer({
    port: 0,
    store: new SessionStore(directory),
    provider,
    temperGateway: fixture.temperGateway,
  });
  apps.push({ close: () => closeServer(app.server) });
  return { app, directory };
}

async function session(app: Awaited<ReturnType<typeof appWith>>["app"]) {
  const address = app.address()!;
  const response = await fetch(`http://${address.host}:${address.port}/api/sessions`, {
    method: "POST",
  });
  const body = (await response.json()) as { sessionId: string };
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
  if (!setCookie) throw new Error("session creation failed: missing cookie");
  return { sessionId: body.sessionId, cookie: setCookie.split(";", 1)[0]! };
}

async function postTemper(
  app: Awaited<ReturnType<typeof appWith>>["app"],
  cookie: string,
  sessionId: string,
  body: unknown,
) {
  const address = app.address()!;
  return fetch(`http://${address.host}:${address.port}/api/sessions/${sessionId}/temper`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("P3 gated Temper write (fixture BeginInvestigation)", () => {
  test("denied -> pending-approval, approved retry applies once, third trigger dedupes on the journal", async () => {
    const fake = fakeTemper({ status: "Detected" });
    fake.setDeny(true);
    const gateway = new TemperGateway({
      readToken: async () => "test-jwt",
      fetchImpl: fake.fetchImpl,
      fixtureIncidentId: FIXTURE_ID,
    });
    const { app, directory } = await appWith({ temperGateway: gateway });
    const { sessionId, cookie } = await session(app);
    const key = `p3:${sessionId}:BeginInvestigation`;

    // Hostile client fields naming another entity/action must be ignored.
    const first = await postTemper(app, cookie, sessionId, {
      capability: "fixture-begin-investigation",
      entityId: "inc-attacker-chosen",
      entityType: "Incident",
      action: "Close",
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.result).toMatchObject({
      capability: "fixture-begin-investigation",
      outcome: "pending-approval",
      entityId: FIXTURE_ID,
      entityStatus: "Detected",
      status: 403,
    });
    expect(fake.calls.actions).toBe(1);

    const store = new SessionStore(directory);
    let state = await store.load(sessionId);
    let writes = state!.temperWrites.filter((record) => record.key === key);
    expect(writes.map((record) => record.phase)).toEqual(["attempt", "outcome"]);
    expect(writes[1]).toMatchObject({ outcome: "pending-approval", entityId: FIXTURE_ID });
    expect(
      state!.temperTraces.some((trace) => trace.capability === "fixture-begin-investigation"),
    ).toBe(true);

    // Human approves in Temper; the same session retries and applies exactly once.
    fake.setDeny(false);
    const second = await postTemper(app, cookie, sessionId, {
      capability: "fixture-begin-investigation",
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.result).toMatchObject({ outcome: "applied", entityStatus: "Investigating" });
    expect(fake.calls.actions).toBe(2);
    expect(fake.fixture).toMatchObject({ status: "Investigating", InvestigatorId: "stately" });

    // Third trigger: session-level dedupe returns the recorded outcome, no gateway call.
    const readsBefore = fake.calls.reads;
    const third = await postTemper(app, cookie, sessionId, {
      capability: "fixture-begin-investigation",
    });
    expect(third.status).toBe(200);
    const thirdBody = await third.json();
    expect(thirdBody.result).toMatchObject({ outcome: "applied", deduplicated: true });
    expect(fake.calls.actions).toBe(2);
    expect(fake.calls.reads).toBe(readsBefore);

    state = await store.load(sessionId);
    writes = state!.temperWrites.filter((record) => record.key === key);
    expect(writes.map((record) => record.phase)).toEqual([
      "attempt",
      "outcome",
      "attempt",
      "outcome",
    ]);
    expect(writes[3]).toMatchObject({ outcome: "applied" });
  });

  test("capability is disabled (400, zero Temper calls) when the fixture is not configured", async () => {
    const saved = process.env.STATELY_TEMPER_FIXTURE_INCIDENT_ID;
    delete process.env.STATELY_TEMPER_FIXTURE_INCIDENT_ID;
    try {
      let fetchCalls = 0;
      const gateway = new TemperGateway({
        readToken: async () => "test-jwt",
        fetchImpl: async () => {
          fetchCalls += 1;
          return json({});
        },
      });
      expect(gateway.fixtureIncidentId).toBeUndefined();
      const { app } = await appWith({ temperGateway: gateway });
      const { sessionId, cookie } = await session(app);
      const response = await postTemper(app, cookie, sessionId, {
        capability: "fixture-begin-investigation",
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("fixture not configured");
      expect(fetchCalls).toBe(0);
    } finally {
      if (saved !== undefined) process.env.STATELY_TEMPER_FIXTURE_INCIDENT_ID = saved;
    }
  });
});

describe("TemperGateway.beginFixtureInvestigation", () => {
  const gatewayFor = (fake: ReturnType<typeof fakeTemper>) =>
    new TemperGateway({
      readToken: async () => "test-jwt",
      fetchImpl: fake.fetchImpl,
      fixtureIncidentId: FIXTURE_ID,
    });

  test("already Investigating by stately -> already-applied, no action call", async () => {
    const fake = fakeTemper({ status: "Investigating", investigator: "stately" });
    const result = await gatewayFor(fake).beginFixtureInvestigation();
    expect(result.outcome).toBe("already-applied");
    expect(result.entityStatus).toBe("Investigating");
    expect(fake.calls.actions).toBe(0);
  });

  test("fixture in a terminal state -> conflict, no action call", async () => {
    const fake = fakeTemper({ status: "Closed" });
    const result = await gatewayFor(fake).beginFixtureInvestigation();
    expect(result.outcome).toBe("conflict");
    expect(result.entityStatus).toBe("Closed");
    expect(fake.calls.actions).toBe(0);
  });

  test("Detected + Cedar deny -> pending-approval outcome (no throw), exactly one action call", async () => {
    const fake = fakeTemper({ status: "Detected" });
    fake.setDeny(true);
    const result = await gatewayFor(fake).beginFixtureInvestigation();
    expect(result).toMatchObject({ outcome: "pending-approval", status: 403 });
    expect(fake.calls.actions).toBe(1);
  });

  test("Detected + permitted -> applied with verified readback state", async () => {
    const fake = fakeTemper({ status: "Detected" });
    const result = await gatewayFor(fake).beginFixtureInvestigation();
    expect(result.outcome).toBe("applied");
    expect(result.entityStatus).toBe("Investigating");
    expect(result.entity).toMatchObject({ status: "Investigating", InvestigatorId: "stately" });
    expect(fake.calls.actions).toBe(1);
  });
});
