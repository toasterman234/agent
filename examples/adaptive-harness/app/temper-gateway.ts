import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const TEMPER_TENANT = "incident-rca" as const;
export const DEFAULT_TEMPER_BASE_URL = "http://127.0.0.1:3000";
export const DEFAULT_TEMPER_PRINCIPAL = "stately";
export const TEMPER_ALLOWED_ENTITY_TYPES = ["Incident", "Remediation", "Postmortem"] as const;

export type TemperAllowedEntityType = (typeof TEMPER_ALLOWED_ENTITY_TYPES)[number];

export const TEMPER_ENTITY_SETS: Record<TemperAllowedEntityType, string> = {
  Incident: "Incidents",
  Remediation: "Remediations",
  Postmortem: "Postmortems",
};

export type TemperPrincipal = {
  agentInstanceId: string;
  agentTypeName: string;
  verified: true;
};

type AuthenticatedPrincipal = TemperPrincipal & { token: string };

export type TemperCorrelation = {
  correlationId: string;
  tenant: typeof TEMPER_TENANT;
  principal: string;
};

export type TemperHealth = TemperCorrelation & {
  ok: true;
};

export type TemperMetadata = TemperCorrelation & {
  entityTypes: TemperAllowedEntityType[];
  metadataHash: string;
};

export type TemperGatewayErrorCode =
  | "configuration"
  | "auth-missing"
  | "auth-invalid"
  | "wrong-tenant"
  | "denied"
  | "not-found"
  | "timeout"
  | "upstream"
  | "invalid-response";

export class TemperGatewayError extends Error {
  readonly name = "TemperGatewayError";

  constructor(
    message: string,
    readonly code: TemperGatewayErrorCode,
    readonly correlationId: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type IdentityResponse = {
  agent_instance_id?: unknown;
  agent_type_name?: unknown;
  verified?: unknown;
};

type FetchLike = typeof fetch;
type ReadToken = () => Promise<string>;

type GatewayOptions = {
  baseUrl?: string;
  tokenFile?: string;
  expectedPrincipal?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  readToken?: ReadToken;
};

const trimBaseUrl = (value: string) => value.replace(/\/+$/u, "");
const defaultTokenFile = () =>
  process.env.STATELY_TEMPER_TOKEN_FILE ??
  join(homedir(), ".config", "stately-temper", "temper.jwt");

const isAllowedEntityType = (value: string): value is TemperAllowedEntityType =>
  (TEMPER_ALLOWED_ENTITY_TYPES as readonly string[]).includes(value);

const safeStatusCode = (status: number) =>
  status === 400
    ? "wrong-tenant"
    : status === 401
      ? "auth-invalid"
      : status === 403
        ? "denied"
        : status === 404
          ? "not-found"
          : "upstream";

async function readProtectedToken(path: string): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new TemperGatewayError(
      "Temper credential file is unavailable",
      "configuration",
      randomUUID(),
    );
  }
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new TemperGatewayError(
      "Temper credential file permissions are unsafe",
      "configuration",
      randomUUID(),
    );
  }
  const token = (await readFile(path, "utf8")).trim();
  if (!token || token.length > 8192) {
    throw new TemperGatewayError(
      "Temper credential file is invalid",
      "configuration",
      randomUUID(),
    );
  }
  return token;
}

function parseIdentity(
  body: unknown,
  correlationId: string,
  expectedPrincipal: string,
): TemperPrincipal {
  const identity = body as IdentityResponse;
  if (
    identity.verified !== true ||
    typeof identity.agent_instance_id !== "string" ||
    identity.agent_instance_id !== expectedPrincipal ||
    typeof identity.agent_type_name !== "string" ||
    !identity.agent_type_name ||
    ["human", "operator", "supervisor", "astro", "ben"].includes(
      identity.agent_type_name.toLowerCase(),
    )
  ) {
    throw new TemperGatewayError(
      "Temper principal is not the dedicated Stately identity",
      "auth-invalid",
      correlationId,
      401,
    );
  }
  return {
    agentInstanceId: identity.agent_instance_id,
    agentTypeName: identity.agent_type_name,
    verified: true,
  };
}

async function responseJson(response: Response, correlationId: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new TemperGatewayError(
      "Temper returned an invalid response",
      "invalid-response",
      correlationId,
      response.status,
    );
  }
}

export class TemperGateway {
  private readonly baseUrl: string;
  private readonly tokenFile: string;
  private readonly expectedPrincipal: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly readToken: ReadToken;

  constructor(options: GatewayOptions = {}) {
    this.baseUrl = trimBaseUrl(
      options.baseUrl ?? process.env.STATELY_TEMPER_BASE_URL ?? DEFAULT_TEMPER_BASE_URL,
    );
    this.tokenFile = options.tokenFile ?? defaultTokenFile();
    this.expectedPrincipal =
      options.expectedPrincipal ?? process.env.STATELY_TEMPER_PRINCIPAL ?? DEFAULT_TEMPER_PRINCIPAL;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readToken = options.readToken ?? (() => readProtectedToken(this.tokenFile));
  }

