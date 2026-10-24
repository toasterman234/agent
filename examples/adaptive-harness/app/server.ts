import {
  createServer,
  type IncomingMessage as NodeRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  FileDispositionJournal,
  dispositionKey,
  sourceHash,
  type FeedbackDisposition,
} from "../feedback-trigger/journal.js";
import {
  createGatedTurnHost,
  type FeedbackJudge,
  type IncomingMessage,
  type FeedbackCaseSink,
} from "../feedback-trigger/host.js";
import { detectFeedbackSignal } from "../feedback-trigger/detector.js";
import { createProxyProvider, type ChatProvider, type ProviderMessage } from "./proxy-provider.js";
import { createLunaFeedbackJudge } from "./judge.js";
import {
  defaultSessionDirectory,
  SessionStore,
  type SessionFeedback,
  type SessionState,
} from "./session-store.js";
import { createConversationActor } from "./conversation.machine.js";
import { readFile } from "node:fs/promises";

const MAX_BODY_BYTES = 64 * 1024;
const COOKIE = "stately_session";
const htmlPath = new URL("./web/index.html", import.meta.url);

type ServerOptions = {
  host?: string;
  port?: number;
  allowedOrigin?: string;
  store?: SessionStore;
  journal?: FileDispositionJournal;
  provider?: ChatProvider;
  judge?: FeedbackJudge;
  caseSink?: FeedbackCaseSink;
};

export type AdaptiveServer = {
  server: Server;
  store: SessionStore;
  provider: ChatProvider;
  address(): { host: string; port: number } | null;
};

const json = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(encoded);
};

const readBody = async (request: NodeRequest): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const cookies = (request: NodeRequest) =>
  Object.fromEntries(
    (request.headers.cookie ?? "")
      .split(";")
      .map((item) => {
        const [key, ...rest] = item.trim().split("=");
        return [key, decodeURIComponent(rest.join("="))];
      })
      .filter(([key]) => key),
  );

const pathParts = (url: URL) =>
  url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";
const stringField = (body: unknown, key: string, max: number) =>
  isObject(body) && typeof body[key] === "string" && body[key].length > 0 && body[key].length <= max
    ? body[key]
    : undefined;

function originAllowed(
  request: NodeRequest,
  options: ServerOptions,
  actualPort: number | undefined,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const configured =
    options.allowedOrigin ??
    process.env.STATELY_ALLOWED_ORIGINS ??
    process.env.STATELY_ALLOWED_ORIGIN;
  const allowed = configured
    ? configured
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : actualPort
      ? [`http://${options.host ?? "127.0.0.1"}:${actualPort}`]
      : [];
  return allowed.includes(origin);
}

function sessionView(state: SessionState) {
  return {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    messages: state.messages,
    feedback: state.feedback,
    eventCount: state.eventCount,
  };
}

function feedbackView(feedback: SessionFeedback) {
  return {
    ...feedback,
    canFile: false,
    filingStatus: feedback.status === "pending" ? "pending-only" : feedback.status,
  };
}

