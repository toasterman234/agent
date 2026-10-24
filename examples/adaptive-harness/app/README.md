# Standalone Stately adaptive harness

This is a candidate, single-process Node host for the existing feedback-trigger scaffold. It binds to loopback by default, persists sessions and feedback outside the repository, and keeps production GitHub case filing pending-only.

## Run locally

From the repository root:

```sh
STATELY_PROXY_API_KEY='<runtime-only local CLIProxyAPI key>' pnpm exec tsx examples/adaptive-harness/app/server.ts
```

Safe environment names:

- `STATELY_PROXY_BASE_URL` — defaults to `http://127.0.0.1:8317/v1`.
- `STATELY_PROXY_MODEL` — defaults to `gpt-5.6-luna`.
- `STATELY_PROXY_API_KEY` or `CLIPROXY_API_KEY` — supplied at runtime only; never commit or log its value.
- `STATELY_DATA_DIR` — defaults to `~/.local/share/stately-adaptive-harness`.
- `STATELY_PORT` — defaults to an available local port.

The process prints a URL only after its listener is bound. `GET /healthz` returns the model, proxy base URL, configuration status, and `caseFiling: pending-only`; it never returns secrets. With the server running, verify it with `STATELY_URL=http://127.0.0.1:<port> pnpm exec tsx examples/adaptive-harness/app/smoke.ts`.

## API and behavior

The only inbound message route is `POST /api/sessions/:sessionId/messages`. Sessions are created by `POST /api/sessions` and use an HttpOnly, SameSite cookie. A same-origin check rejects browser origins other than the configured local origin. Every message must carry a stable `messageId`; duplicate completed IDs return the persisted response, while reused IDs with different text are rejected.

The route calls `createGatedTurnHost` before the provider. Triggered punctuation/eval messages receive one bounded judge call. The normal model callback is never called while a feedback disposition is pending. A dismissal must include a human reason. Case-worthy feedback remains a visible pending card because no verified #76 adapter is enabled; `File case` is deliberately unavailable and cannot claim a GitHub issue or readback.

Session files are append-only JSONL with a hash chain, contiguous sequence numbers, atomic rewrite/rename, and per-session in-process serialization. Reopening the store validates the chain and fails closed on corruption. This is a single-process local pilot, not a multi-process transaction store or a deployed service.

## Verification limits

The Mac CLIProxyAPI integration uses the existing OpenAI-compatible Chat Completions adapter and direct model id `gpt-5.6-luna`. A live probe must verify the local listener and authenticated request before claiming model connectivity. No Tailscale Serve/Funnel or launchd change is made by this source-only harness. No production GitHub case filing is enabled.
