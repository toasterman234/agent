import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubCaseSink } from "../github-case-sink.js";
import { CaseFilingUnavailableError } from "../case-adapter.js";
import { startAdaptiveServer } from "../server.js";
import { SessionStore } from "../session-store.js";
import type { ChatProvider } from "../proxy-provider.js";
import type { FeedbackCaseSink } from "../../feedback-trigger/host.js";

const FAKE_TOKEN = "<MASKED_SECRET_001>";
const KEY = "session-1:message-1";
const MARKER = `<!-- stately-case-key:${KEY} -->`;

type FileInput = Parameters<FeedbackCaseSink["fileOrLink"]>[0];
const filingInput = (key = KEY): FileInput => ({
  idempotencyKey: key,
  message: {
    sessionId: "session-1",
    messageId: "message-1",
    text: "the harness keeps doing the wrong thing!!!",
  },
  signal: { kind: "punctuation-burst", matched: "!!!" },
  verdict: {
    kind: "case",
    reason: "Repeated wrong behavior after correction",
    category: "agent-behavior",
  },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FakeIssue = { number: number; body: string; labels: string[] };
type RecordedCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: { title?: string; body?: string; labels?: string[] };
};

/** Stateful fake GitHub: an issue list with label filtering + pagination. */
function fakeGitHub(seed: FakeIssue[] = []) {
  const issues: FakeIssue[] = [...seed];
  const calls: RecordedCall[] = [];
  const state = { labelQueryFails: false, failCreate: false };
  let nextNumber = seed.reduce((max, issue) => Math.max(max, issue.number), 100) + 1;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as RecordedCall["body"]) : undefined,
    });
    const parsed = new URL(url);
    const listPath = "/repos/toasterman234/master-repo-0.1/issues";
    if (parsed.pathname === listPath && method === "GET") {
      if (state.labelQueryFails && parsed.searchParams.has("labels"))
        return json({ message: "Validation Failed" }, 422);
      let list = issues;
      if (parsed.searchParams.has("labels"))
        list = list.filter((issue) => issue.labels.includes("stately-case"));
      const page = Number(parsed.searchParams.get("page") ?? "1");
      const perPage = Number(parsed.searchParams.get("per_page") ?? "100");
      return json(list.slice((page - 1) * perPage, page * perPage));
    }
    if (parsed.pathname === listPath && method === "POST") {
      if (state.failCreate) return json({ message: "boom" }, 500);
      const payload = JSON.parse(String(init?.body)) as {
        title: string;
        body: string;
        labels?: string[];
      };
      const issue: FakeIssue = {
        number: nextNumber++,
        body: payload.body,
        labels: payload.labels ?? [],
      };
      issues.push(issue);
      return json({ number: issue.number, body: issue.body }, 201);
    }
    const single = /^\/repos\/toasterman234\/master-repo-0\.1\/issues\/(\d+)$/.exec(
      parsed.pathname,
    );
    if (single && method === "GET") {
      const issue = issues.find((item) => item.number === Number(single[1]));
      return issue
        ? json({ number: issue.number, body: issue.body })
        : json({ message: "Not Found" }, 404);
    }
    return json({}, 404);
  }) as typeof fetch;
  return { issues, calls, state, fetchImpl };
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stately-gh-sink-"));
  tempDirs.push(directory);
  return directory;
}
async function tokenFile(contents = `GITHUB_TOKEN=${FAKE_TOKEN}\n`): Promise<string> {
  const path = join(await tempDir(), "secrets.env");
  await writeFile(path, contents);
  return path;
}

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((entry) => entry.close()));
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  delete process.env.STATELY_GITHUB_TOKEN_FILE;
});