export function createAdaptiveServer(options: ServerOptions = {}): AdaptiveServer {
  const host = options.host ?? "127.0.0.1";
  const store = options.store ?? new SessionStore(defaultSessionDirectory());
  const dataDirectory = defaultSessionDirectory();
  const journal = options.journal ?? new FileDispositionJournal(join(dataDirectory, "feedback"));
  const provider = options.provider ?? createProxyProvider();
  const judge = options.judge ?? createLunaFeedbackJudge(provider);
  const auth = new Map<string, Set<string>>();
  let actualPort: number | undefined = options.port;

  const authenticatedSession = (request: NodeRequest, sessionId: string): string | undefined => {
    const token = cookies(request)[COOKIE] ?? request.headers["x-stately-session"];
    if (typeof token !== "string" || !auth.get(token)?.has(sessionId)) return undefined;
    return token;
  };

  const recordFeedback = async (
    sessionId: string,
    disposition: FeedbackDisposition,
    locked = false,
  ): Promise<SessionState> =>
    locked
      ? store.appendUnlocked(sessionId, [
          {
            type: "feedback.updated",
            feedback: {
              messageId: disposition.messageId,
              status: disposition.status,
              reason: disposition.reason,
              ...(disposition.category ? { category: disposition.category } : {}),
              ...(disposition.caseRef ? { caseRef: disposition.caseRef } : {}),
              signal: disposition.signal.kind,
              createdAt: disposition.recordedAt,
            },
          },
        ])
      : store.append(sessionId, [
          {
            type: "feedback.updated",
            feedback: {
              messageId: disposition.messageId,
              status: disposition.status,
              reason: disposition.reason,
              ...(disposition.category ? { category: disposition.category } : {}),
              ...(disposition.caseRef ? { caseRef: disposition.caseRef } : {}),
              signal: disposition.signal.kind,
              createdAt: disposition.recordedAt,
            },
          },
        ]);

  const normalTurn = (state: SessionState, message: IncomingMessage) => async () => {
    const context: ProviderMessage[] = state.messages
      .slice(-10)
      .map((item) => ({ role: item.role, content: item.text }));
    context.push({ role: "user", content: message.text });
    return provider.generate(context, { maxOutputTokens: 512 });
  };

  const processMessage = async (sessionId: string, messageId: string, text: string) =>
    store.withSession(sessionId, async () => {
      let state = await store.load(sessionId);
      if (!state) throw Object.assign(new Error("Session not found"), { status: 404 });
      const existingUser = state.messages.find(
        (message) => message.messageId === messageId && message.role === "user",
      );
      const existingAssistant = state.messages.find(
        (message) => message.messageId === `assistant-${messageId}`,
      );
      if (existingUser && existingUser.text !== text)
        throw Object.assign(new Error("Message id reused with different text"), { status: 409 });
      if (existingAssistant)
        return { kind: "response" as const, text: existingAssistant.text, duplicate: true, state };
      if (existingUser) {
        const pending = state.feedback.find(
          (item) => item.messageId === messageId && item.status === "pending",
        );
        if (pending)
          return {
            kind: "blocked" as const,
            reason: pending.reason,
            feedback: feedbackView(pending),
            state,
          };
      } else {
        state = await store.appendUnlocked(sessionId, [
          {
            type: "message.user",
            message: { messageId, role: "user", text, createdAt: new Date().toISOString() },
          },
        ]);
      }
      const incoming: IncomingMessage = {
        sessionId,
        messageId,
        text,
        context: state.messages.map((item) => ({ role: item.role, text: item.text })),
      };
      const actor = createConversationActor(sessionId);
      actor.start();
      actor.send({ type: "RECEIVE_MESSAGE", messageId, text });
      const gated = createGatedTurnHost(
        { judge, journal, ...(options.caseSink ? { caseSink: options.caseSink } : {}) },
        async () => {
          const result = await normalTurn(state!, incoming)();
          return result;
        },
      );
      const result = await gated(incoming);
      if (result.kind === "blocked") {
        actor.send({
          type: "FEEDBACK_PENDING",
          feedback: {
            messageId,
            reason: result.feedback.reason,
            signal: result.feedback.signal?.kind,
          },
        });
        if (result.feedback.disposition)
          state = await recordFeedback(sessionId, result.feedback.disposition, true);
        const feedback = state.feedback.find((item) => item.messageId === messageId) ?? {
          messageId,
          status: "pending" as const,
          reason: result.feedback.reason,
          createdAt: new Date().toISOString(),
          signal: result.feedback.signal?.kind,
        };
        return {
          kind: "blocked" as const,
          reason: result.feedback.reason,
          feedback: feedbackView(feedback),
          state,
        };
      }
      actor.send({ type: "REVIEW_PASSED" });
      const assistant = {
        messageId: `assistant-${messageId}`,
        role: "assistant" as const,
        text: result.result.text,
        createdAt: new Date().toISOString(),
      };
      actor.send({ type: "MODEL_RESPONSE", messageId: assistant.messageId, text: assistant.text });
      state = await store.appendUnlocked(sessionId, [
        {
          type: "message.assistant",
          message: assistant,
        },
      ]);
      if (result.feedback.status !== "no-trigger")
        state = await recordFeedback(sessionId, result.feedback.disposition, true);
      return {
        kind: "response" as const,
        text: result.result.text,
        feedback: result.feedback,
        state,
      };
    });

  const handleDisposition = async (request: NodeRequest, sessionId: string, messageId: string) => {
    const body = await readBody(request);
    const action = stringField(body, "action", 20);
    if (action !== "dismiss" && action !== "file")
      throw Object.assign(new Error("action must be dismiss or file"), { status: 400 });
    const state = await store.load(sessionId);
    const feedback = state?.feedback.find(
      (item) => item.messageId === messageId && item.status === "pending",
    );
    const userMessage = state?.messages.find(
      (item) => item.messageId === messageId && item.role === "user",
    );
    if (!state || !feedback || !userMessage)
      throw Object.assign(new Error("Pending feedback not found"), { status: 404 });
    if (action === "file")
      throw Object.assign(
        new Error(
          "Case filing unavailable: this candidate is pending-only and production GitHub filing is disabled",
        ),
        { status: 409 },
      );
    const reason = stringField(body, "reason", 1000);
    if (!reason) throw Object.assign(new Error("A dismissal reason is required"), { status: 400 });
    const signal = detectFeedbackSignal(userMessage.text);
    if (!signal)
      throw Object.assign(new Error("Original feedback signal is no longer valid"), {
        status: 409,
      });
    const key = dispositionKey(sessionId, messageId);
    const saved = await journal.save({
      key,
      messageId,
      sessionId,
      sourceHash: sourceHash(userMessage.text),
      signal,
      status: "dismissed",
      reason,
      recordedAt: new Date().toISOString(),
    });
    await journal.read(key);
    await recordFeedback(sessionId, saved);
    const result = await processMessage(sessionId, messageId, userMessage.text);
    return result;
  };

  const server = createServer(async (request, response) => {
    try {
      if (!originAllowed(request, options, actualPort))
        return json(response, 403, { error: "Origin not allowed" });
      const url = new URL(request.url ?? "/", `http://${host}:${actualPort ?? 0}`);
      const parts = pathParts(url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(response, 200, {
          ok: true,
          model: provider.model,
          proxyBaseUrl: provider.baseUrl,
          proxyConfigured: provider.configured,
          caseFiling: "pending-only",
        });
      }
      if (request.method === "GET" && url.pathname === "/") {
        const page = await readFile(htmlPath, "utf8");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        return response.end(page);
      }
      if (
        request.method === "POST" &&
        parts.length === 2 &&
        parts[0] === "api" &&
        parts[1] === "sessions"
      ) {
        const token = randomUUID();
        const session = await store.create();
        auth.set(token, new Set([session.sessionId]));
        return json(response, 201, sessionView(session), {
          "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (parts[0] !== "api" || parts[1] !== "sessions" || !parts[2])
        return json(response, 404, { error: "Not found" });
      const sessionId = parts[2];
      if (!authenticatedSession(request, sessionId))
        return json(response, 401, { error: "Session authentication required" });
      if (request.method === "GET" && parts.length === 3) {
        const state = await store.load(sessionId);
        if (!state) return json(response, 404, { error: "Session not found" });
        return json(response, 200, sessionView(state));
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "feedback") {
        const state = await store.load(sessionId);
        if (!state) return json(response, 404, { error: "Session not found" });
        return json(response, 200, state.feedback.map(feedbackView));
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "messages") {
        const body = await readBody(request);
        const messageId = stringField(body, "messageId", 200) ?? randomUUID();
        const text = stringField(body, "text", 8000);
        if (!text) return json(response, 400, { error: "text is required" });
        const result = await processMessage(sessionId, messageId, text);
        if (result.kind === "blocked")
          return json(response, 409, {
            status: "blocked",
            feedback: result.feedback,
            session: sessionView(result.state),
          });
        return json(response, 200, {
          status: "response",
          duplicate: result.duplicate ?? false,
          text: result.text,
          feedback: result.feedback?.status === "no-trigger" ? undefined : result.feedback,
          session: sessionView(result.state),
        });
      }
      if (
        request.method === "POST" &&
        parts.length === 6 &&
        parts[3] === "feedback" &&
        parts[5] === "disposition"
      ) {
        const result = await handleDisposition(request, sessionId, parts[4]!);
        if (result.kind === "blocked")
          return json(response, 409, { status: "blocked", feedback: result.feedback });
        return json(response, 200, {
          status: "response",
          text: result.text,
          session: sessionView(result.state),
        });
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      const status =
        typeof error === "object" && error && "status" in error && typeof error.status === "number"
          ? error.status
          : 500;
      const message = error instanceof Error ? error.message : "Request failed";
      return json(response, status, { error: message });
    }
  });
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address !== "string") actualPort = address.port;
  });
  return {
    server,
    store,
    provider,
    address: () => (actualPort ? { host, port: actualPort } : null),
  };
}

export function startAdaptiveServer(options: ServerOptions = {}): Promise<AdaptiveServer> {
  const app = createAdaptiveServer(options);
  const port = options.port ?? Number(process.env.STATELY_PORT ?? 0);
  const host = options.host ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, host, () => resolve(app));
  });
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  startAdaptiveServer({
    allowedOrigin: process.env.STATELY_ALLOWED_ORIGINS ?? process.env.STATELY_ALLOWED_ORIGIN,
  })
    .then((app) => {
      const address = app.address();
      console.log(`stately adaptive harness listening at http://${address?.host}:${address?.port}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Unable to start harness");
      process.exitCode = 1;
    });
}
