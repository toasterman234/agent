import { describe, expect, test } from "vitest";
import { TemperGateway, TemperGatewayError, TEMPER_TENANT } from "../temper-gateway.js";

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: headers ?? { "content-type": "application/json" },
  });
}

describe("TemperGateway", () => {
  test("authenticates the dedicated principal and reads bounded metadata", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const gateway = new TemperGateway({
      expectedPrincipal: "stately",
      readToken: async () => "test-jwt",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        if (String(input).endsWith("/api/identity/resolve")) {
          return response({
            agent_instance_id: "stately",
            agent_type_name: "stately",
            verified: true,
          });
        }
        if (String(input).endsWith("/$metadata")) {
          return response(
            '<Schema><EntityType Name="Incident"/><EntityType Name="Secret"/><EntityType Name="Remediation"/></Schema>',
            200,
            {
              "content-type": "application/xml",
            },
          );
        }
        return response({});
      },
    });

    const metadata = await gateway.getMetadata();
    expect(metadata.tenant).toBe(TEMPER_TENANT);
    expect(metadata.principal).toBe("stately");
    expect(metadata.entityTypes).toEqual(["Incident", "Remediation"]);
    expect(metadata.metadataHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(calls).toHaveLength(2);
    const firstHeaders = calls[0]?.init?.headers;
    expect(firstHeaders).toBeDefined();
    expect((firstHeaders as Record<string, string>).Authorization).toBe("Bearer test-jwt");
    expect((firstHeaders as Record<string, string>)["X-Tenant-Id"]).toBe(TEMPER_TENANT);
    expect(JSON.stringify(calls)).toContain("test-jwt");
  });

  test("reads only an allowlisted entity and preserves correlation metadata", async () => {
    const calls: string[] = [];
    const gateway = new TemperGateway({
      readToken: async () => "test-jwt",
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/api/identity/resolve"))
          return response({
            agent_instance_id: "stately",
            agent_type_name: "stately",
            verified: true,
          });
        return response({ entity_id: "inc-1", status: "Investigating" });
      },
    });

    const result = await gateway.readEntity("Incident", "inc-1");
    expect(result.entityType).toBe("Incident");
    expect(result.entityId).toBe("inc-1");
    expect(result.entity).toEqual({ entity_id: "inc-1", status: "Investigating" });
    expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(calls[1]).toContain("/tdata/Incidents('inc-1')");

    await expect(gateway.readEntity("Secret" as never, "secret-1")).rejects.toMatchObject({
      code: "denied",
      status: 403,
    });
    expect(calls).toHaveLength(2);
  });

  test("maps authentication and authorization failures to sanitized structured errors", async () => {
    const invalid = new TemperGateway({
      readToken: async () => "expired-jwt",
      fetchImpl: async (input) =>
        String(input).endsWith("/api/identity/resolve")
          ? response({ error: "Credential not found or inactive" }, 404)
          : response({}, 200),
    });
    await expect(invalid.getMetadata()).rejects.toMatchObject<Partial<TemperGatewayError>>({
      code: "auth-invalid",
      status: 401,
    });

    const denied = new TemperGateway({
      readToken: async () => "test-jwt",
      fetchImpl: async (input) => {
        if (String(input).endsWith("/api/identity/resolve"))
          return response({
            agent_instance_id: "stately",
            agent_type_name: "stately",
            verified: true,
          });
        return response({ error: "AuthorizationDenied" }, 403);
      },
    });
    const error = await denied.readEntity("Incident", "inc-1").catch((value) => value);
    expect(error).toBeInstanceOf(TemperGatewayError);
    expect(error).toMatchObject({ code: "denied", status: 403 });
    expect(error.message).not.toContain("AuthorizationDenied");
    expect(error.message).not.toContain("test-jwt");
  });

  test("rejects a swapped privileged principal before any data read", async () => {
    let readCount = 0;
    const gateway = new TemperGateway({
      readToken: async () => "supervisor-jwt",
      fetchImpl: async (input) => {
        if (String(input).endsWith("/api/identity/resolve"))
          return response({
            agent_instance_id: "astro",
            agent_type_name: "supervisor",
            verified: true,
          });
        readCount += 1;
        return response({});
      },
    });
    await expect(gateway.getMetadata()).rejects.toMatchObject({
      code: "auth-invalid",
      status: 401,
    });
    expect(readCount).toBe(0);
  });

  test("fails closed when credential storage is unavailable", async () => {
    const gateway = new TemperGateway({
      readToken: async () => {
        throw new Error("missing file");
      },
    });
    await expect(gateway.getHealth()).rejects.toMatchObject({ code: "configuration" });
  });
});
