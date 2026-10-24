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
import { ActivityTracker } from "./activity.js";
import {
  TemperGateway,
  TemperGatewayError,
  TEMPER_ALLOWED_ENTITY_TYPES,
  TEMPER_TENANT,
  type TemperAllowedEntityType,
} from "./temper-gateway.js";
import {
  composeBehavior,
  behaviorInstructions,
  type BehaviorSelection,
} from "./behavior-composer.js";
import {
  loadRuntimeAgentConfig,
  runtimeConfigView,
  selectRuntimeSkill,
  systemInstructions,
  type RuntimeAgentConfig,
} from "./agent-config.js";

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
  runtimeConfig?: RuntimeAgentConfig;
  temperGateway?: TemperGateway;
};

export type AdaptiveServer = {
  server: Server;
  store: SessionStore;
  provider: ChatProvider;
  temperGateway: TemperGateway;
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
    temperTraces: state.temperTraces,
    behavior: state.behavior,
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
  const temperGateway = options.temperGateway ?? new TemperGateway();
  // Required configuration is read once at startup; a missing file fails closed.
  const runtimeConfig = options.runtimeConfig ?? loadRuntimeAgentConfig();
  const judge = options.judge ?? createLunaFeedbackJudge(provider);
  const activity = new ActivityTracker();
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

  const normalTurn =
    (state: SessionState, message: IncomingMessage, behavior: BehaviorSelection) => async () => {
      const skill = selectRuntimeSkill(message.text, runtimeConfig);
      const context: ProviderMessage[] = [
        {
          role: "system",
          content: `${systemInstructions(runtimeConfig, skill)}\n\n${behaviorInstructions(behavior)}`,
        },
        ...state.messages
          .filter((item) => item.messageId !== message.messageId)
          .slice(-10)
          .map((item) => ({ role: item.role, content: item.text })),
        { role: "user", content: message.text },
      ];
      activity.mark(message.sessionId, "calling-luna");
      const result = await provider.generate(context, { maxOutputTokens: 512 });
      activity.mark(message.sessionId, "saving-response", result.usage);
      return result;
    };

  const processMessage = async (sessionId: string, messageId: string, text: string) =>
    store.withSession(sessionId, async () => {
      try {
        let state = await store.load(sessionId);
        if (!state) throw Object.assign(new Error("Session not found"), { status: 404 });
        // Validate allowlisted prompt skills before persisting or calling a model.
        selectRuntimeSkill(text, runtimeConfig);
        const existingUser = state.messages.find(
          (message) => message.messageId === messageId && message.role === "user",
        );
        const existingAssistant = state.messages.find(
          (message) => message.messageId === `assistant-${messageId}`,
        );
        if (existingUser && existingUser.text !== text)
          throw Object.assign(new Error("Message id reused with different text"), { status: 409 });
        if (existingAssistant)
          return {
            kind: "response" as const,
            text: existingAssistant.text,
            duplicate: true,
            state,
          };
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
        }
        activity.start(sessionId, messageId, provider.model);
        activity.mark(sessionId, "checking-feedback");
        if (!existingUser) {
          state = await store.appendUnlocked(sessionId, [
            {
              type: "message.user",
              message: { messageId, role: "user", text, createdAt: new Date().toISOString() },
            },
          ]);
        }
        const selection =
          state.behavior?.messageId === messageId
            ? state.behavior
            : composeBehavior(state, messageId, text).selection;
        const incoming: IncomingMessage = {
          sessionId,
          messageId,
          text,
          context: state.messages.map((item) => ({ role: item.role, text: item.text })),
        };
        const actor = createConversationActor(sessionId);
        actor.start();
        actor.send({ type: "RECEIVE_MESSAGE", messageId, text });
        actor.send({ type: "SELECT_BEHAVIOR", messageId, behaviorId: selection.behaviorId });
        if (actor.getSnapshot().context.selectedBehavior !== selection.behaviorId)
          throw Object.assign(new Error("XState rejected proposed behavior"), { status: 409 });
        if (state.behavior?.messageId !== messageId)
          state = await store.appendUnlocked(sessionId, [{ type: "behavior.selected", selection }]);
        const gated = createGatedTurnHost(
          {
            judge: {
              evaluate: async (input) => {
                activity.mark(sessionId, "judging-feedback");
                return judge.evaluate(input);
              },
            },
            journal,
            ...(options.caseSink ? { caseSink: options.caseSink } : {}),
          },
          async () => {
            const result = await normalTurn(state!, incoming, selection)();
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
          const trace = activity.finish(sessionId, "blocked");
          if (trace) state = await store.appendUnlocked(sessionId, [{ type: "turn.trace", trace }]);
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
        actor.send({
          type: "MODEL_RESPONSE",
          messageId: assistant.messageId,
          text: assistant.text,
        });
        state = await store.appendUnlocked(sessionId, [
          {
            type: "message.assistant",
            message: assistant,
          },
        ]);
        if (result.feedback.status !== "no-trigger")
          state = await recordFeedback(sessionId, result.feedback.disposition, true);
        const trace = activity.finish(sessionId, "completed");
        if (trace) state = await store.appendUnlocked(sessionId, [{ type: "turn.trace", trace }]);
        return {
          kind: "response" as const,
          text: result.result.text,
          feedback: result.feedback,
          state,
        };
      } catch (error) {
        const trace = activity.finish(sessionId, "failed");
        if (trace) {
          // Failure telemetry is best-effort: never mask the original failure
          // or disclose raw provider errors through the trace endpoint.
          await store.appendUnlocked(sessionId, [{ type: "turn.trace", trace }]).catch(() => {});
        }
        throw error;
      }
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

  const handleTemperCapability = async (request: NodeRequest, sessionId: string) => {
    const body = await readBody(request);
    const capability = stringField(body, "capability", 40);
    const correlationId = randomUUID();
    const state = await store.load(sessionId);
    if (!state) throw Object.assign(new Error("Session not found"), { status: 404 });
    if (
      !capability ||
      !["health", "metadata", "allowed-entities", "read-entity"].includes(capability)
    )
      throw Object.assign(new Error("Unknown Temper capability"), { status: 400 });

    activity.startTemper(sessionId, capability, TEMPER_TENANT, correlationId);
    activity.markTemper(sessionId, "authenticating");
    try {
      let result: unknown;
      if (capability === "health") {
        result = await temperGateway.getHealth({ correlationId });
      } else if (capability === "metadata" || capability === "allowed-entities") {
        activity.markTemper(sessionId, "reading");
        result = await temperGateway.listAllowedEntities({ correlationId });
      } else {
        const entityType = stringField(body, "entityType", 40);
        const entityId = stringField(body, "entityId", 128);
        if (
          !entityType ||
          !entityId ||
          !(TEMPER_ALLOWED_ENTITY_TYPES as readonly string[]).includes(entityType)
        )
          throw Object.assign(
            new Error("A valid allowlisted entityType and entityId are required"),
            { status: 400 },
          );
        activity.markTemper(sessionId, "reading");
        result = await temperGateway.readEntity(entityType as TemperAllowedEntityType, entityId, {
          correlationId,
        });
      }
      const principal =
        isObject(result) && typeof result.principal === "string" ? result.principal : undefined;
      activity.markTemper(sessionId, "succeeded", principal);
      const trace = activity.finishTemper(sessionId, "succeeded", {
        principal,
        result:
          capability === "read-entity"
            ? `read ${(result as { entityType: string }).entityType} ${(result as { entityId: string }).entityId}`
            : capability === "allowed-entities"
              ? `listed ${((result as { entityTypes?: unknown[] }).entityTypes ?? []).length} allowlisted types`
              : capability,
      });
      if (trace) await store.appendUnlocked(sessionId, [{ type: "temper.trace", trace }]);
      return result;
    } catch (error) {
      const gatewayError = error instanceof TemperGatewayError ? error : undefined;
      const denied =
        gatewayError?.code === "auth-invalid" ||
        gatewayError?.code === "auth-missing" ||
        gatewayError?.code === "wrong-tenant" ||
        gatewayError?.code === "denied";
      const trace = activity.finishTemper(sessionId, denied ? "denied" : "failed", {
        error: {
          code: gatewayError?.code ?? "failed",
          message: error instanceof Error ? error.message : "Temper capability failed",
          ...(gatewayError?.status ? { status: gatewayError.status } : {}),
        },
      });
      if (trace)
        await store.appendUnlocked(sessionId, [{ type: "temper.trace", trace }]).catch(() => {});
      throw error;
    }
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
          temperRead: "host-controlled-read-only",
          temperTenant: TEMPER_TENANT,
          temperEntityTypes: TEMPER_ALLOWED_ENTITY_TYPES,
          agent: runtimeConfig.name,
          configVersion: runtimeConfig.version,
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
      if (request.method === "GET" && parts.length === 4 && parts[3] === "behavior") {
        const state = await store.load(sessionId);
        if (!state) return json(response, 404, { error: "Session not found" });
        return json(response, 200, {
          selected: state.behavior,
          source: "session-journal",
          composer: "tardie/atoms",
        });
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "activity") {
        const state = await store.load(sessionId);
        if (!state) return json(response, 404, { error: "Session not found" });
        return json(response, 200, {
          active: activity.snapshot(sessionId),
          activeTemper: activity.snapshotTemper(sessionId),
          recent: state.traces.slice(-12).reverse(),
          recentTemper: state.temperTraces.slice(-12).reverse(),
          serverUptimeSeconds: Math.floor(process.uptime()),
          agentState:
            activity.snapshot(sessionId)?.stage ??
            activity.snapshotTemper(sessionId)?.state ??
            "idle",
        });
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "temper") {
        const result = await handleTemperCapability(request, sessionId);
        return json(response, 200, { status: "succeeded", result });
      }
      if (request.method === "GET" && parts.length === 4 && parts[3] === "config") {
        return json(response, 200, {
          ...runtimeConfigView(runtimeConfig),
          model: provider.model,
        });
      }
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
    temperGateway,
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
