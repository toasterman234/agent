export {};

const baseUrl = (process.env.STATELY_URL ?? "http://127.0.0.1:3000").replace(/\/$/u, "");
const response = await fetch(`${baseUrl}/healthz`);
const body = (await response.json()) as { ok?: boolean; model?: string; caseFiling?: string };
if (!response.ok || body.ok !== true || body.caseFiling !== "pending-only") {
  throw new Error(`health check failed with HTTP ${response.status}`);
}
console.log(
  JSON.stringify({
    url: `${baseUrl}/healthz`,
    ok: body.ok,
    model: body.model,
    caseFiling: body.caseFiling,
  }),
);