  async getHealth(options: TemperCallOptions = {}): Promise<TemperHealth> {
    const correlationId = options.correlationId ?? randomUUID();
    const principal = await this.authenticate(correlationId);
    const response = await this.request("/healthz", principal, correlationId);
    if (!response.ok) throw this.httpError(response.status, correlationId);
    return { ok: true, correlationId, tenant: TEMPER_TENANT, principal: principal.agentInstanceId };
  }

  async getMetadata(options: TemperCallOptions = {}): Promise<TemperMetadata> {
    const correlationId = options.correlationId ?? randomUUID();
    const principal = await this.authenticate(correlationId);
    const response = await this.request("/tdata/$metadata", principal, correlationId);
    if (!response.ok) throw this.httpError(response.status, correlationId);
    const xml = await response.text();
    const entityTypes = [...xml.matchAll(/<EntityType\s+[^>]*Name="([^"]+)"/gu)]
      .map((match) => match[1])
      .filter(
        (name): name is TemperAllowedEntityType =>
          typeof name === "string" && isAllowedEntityType(name),
      );
    return {
      correlationId,
      tenant: TEMPER_TENANT,
      principal: principal.agentInstanceId,
      entityTypes: [...new Set(entityTypes)],
      metadataHash: createHash("sha256").update(xml).digest("hex"),
    };
  }

  async listAllowedEntities(options: TemperCallOptions = {}): Promise<TemperMetadata> {
    return this.getMetadata(options);
  }

  async readEntity(
    entityType: TemperAllowedEntityType,
    entityId: string,
    options: TemperCallOptions = {},
  ): Promise<{
    correlationId: string;
    tenant: typeof TEMPER_TENANT;
    principal: string;
    entityType: TemperAllowedEntityType;
    entityId: string;
    entity: unknown;
  }> {
    const correlationId = options.correlationId ?? randomUUID();
    if (!isAllowedEntityType(entityType)) {
      throw new TemperGatewayError(
        "Temper entity type is not allowlisted",
        "denied",
        correlationId,
        403,
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(entityId)) {
      throw new TemperGatewayError(
        "Temper entity id is invalid",
        "invalid-response",
        correlationId,
        400,
      );
    }
    const principal = await this.authenticate(correlationId);
    const encodedId = encodeURIComponent(entityId);
    const entitySet = TEMPER_ENTITY_SETS[entityType];
    const response = await this.request(
      `/tdata/${entitySet}('${encodedId}')`,
      principal,
      correlationId,
    );
    if (!response.ok) throw this.httpError(response.status, correlationId);
    return {
      correlationId,
      tenant: TEMPER_TENANT,
      principal: principal.agentInstanceId,
      entityType,
      entityId,
      entity: await responseJson(response, correlationId),
    };
  }

  private async authenticate(correlationId: string): Promise<AuthenticatedPrincipal> {
    let token: string;
    try {
      token = await this.readToken();
    } catch (error) {
      if (error instanceof TemperGatewayError) {
        throw new TemperGatewayError(error.message, error.code, correlationId, error.status);
      }
      throw new TemperGatewayError(
        "Temper credential is unavailable",
        "configuration",
        correlationId,
      );
    }
    if (!token)
      throw new TemperGatewayError(
        "Temper credential is missing",
        "auth-missing",
        correlationId,
        401,
      );
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/identity/resolve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Tenant-Id": TEMPER_TENANT,
          "X-Correlation-Id": correlationId,
        },
        body: JSON.stringify({ bearer_token: token, tenant: TEMPER_TENANT }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw this.networkError(error, correlationId);
    }
    if (!response.ok)
      throw new TemperGatewayError(
        "Temper principal could not be verified",
        "auth-invalid",
        correlationId,
        401,
      );
    return {
      ...parseIdentity(
        await responseJson(response, correlationId),
        correlationId,
        this.expectedPrincipal,
      ),
      token,
    };
  }

  private async request(
    path: string,
    principal: AuthenticatedPrincipal,
    correlationId: string,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${principal.token}`,
          "X-Tenant-Id": TEMPER_TENANT,
          "X-Correlation-Id": correlationId,
          "X-Temper-Principal-Id": principal.agentInstanceId,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw this.networkError(error, correlationId);
    }
  }

  private httpError(status: number, correlationId: string): TemperGatewayError {
    const code = safeStatusCode(status) as TemperGatewayErrorCode;
    const message =
      code === "denied"
        ? "Temper denied the read capability"
        : code === "not-found"
          ? "Temper entity was not found"
          : code === "wrong-tenant"
            ? "Temper rejected the tenant scope"
            : "Temper request failed";
    return new TemperGatewayError(message, code, correlationId, status);
  }

  private networkError(error: unknown, correlationId: string): TemperGatewayError {
    const name = error instanceof Error ? error.name : "";
    return new TemperGatewayError(
      name === "TimeoutError" || name === "AbortError"
        ? "Temper request timed out"
        : "Temper service is unavailable",
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "upstream",
      correlationId,
    );
  }
}

export type TemperGatewayOptions = GatewayOptions;
export type TemperCallOptions = { correlationId?: string };