describe("GitHubCaseSink", () => {
  test("creates exactly one labeled issue carrying the marker, then verify reads it back", async () => {
    const gh = fakeGitHub();
    const sink = new GitHubCaseSink({ fetchImpl: gh.fetchImpl, tokenFilePath: await tokenFile() });
    const { ref } = await sink.fileOrLink(filingInput());
    expect(ref).toBe("github:toasterman234/master-repo-0.1#101");
    const posts = gh.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body?.labels).toEqual(["stately-case"]);
    expect(posts[0]?.body?.title).toContain("[Stately case] agent-behavior:");
    expect(posts[0]?.body?.body).toContain("Repeated wrong behavior after correction");
    expect(posts[0]?.body?.body).toContain("the harness keeps doing the wrong thing!!!");
    expect(posts[0]?.body?.body).toContain(MARKER);
    // The token is used, and only as the Authorization header.
    expect(posts[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    await expect(sink.verify(ref)).resolves.toBe(true);
  });

  test("replay: an existing issue with the same key is linked with zero creates", async () => {
    const gh = fakeGitHub([
      { number: 55, body: `earlier filing\n\n${MARKER}`, labels: ["stately-case"] },
    ]);
    const sink = new GitHubCaseSink({ fetchImpl: gh.fetchImpl, tokenFilePath: await tokenFile() });
    const { ref } = await sink.fileOrLink(filingInput());
    expect(ref).toBe("github:toasterman234/master-repo-0.1#55");
    expect(gh.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("a marker on page 2 of the scan is still linked, not duplicated", async () => {
    const fillers: FakeIssue[] = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      body: `unrelated case ${index + 1}`,
      labels: ["stately-case"],
    }));
    const gh = fakeGitHub([
      ...fillers,
      { number: 101, body: `the one\n\n${MARKER}`, labels: ["stately-case"] },
    ]);
    const sink = new GitHubCaseSink({ fetchImpl: gh.fetchImpl, tokenFilePath: await tokenFile() });
    const { ref } = await sink.fileOrLink(filingInput());
    expect(ref).toBe("github:toasterman234/master-repo-0.1#101");
    expect(gh.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("when the label query is rejected, the unfiltered scan still dedupes", async () => {
    const gh = fakeGitHub([
      { number: 77, body: `filed before labels existed\n\n${MARKER}`, labels: [] },
    ]);
    gh.state.labelQueryFails = true;
    const sink = new GitHubCaseSink({ fetchImpl: gh.fetchImpl, tokenFilePath: await tokenFile() });
    const { ref } = await sink.fileOrLink(filingInput());
    expect(ref).toBe("github:toasterman234/master-repo-0.1#77");
    expect(gh.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("verify is false for missing, unmarked, foreign, and malformed refs", async () => {
    const gh = fakeGitHub([{ number: 88, body: "an ordinary issue", labels: [] }]);
    const sink = new GitHubCaseSink({ fetchImpl: gh.fetchImpl, tokenFilePath: await tokenFile() });
    await expect(sink.verify("github:toasterman234/master-repo-0.1#999")).resolves.toBe(false);
    await expect(sink.verify("github:toasterman234/master-repo-0.1#88")).resolves.toBe(false);
    await expect(sink.verify("github:someoneelse/other-repo#88")).resolves.toBe(false);
    await expect(sink.verify("github:toasterman234/master-repo-0.1#abc")).resolves.toBe(false);
    await expect(sink.verify("not-a-ref")).resolves.toBe(false);
  });

  test("a missing token file fails closed before any GitHub call", async () => {
    const gh = fakeGitHub();
    const sink = new GitHubCaseSink({
      fetchImpl: gh.fetchImpl,
      tokenFilePath: join(await tempDir(), "absent.env"),
    });
    await expect(sink.fileOrLink(filingInput())).rejects.toBeInstanceOf(CaseFilingUnavailableError);
    expect(gh.calls).toHaveLength(0);
    await expect(sink.verify("github:toasterman234/master-repo-0.1#1")).resolves.toBe(false);
  });

  test("the token never appears in returned objects or error messages", async () => {
    const gh = fakeGitHub();
    const sink = new GitHubCaseSink({ fetchImpl: gh.fetchImpl, tokenFilePath: await tokenFile() });
    const filed = await sink.fileOrLink(filingInput());
    gh.state.failCreate = true;
    let message = "";
    try {
      await sink.fileOrLink(filingInput("session-2:message-2"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("500");
    expect(JSON.stringify(filed)).not.toContain(FAKE_TOKEN);
    expect(message).not.toContain(FAKE_TOKEN);
  });
});

describe("server wiring", () => {
  const provider = {
    baseUrl: "http://fake/v1",
    model: "fake-model",
    configured: true,
    generate: async () => ({ text: "reply", model: "fake-model" }),
  } satisfies ChatProvider;

  async function healthz(app: Awaited<ReturnType<typeof startAdaptiveServer>>) {
    const address = app.address()!;
    const response = await fetch(`http://${address.host}:${address.port}/healthz`);
    return (await response.json()) as { caseFiling?: string };
  }

  test("healthz reports the GitHub target when a token file is configured", async () => {
    process.env.STATELY_GITHUB_TOKEN_FILE = await tokenFile();
    const gh = fakeGitHub();
    const app = await startAdaptiveServer({
      port: 0,
      store: new SessionStore(await tempDir()),
      provider,
      caseSink: new GitHubCaseSink({
        fetchImpl: gh.fetchImpl,
        tokenFilePath: process.env.STATELY_GITHUB_TOKEN_FILE,
      }),
    });
    servers.push({
      close: () =>
        new Promise<void>((resolve, reject) =>
          app.server.close((error) => (error ? reject(error) : resolve())),
        ),
    });
    expect((await healthz(app)).caseFiling).toBe("github:toasterman234/master-repo-0.1");
  });

  test("healthz stays pending-only when no token resolves", async () => {
    process.env.STATELY_GITHUB_TOKEN_FILE = join(await tempDir(), "absent.env");
    const app = await startAdaptiveServer({
      port: 0,
      store: new SessionStore(await tempDir()),
      provider,
    });
    servers.push({
      close: () =>
        new Promise<void>((resolve, reject) =>
          app.server.close((error) => (error ? reject(error) : resolve())),
        ),
    });
    expect((await healthz(app)).caseFiling).toBe("pending-only");
  });
});
