# Standalone Stately agent — Mac CLIProxyAPI execution plan

**Decision update:** 2026-10-23; requested by the owner after the isolated fork scaffold.  
**Primary implementation:** [toasterman234/agent draft PR #1](https://github.com/toasterman234/agent/pull/1), `work/388-feedback-trigger-scaffold`.  
**Source and behavior case:** [master-repo-0.1 #388](https://github.com/toasterman234/master-repo-0.1/issues/388), with [E36/#386](https://github.com/toasterman234/master-repo-0.1/issues/386), [E37/#387](https://github.com/toasterman234/master-repo-0.1/issues/387), and [Case intake #76](https://github.com/toasterman234/master-repo-0.1/issues/76).

## Current implementation receipt — 2026-10-24

- Added the standalone `app/` host, responsive UI, persistent hash-chained session log, XState conversation machine, strict feedback judge, CLIProxyAPI adapter, smoke check, origin allowlist, LaunchAgent recipe, and pending-only case seam.
- Latest deployed code commit: `731a648a6dc5198e330914388d2b30d292ef5cfe` on `work/388-feedback-trigger-scaffold`; draft PR [#1](https://github.com/toasterman234/agent/pull/1) remains open and unmerged.
- Verification passed: focused harness tests 32/32; the activity implementation's GitHub Actions run [40066133762](https://github.com/toasterman234/agent/actions/runs/40066133762) passed with 1,649 total tests; examples typecheck, scoped lint, formatting, and prior full local CI-equivalent checks passed.
- Live Mac readback: authenticated bounded Chat Completions returned HTTP 200 with response model `gpt-5.6-luna`; the real harness smoke verified two-turn recall, duplicate completion handling, punctuation feedback dismissal, recovery, persistence, and restart readback. No credential was committed, printed, or logged.
- Activation: LaunchAgent `com.bencharney.stately-adaptive-harness` runs the service on `127.0.0.1:8787` with runtime-only configuration outside the repository. Restart and health readback passed.
- Mobile: Tailscale Serve maps `https://bens-mac-mini.taila1553c.ts.net:8787/` to the loopback service, tailnet-only. The configured origin returned HTTP 200, an unrelated origin returned HTTP 403, and the HTTPS health/UI and full chat smoke passed. No Funnel route was added for this service.
- Runtime identity: the service now loads source-controlled Stately identity, policy, behavior, and prompt-only skill files at startup and passes them as a system message to normal Luna turns. The authenticated config panel/API exposes the nonsecret config version and capability declarations.
- Live activity: the mobile UI reports host-observed receipt, feedback checking/judgment, Luna call, persistence, completion, blocked, and failure stages with elapsed timing and expandable persisted traces. It does not expose model reasoning.
- Case filing: `File case` remains pending-only because no verified runtime adapter for governed intake #76 is enabled. The blocker-reporting recurrence was linked to existing Case #80 (`6379941895`) and referenced from #76 (`6379942028`); no duplicate case was created.
- Mac deployment: commit `731a648` was fast-forwarded into the Mac checkout and deployed by restarting `com.bencharney.stately-adaptive-harness`; health, config, activity polling, real Luna response, feedback judgment, and the existing HTTPS Tailscale route were read back successfully.

### Where we are now

The private local/mobile pilot is operational and verified, but it is still a candidate harness rather than a production deployment. The next product work is continued identity/skill UX refinement and any additional mobile polish. Production case filing remains intentionally fail-closed until an authorized adapter and independent readback exist.

## Selected decisions (supersede prior Cloudflare-host assessment)

1. **Independent Stately agent; no Letta, Pi or Muse runtime.** Stately/XState owns the controller, the persistent conversation state, and the feedback-trigger environment. The model decides only within machine-permitted behavior; it does not receive direct actor event handles or arbitrary file/GitHub write tools.
2. **Model:** existing owner-selected **Codex 5.6 Luna subscription via the Mac's CLIProxyAPI**. Historical, source-backed integration: OpenAI-compatible `http://127.0.0.1:8317/v1`, direct model `gpt-5.6-luna`. The `openai/gpt-5.6-luna` prefix applies only to LiteLLM configurations. **These are historical configuration facts, not a fresh health readback.** References:
   - `master-repo-0.1/work/issue-356-langchain-assert-acs-v0.1/pilot/model.py`
   - `master-repo-0.1/work/issue-356-langchain-assert-acs-v0.1/scripts/run_langchain_cli_proxy.sh`
   - `master-repo-0.1/experiments/ontology-reconciliation/README.md`.
3. **First runtime placement: Mac, not Cloudflare.** Local Node.js server connects to loopback CLI proxy; a small web app is served by that same process. Reach it from iPhone/desktop over existing **Tailscale Serve** as private HTTPS (NOT Funnel/public Internet). No relay from Cloudflare to Mac, no additional inference subscription. Treat optional public/cloud hosting as a later independent decision.
4. **Persistent single-host pilot:** reuse Stately's `examples/code-review-loop/file-store.ts` as a guide for its `AgentEventLogStore` and the already authored `feedback-trigger/FileDispositionJournal`. Isolate one server process, serialize per-session turns, keep files in a mode-0700 app directory outside the repository. The upstream example store is explicitly **not multiprocess-safe**; replace with a transactional store before multi-process/multi-host service. Do not claim fsync/database crash safety without testing.
5. **Case filing:** start with **human approval of case-worthy candidates** in the UI. Record the nomination and proposed case locally, show it immediately, and prevent an ordinary turn from falsely completing while disposition remains pending. After owner approval, a separately authorized Case adapter creates or links the issue via existing #76 governance path, independently reads it back, records the receipt, and resumes. Explicit reasoned dismissal is also a disposition. No production auto-filing or new permissions implied here.
6. **One implementation track:** extend draft PR #1 rather than creating a second sprawl-inducing implementation PR. Keep the main `next` branch and existing Mac services untouched until testing, review and deployment authorization.

## Final user-facing behavior

A private chat page on both laptop and iPhone. Each message carries a stable `sessionId` and `messageId`; the controller resumes the matching session and interprets messages in that state. A deterministic `[!?]{3,}` / whole-message `??` / explicit-eval detector **nominates**, never decides whether a failure exists. If nominated, one bounded Luna judgment examines the current turn and bounded relevant context, labels it as `dismiss(reason)` or `case(reason,category,evidence)`, and the host persists the disposition. A non-case dismissal resumes the normal response. A case judgment shows a **pending feedback-review card** with evidence and **File case** / **Dismiss with reason** actions; the normal response stays pending until a verified disposition (or a clearly reported blocker). A stored verified Case reference opens the corresponding issue. At most one judge call per trigger under normal operation; no extra judge call for ordinary messages.

The agent may be given broader intent-aware behavior later; this implementation must already preserve conversation/session continuity rather than reset to an isolated single-shot chat on every message.

## Implementation checklist, in execution order

### A. Reconcile and verify existing scaffold (no live changes)

- [ ] Verify `pnpm exec vitest run examples/adaptive-harness/feedback-trigger/feedback-trigger.test.ts`, `pnpm run typecheck:examples`, `pnpm lint`, `pnpm format:check` at a pinned PR head. Record actual command/results/commit in PR, not fixture authorship as PASS.
- [ ] Repair any machine/XState alpha API/type errors. Keep `src/` library implementation untouched unless a proven missing hook requires a reviewed change.
- [ ] Ensure fork GitHub Actions for draft PR run; if no workflow appears, diagnose settings/permissions before concluding tests passed.
- [ ] Pin package versions from fork lockfile (`@statelyai/agent` alpha and `xstate@6.0.0-alpha.69`), and record model adapter interface choices.

### B. Live Mac proxy preflight (read-only, no credential output)

- [ ] Inspect local service/listener for `127.0.0.1:8317`; verify model list from `GET /v1/models` or a suitably bounded authenticated request **without logging the key, config, tokens, raw headers, or account data**.
- [ ] Resolve the key through existing local CLIProxyAPI secret/config mechanism at runtime; no `.env`, API key, home directory secret or subscription token in Git. Dedicated account-scoped runtime environment and restrictive mode-0600 secret reference where supported.
- [ ] Probe a single bounded `gpt-5.6-luna` request and capture only status, actual returned model ID, token counts where available, and elapsed time. Test SDK Chat Completions API first because the fork's `@statelyai/agent/openai` adapter uses it; if the proxy needs Responses for this model, implement/verify the compatible executor rather than silently changing model/provider.
- [ ] Confirm service health after Mac login/restart, expected quota/error responses and rate limiting. Subscription-backed proxy access is contingent on the local proxy/provider's supported use and available capacity; do not assume unlimited calls.

### C. Build one Mac-local standalone host + chat

- [ ] Add `examples/adaptive-harness/app/` with a minimal Node HTTP handler and mobile-friendly chat page; reuse Stately's existing raw OpenAI SDK `createOpenAiExecutors` implementation (`examples/openai-sdk-host`) and existing package deps, not an extra framework by default.
- [ ] Create a small persistent Stately conversation machine with explicit `receiving → review-gate → generating → respond/blocked → awaiting-next-message` behavior. Maintain `sessionId`, message ordering, machine/policy version, event log, and bounded conversation context. The host owns all events and calls; a model output cannot forge `ALLOW_CASE` or `ALLOW_DISMISS`.
- [ ] Expose only tightly scoped authenticated routes: `GET /healthz` (no model secrets), `POST /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/:id/messages`, `GET /api/sessions/:id/feedback`, and `POST /api/sessions/:id/feedback/:id/disposition`. Validate all inputs and refuse cross-session IDs; include CSRF/Origin checks or a same-site session mechanism.
- [ ] Mount the existing `createGatedTurnHost` at **the only inbound message route**; when blocked, return an explicit pending/failed feedback object, not a fabricated assistant answer. The UI must make cases and recovery visible, not spin silently.
- [ ] Keep exactly one local process and serialize all writes to a given session; version event log/snapshots, test restart/replay and corrupt/missing journal fail-closed behavior. Never invoke the model for a replayed completion.
- [ ] Do not grant shell, file write, GitHub or Temper capabilities to the model in v0; authorized adapters sit behind host-owned typed methods.

### D. Plug in Luna judge + reviewed Case adapter

- [ ] Supply `FeedbackJudge.evaluate` with structured output validation (`dismiss` or `case`), a bounded ±10-message context when available, appropriate failure taxonomy, and evidence refs; no autonomous policy promotions.
- [ ] Connect the pending review UI to an idempotent approved case action. Prefer #76's current source-of-truth intake contract if a live implementation is proven, not a second canonical intake service. If #76 remains a plan/partial path, implement **local pending review first** and explicitly label GitHub filing unavailable until an authorized adapter is configured.
- [ ] GitHub case payload includes reproducible case signature/ID, source message ID + context pointers, recurrence/relationship links, primary + secondary taxonomy, expected behavior, minimal redacted evidence, proposed fix and replay eval. Search existing open/closed history before create. Protect private transcript content: default to metadata and a human-reviewable redacted summary, not automatic verbatim upload.
- [ ] For every filing, independently `GET` the native issue and verify its ID/body/signature before transitioning from pending to filed. On restart after remote filing, use persistent idempotency mapping and re-query; do not assume GitHub's search index gives exactly-once guarantees.
- [ ] File one test case to an approved isolated fixture or private test target, not `master-repo-0.1` production cases, until explicitly authorized.

### E. Verification, access, then activation

- [ ] Negative/golden tests: #388 `??` and mixed punctuation; quoted `???` dismissal; E36 status case as evidence (without claiming E36 status-read gate implemented); E37 self-diagnosis as out-of-scope egress case; duplicate request/retry; restart after judge and after filing; wrong session/user; missing CLI proxy/invalid model; readback failure; journal unavailable; guard bypass attempt; allowed nontrigger normal turn.
- [ ] Record factual metrics: no-trigger deterministic detection micro-cost; 0 feedback judge calls for ordinary turns, max one normally for nominated turns; normal response model calls; token/latency/error-rate comparison on a bounded fixture set; clear fallbacks when proxy unavailable.
- [ ] Confirm `tailscale serve status`, present HTTPS mounts, occupied ports and other local clients **before** choosing app port or changing mappings. Bind Node and CLIProxyAPI to `127.0.0.1`; expose **only** the chat app behind Tailscale Serve to the tailnet. No Funnel and no public server. Preserve authenticated access and tailnet ACLs.
- [ ] Verify from the Mac browser and an iPhone over Tailscale: normal two-turn context persists, `???` triggers pending/dismissal/case, approve/dismiss works, app restart preserves state, case link and readback match, alternate route cannot evade gate, model proxy is not externally accessible.
- [ ] After explicit activation approval, use a reviewed launchd agent (unprivileged account, controlled restart, bounded logs, nonsecret config, rollback). Record health readback, exact Git SHA, URL, and stop/rollback command before calling it live. Never disturb existing Tailscale Serve routes to force this installation.

## Planned source files

```text
examples/adaptive-harness/
  IMPLEMENTATION_PLAN.md                 # this source of truth for bounded work
  feedback-trigger/                      # existing 7-file scaffold in PR #1
    detector.ts, machine.ts, gate.ts, host.ts, journal.ts,
    feedback-trigger.test.ts, README.md
  app/
    server.ts                             # sole route / host boundary
    conversation.machine.ts               # persistent state and turn flow
    proxy-provider.ts                      # loopback gpt-5.6-luna adapter
    judge.ts                               # bounded, structured feedback verdict
    case-adapter.ts                        # owner-approved case intake / readback
    session-store.ts                       # event-log conformance and single-writer
    web/                                   # small responsive authenticated chat
    tests/                                 # route/state/proxy/negative tests
    README.md                              # commands and operational receipt
```

## Decision / scope boundaries

**Already selected by user:** forked Stately; separate from Letta; model via Mac CLI proxy (Codex 5.6 Luna); update execution plan. **Proposed default for implementation (not an applied runtime change):** one Mac process with local persistent storage and private Tailscale Serve, rather than cloud deployment. Explicit later approvals remain necessary for changing live Tailscale Serve configuration, installing persistent launchd service, granting case-write credentials / production auto-filing, or promoting a changed behavior policy. Do not bundle those permissions with a generic "go."

**Efficiency:** no extra model call on ordinary messages for trigger detection; one Luna judgment per nominated signal; batch/history lookup only for real case candidates; reuse existing event-log and OpenAI SDK code; a single host and no network relay/deployment bill. Reassess if persistent concurrency >1 host, event logs become large or probe shows Chat Completions incompatible.

## Definition of done

Source compiled and PR remains in review; verified tests and at least one real Luna call; two-turn stateful chat; on-trigger verdict and durable disposition; explicitly limited pending-review mode; private iPhone/desktop connectivity; restart survives with no lost/duplicate processing; and authorized activation receipt with rollback documented. The service is a verified private pilot, not a production deployment. The remaining product gap is the explicit identity/system prompt; case filing remains fail-closed pending a verified adapter and readback.

Historical issue #388 A/B/C Muse integration remains a separate Explore, not automatically satisfied by the standalone harness.
