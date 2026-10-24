# Standalone Stately adaptive harness

This is a candidate, single-process Node host for the existing feedback-trigger scaffold. It binds to loopback by default, persists sessions and feedback outside the repository, and keeps production GitHub case filing pending-only.

## Runtime identity, policy, and skills (candidate change)

This chat **does not** load the repository-root `AGENTS.md`, which is a coding-agent handoff. Instead the server now loads and fingerprints these **runtime** files once at process startup:

- `agent/AGENTS.md` — Stately identity and conversational instructions
- `agent/POLICY.md` — truthful capability/authority disclosures (advisory only; actual side-effect gates remain in code)
- `agent/BEHAVIOR.md` — bounded session state, feedback workflow and skill semantics
- `agent/SKILLS/*.md` — three **prompt-only**, allowlisted skills: `inspect-harness`, `summarize-session`, `draft-feedback-case`

The configured identity, policy and behavior text is passed as the **first `system` message on every normal Luna response**, including resumed sessions. A turn beginning `/skill <id>` includes the corresponding skill instructions for that turn only. An unknown skill returns HTTP 400 before persisting a user message or invoking the model. These prompt skills are genuinely selectable response procedures, **not** filesystem, GitHub, shell, MCP or autonomous tool integrations. The six upstream repository `skills/` files are development guides and are not active host tools.

After creating a session, select **Agent config & skills** in the mobile header to inspect the running configuration version, loaded documents and available prompt skills. Tapping **Use** inserts the selected `/skill` command into the composer. The authenticated `GET /api/sessions/:sessionId/config` API returns the same nonsecret config and honest capability statuses; unauthenticated requests fail. The public `/healthz` endpoint exposes only the short config hash, not the prompt text.

Missing or invalid runtime files prevent startup rather than silently falling back to generic model behavior. Changes require a reviewed source update **and restart/redeploy of the Mac-hosted service** before mobile sessions use them; merely pushing this branch does not update the live LaunchAgent.

## Current verified status — 2026-10-24

- Branch: `work/388-feedback-trigger-scaffold`; latest commit: `3fca8d973e6fd8ea759704c6b89d00bc5703f6e2`.
- Provider: the Mac-local CLIProxyAPI is serving authenticated `gpt-5.6-luna` Chat Completions through `127.0.0.1:8317`.
- Verification: focused harness tests 32/32, examples typecheck, scoped lint, formatting, full local CI-equivalent checks, and GitHub Actions run `40063534289` passed.
- Activation: LaunchAgent `com.bencharney.stately-adaptive-harness` runs the service on `127.0.0.1:8787` with runtime-only `0600` configuration outside the repository.
- Private mobile access: Tailscale Serve maps `https://bens-mac-mini.taila1553c.ts.net:8787/` to the loopback service, tailnet-only. No Funnel route was added for this service. The HTTPS health/UI, origin enforcement, two-turn context, feedback dismissal, persistence, and restart recovery were verified from the Mac over the tailnet URL.
- Current limitation: the normal chat context has no identity system prompt yet. The UI calls the service the “Stately adaptive harness,” but the model may identify itself as ChatGPT. Adding an explicit Stately identity prompt is the next product change.
- Case filing: `File case` remains pending-only because no verified runtime adapter for governed intake #76 is enabled. The observed blocker-reporting recurrence was linked to existing Case #80 rather than duplicated.

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
- `STATELY_ALLOWED_ORIGINS` — comma-separated exact browser origins; required when serving through a private reverse proxy (for example, `https://bens-mac-mini.taila1553c.ts.net:8787`).

The process prints a URL only after its listener is bound. `GET /healthz` returns the model, proxy base URL, configuration status, and `caseFiling: pending-only`; it never returns secrets. With the server running, verify it with `STATELY_URL=http://127.0.0.1:<port> pnpm exec tsx examples/adaptive-harness/app/smoke.ts`.

For a private mobile pilot, keep the Node host on loopback and use Tailscale Serve (never Funnel). Set `STATELY_ALLOWED_ORIGINS` to the exact HTTPS Serve origin, then verify `/healthz` and the browser flow from a phone that is signed into the same tailnet. Tailscale ACLs are the network boundary; this candidate has no application user-login system.

## API and behavior

The only inbound message route is `POST /api/sessions/:sessionId/messages`. Sessions are created by `POST /api/sessions` and use an HttpOnly, SameSite cookie. A same-origin check rejects browser origins other than the configured local origin. Every message must carry a stable `messageId`; duplicate completed IDs return the persisted response, while reused IDs with different text are rejected.

The route calls `createGatedTurnHost` before the provider. Triggered punctuation/eval messages receive one bounded judge call. The normal model callback is never called while a feedback disposition is pending. A dismissal must include a human reason. Case-worthy feedback remains a visible pending card because no verified #76 adapter is enabled; `File case` is deliberately unavailable and cannot claim a GitHub issue or readback.

Session files are append-only JSONL with a hash chain, contiguous sequence numbers, atomic rewrite/rename, and per-session in-process serialization. Reopening the store validates the chain and fails closed on corruption. This is a single-process local pilot, not a multi-process transaction store or a deployed service.

## Verification limits

The Mac CLIProxyAPI integration uses the existing OpenAI-compatible Chat Completions adapter and direct model id `gpt-5.6-luna`. A live probe must verify the local listener and authenticated request before claiming model connectivity. The repository does not configure Tailscale or launchd itself; the separately authorized Mac runtime currently uses LaunchAgent and private Tailscale Serve. Any mobile exposure must remain private tailnet-only; no Funnel/public exposure is supported. No production GitHub case filing is enabled.
