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

- Branch: `work/388-feedback-trigger-scaffold`; deployed code commit: `731a648a6dc5198e330914388d2b30d292ef5cfe`.
- Provider: the Mac-local CLIProxyAPI is serving authenticated `gpt-5.6-luna` Chat Completions through `127.0.0.1:8317`.
- Verification: focused harness tests 32/32; the activity implementation's GitHub Actions run `40066133762` passed with 1,649 total tests; examples typecheck, scoped lint, formatting, and prior full local CI-equivalent checks passed.
- Activation: LaunchAgent `com.bencharney.stately-adaptive-harness` runs the service on `127.0.0.1:8787` with runtime-only `0600` configuration outside the repository.
- Private mobile access: Tailscale Serve maps `https://bens-mac-mini.taila1553c.ts.net:8787/` to the loopback service, tailnet-only. No Funnel route was added for this service. The HTTPS health/UI, origin enforcement, two-turn context, feedback dismissal, persistence, and restart recovery were verified from the Mac over the tailnet URL.
- Runtime identity: the service now loads source-controlled Stately identity, policy, behavior, and prompt-only skill files at startup. The identity/config version is visible through the authenticated config panel/API; changes require a service restart.
- Live activity: the mobile UI now reports host-observed receipt, feedback checking/judgment, Luna call, persistence, completion, blocked, and failure stages with elapsed timing and expandable traces. It does not expose model reasoning.
- Case filing: `File case` remains pending-only because no verified runtime adapter for governed intake #76 is enabled. The observed blocker-reporting recurrence was linked to existing Case #80 rather than duplicated.
- Mac deployment: commit `731a648` was fast-forwarded into the Mac checkout and deployed by restarting `com.bencharney.stately-adaptive-harness`; health, config, activity polling, real Luna response, feedback judgment, and the existing HTTPS Tailscale route were read back successfully.

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

## Tardigrade + XState behavior composition (candidate)

This integration uses **`tardie@0.50.0`** (pinned) for _pure derived atoms_, through `atom` and `createStore` imported from `tardie/core`. It does **not** create or run a second Tardigrade agent actor, Bun host or durable event log. Stately's local hash-chained `SessionStore` remains the **sole** journal and source of truth. The Tardigrade graph is disposable and recomputed on each new message.

`app/behavior-composer.ts` derives five small views: previous selected behavior, recent local message references, conservative deterministic intent nomination (`continue`, `revise`, `verify`, `status`, or `discuss`), a typed behavior selection, and a bounded host-supplied instruction fragment. `SessionStore` persists accepted `behavior.selected` events, so a restart or retry reuses the selected behavior and active goal rather than letting a transient classifier change the interpretation of an existing message. No LLM call is used for classification; ordinary Luna chat is still one model call, and the feedback judge still runs only on its original triggers.

**Authority boundary:** The host proposes `SELECT_BEHAVIOR` to the existing XState conversation machine with the current message id; XState only accepts one of the five named behaviors for the matching message while in `reviewing`. The host checks acceptance and writes the selection to its journal **before** generating the normal response. The model cannot send arbitrary machine events, gain new tools, or authorize GitHub case creation by choosing a behavior.

Current supported behaviors are **conversation**, **continue-work**, **revise-work**, **verification** and **status-check**. Previous active goal and mode are preserved for follow-up commands, and only bounded _local message IDs_ are included as memory references; there is **no semantic long-term retrieval, action-capable skill selection, autonomous behavior evolution or external data-source status verification** in this candidate. A newly classified `discuss` turn is intentionally conservative. The underlying XState conversation actor is still per-message, so **the persistent behavior record (not a restored full actor snapshot)** provides cross-turn continuity here. Durable XState snapshots are a separate improvement, not a hidden guarantee of this change.

`GET /api/sessions/:id/behavior` requires the session token and returns the accepted selection, its journal source and composition provider. The mobile activity section displays the active behavior, intent, phase and goal alongside existing telemetry. Behavior selection and local context never grant remote execution or broaden system permissions. For upgrades, preserve the exact `tardie` pin and replay existing sessions before migration.

## Live activity, liveness and traces

The mobile chat now shows a **host-reported activity strip** above the messages while a response is in progress. It reports stages for receipt, feedback checking, feedback judgment (when triggered), waiting on Luna, saving, completion, blocked feedback, and failures. The elapsed timer and **last stage change age** help distinguish a slow model request from a connection failure. This is **not** chain-of-thought, model-internal step streaming, token-by-token output, or a live health probe of the remote model: while `calling-luna` is shown, the host is simply awaiting the model's response.

Tap **Turn trace** to see timestamped stage transitions relative to turn start. Completed, blocked, and failed turn traces are stored with the existing hash-chained session journal (latest 30 kept in its derived state); they include only stage/timing metadata, model name and token usage if the provider returns it, **never prompts, reply text, error bodies, or credentials**.

`GET /api/sessions/:sessionId/activity` requires the same session authentication as chat. It returns an in-memory `active` turn snapshot (null when idle), up to 12 recent persisted turn traces, server uptime, and the last host-observed state. While the message POST is awaiting Luna, the phone polls this endpoint approximately every 850ms without invoking any additional model calls. The active snapshot is ephemeral: if the host crashes during a turn, no new final trace is guaranteed, but earlier completed traces remain persisted. This is intentionally lightweight single-host observability; it does not add an external trace collector or claim distributed liveness. It also avoids disclosing intermediate model reasoning.

## API and behavior

The only inbound message route is `POST /api/sessions/:sessionId/messages`. Sessions are created by `POST /api/sessions` and use an HttpOnly, SameSite cookie. A same-origin check rejects browser origins other than the configured local origin. Every message must carry a stable `messageId`; duplicate completed IDs return the persisted response, while reused IDs with different text are rejected.

The route calls `createGatedTurnHost` before the provider. Triggered punctuation/eval messages receive one bounded judge call. The normal model callback is never called while a feedback disposition is pending. A dismissal must include a human reason. Case-worthy feedback remains a visible pending card because no verified #76 adapter is enabled; `File case` is deliberately unavailable and cannot claim a GitHub issue or readback.

Session files are append-only JSONL with a hash chain, contiguous sequence numbers, atomic rewrite/rename, and per-session in-process serialization. Reopening the store validates the chain and fails closed on corruption. This is a single-process local pilot, not a multi-process transaction store or a deployed service.

## Verification limits

The Mac CLIProxyAPI integration uses the existing OpenAI-compatible Chat Completions adapter and direct model id `gpt-5.6-luna`. A live probe must verify the local listener and authenticated request before claiming model connectivity. The repository does not configure Tailscale or launchd itself; the separately authorized Mac runtime currently uses LaunchAgent and private Tailscale Serve. Any mobile exposure must remain private tailnet-only; no Funnel/public exposure is supported. No production GitHub case filing is enabled.
