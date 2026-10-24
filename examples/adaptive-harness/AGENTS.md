# AGENTS.md — implement the adaptive harness (not a new plan)

**This file is an actionable work order for a coding agent.** Implement the selected, independent Stately harness in the existing draft branch. Read this file, then `IMPLEMENTATION_PLAN.md` and `feedback-trigger/README.md` before editing. Do not ask for another architecture decision when the existing instructions settle it. Continue as far as existing permissions and live infrastructure allow, and record results rather than claiming unexecuted tests passed.

## Current follow-up: Mac rollout and deeper session state

This work now has two explicit, nonoverlapping task documents; read these **before** writing another plan:

- [`app/MAC_ROLLOUT.md`](app/MAC_ROLLOUT.md) — deploy the *already-tested* Tardigrade behavior bridge to the **existing** Mac LaunchAgent after read-only preflight, preserving local data and rollback. Expected code SHA: `a50393f06e9f669fa5825a24500535a413c9308d`, CI #40068259735. The Mac Remote Desktop Commander connection was offline when last checked; do not claim a restart occurred.
- [`DEEP_STATE_PLAN.md`](DEEP_STATE_PLAN.md) — implement true persisted XState session restoration/replay, feedback approvals, interruption recovery, v1 journal migration and explicit state readback, without introducing a second durable runtime. **This is not present in the current code.**

Keep the initial rollout of the verified atom bridge separate from the later machine-snapshot migration: they have different recovery risks. Do not promote a source-only change as live. Continue implementation rather than another exploration loop, but stop if a requested Mac mutation cannot be safely reconciled with the installed service.

## Branch, scope, and prior work

- Repo: `toasterman234/agent`; checkout `work/388-feedback-trigger-scaffold` (existing draft PR [#1](https://github.com/toasterman234/agent/pull/1)); fork default branch `next`. Never commit this work directly to `next`. If the branch or upstream has moved, inspect and reconcile the actual HEAD first.
- [Master issue #388](https://github.com/toasterman234/master-repo-0.1/issues/388) is the design/evidence record; [#76](https://github.com/toasterman234/master-repo-0.1/issues/76) owns canonical Case intake; [#386](https://github.com/toasterman234/master-repo-0.1/issues/386) and [#387](https://github.com/toasterman234/master-repo-0.1/issues/387) are historical behavioral failure oracles, not evidence that those independent gates are already implemented.
- Reuse existing candidate code: `feedback-trigger/{detector,machine,gate,host,journal}.ts`, tests and README. Its current structure is **not verified by CI yet**. Do not silently throw it away.
- Do **not** install or run Letta, Pi, Muse, a Cloudflare backend, or a new database. Stay inside `examples/adaptive-harness/`. Keep `src/` untouched unless an exact upstream API limitation is proven and noted in the draft PR.

## Selected runtime (no further deliberation)

- **Host:** one Node.js process on the Mac (loopback-bound) serving an HTTP JSON API and minimal responsive chat UI. Same host owns session sequencing, Stately actors, feedback detection, and model execution.
- **Model:** existing local CLIProxyAPI at `http://127.0.0.1:8317/v1`; direct model id `gpt-5.6-luna` (only prefix `openai/` when a separate LiteLLM caller requires that notation). No new inference subscription or cloud keys.
- **Executor:** reuse `@statelyai/agent/openai` `createOpenAiExecutors` from `examples/openai-sdk-host/index.ts`, if a live probe confirms the proxy's Chat Completions compatibility. If incompatible, isolate the minimum proxy-compatible executor and prove real behavior; never claim a simulated request proves Luna compatibility.
- **Persistence:** per-session Stately event log plus feedback dispositions, on the Mac in an application-owned directory *outside* the Git repository (e.g. an unoccupied subdirectory of `~/.local/share/`). One process and serialized turns per session; no simultaneous writers to the sample JSONL store. See `examples/code-review-loop/file-store.ts` and Stately `docs/event-log.md`. Prove restart/replay; don't claim a file example is multiprocess-transactional.
- **Access:** local loopback first; future private iPhone access through existing Tailscale **Serve**, never Funnel or public proxy forwarding. Do not modify Tailscale routes or install launchd until expressly authorized. Never expose 8317 to the network.
- **Case disposition:** judge nominates `dismiss(reason)` or `case(reason,category,evidence)`. A case-worthy result becomes a visible pending proposal requiring human action. Do not write to real master-repo issues automatically. If no authorized native #76 case adapter can be verified, implement **pending-only mode** and label remote filing unavailable. Normal answer remains gated until a verified dismissal/approved filing disposition, with clear UI recovery.

## Execute in this order, committing incremental functional code to PR #1

### 1. Verify what is already written
1. Run `git status --short --branch`, `git rev-parse HEAD`, and read `package.json`, lockfile, `examples/tsconfig.json`, `feedback-trigger/*`. Do not overwrite unrelated worktrees/changes.
2. Install dependencies using the repo's pinned `pnpm` version and checked-in lockfile if needed (no global package-manager changes).
3. Run, capture exit codes, and fix failures:

   ```sh
   pnpm exec vitest run examples/adaptive-harness/feedback-trigger/feedback-trigger.test.ts
   pnpm run typecheck:examples
   pnpm run lint
   pnpm run format:check
   ```

4. Keep negative tests: `???`, `?!?`, `!!!`, `??`, explicit eval, false-positive quotation, message-id reuse, duplicate/retry, missing case adapter, failed journal readback, and inability to call the normal turn while blocked. Do not mark tests PASS until the commands actually run.

### 2. Probe Mac CLIProxyAPI without leaking credentials
1. Confirm you are running in the authorized Mac execution environment. Check the listener on **127.0.0.1:8317** and the proxy health; do not assume a historical README proves current availability.
2. Reuse the local runtime-only CLIProxyAPI key mechanism (documented by `master-repo-0.1/work/issue-356-langchain-assert-acs-v0.1/scripts/run_langchain_cli_proxy.sh`). Never commit, print, echo, forward, or log the key, proxy config, account tokens, raw authenticated headers, or transcript secrets. Do not change the proxy configuration.
3. Issue **one bounded, authenticated** call to `gpt-5.6-luna`; confirm whether `/v1/chat/completions` works with the Stately OpenAI executor, and record only sanitized: HTTP outcome, returned model identifier, response validated, elapsed time, usage count if supplied. If Chat Completions fails but Responses works, write and test a narrow compatible executor without changing model/provider.
4. If the Mac/proxy is inaccessible, build and test offline against an injected fake model, record the precise blocker, and stop claiming live-model readiness. Do not create a cloud fallback or new key.

### 3. Implement the runnable local host and UI
Build only `examples/adaptive-harness/app/` plus necessary focused changes to `feedback-trigger/`:
- `conversation.machine.ts`: persistent XState per-session lifecycle, session/version identity, chronological message history, deterministic preflight → guarded model generation → response/blocked → awaiting message.
- `server.ts`: one loopback HTTP server and the **only inbound chat route**; it must call `createGatedTurnHost`. A blocked gate must never call the underlying model/normal-turn callback.
- `session-store.ts`: event-log store with single-writer session serialization, dedupe by source message id, restart/replay verification, immutable log entries; ensure concurrent requests and crash retries do not repeat side effects.
- `proxy-provider.ts`: configurable loopback base URL and model id with a fixed safe default; local-only runtime secret injection; request errors are typed and visible.
- `judge.ts`: one bounded Luna call only on triggered messages; strict structured/validated `dismiss` vs `case` verdict and taxonomy, backed by bounded session context. Quoted punctuation and excitement can be dismissed with reason. Invalid output blocks (never silently passes).
- `web/`: functional minimal responsive chat for desktop/iPhone, sessions/history, live reply or explicit blocked status, feedback review card showing signal/context/verdict, **Dismiss with reason** and **File case** UI actions. In pending-only mode, `File case` remains disabled or explicitly unavailable rather than reporting a fake success.
- `app/README.md`: exact local run command, safe env names (values omitted), health endpoint, smoke script, and operational limitations.

Use input validation, appropriate same-origin/session auth for any exposed interface, bounded payloads/context, safe logging, and nonsecret errors. Do not introduce an anonymous publicly reachable API. Local loopback may use a dev-only session; Tailscale exposure needs a verified authentication approach.

### 4. Case approval semantics — avoid a dead-end UI
The existing gate intentionally blocks if a Case sink is missing. **Preserve fail-closed behavior.** Implement the user-visible pending record and recovery path explicitly: a human may dismiss with an auditable reason (then continue that session) or request filing through a real authorized, idempotent, read-back verified #76 adapter. If the adapter is not available, the case stays pending and the UI explains why. Do not treat `approved` or `filed` as true without a remote issue readback. Search prior issues before creation; redact actual conversation data by default. A local redacted proposal is not a filed GitHub issue.

### 5. Test and demonstrate end-to-end locally
- Test normal two-turn context; no judge call for nontriggers; one judge call per nominated turn under normal operation; `??`, `?!?`, `!!!`; quoted false positive and reasoned dismissal; genuine failure becomes pending; approval/dismissal flows; repeated message ID; source-hash collision; after-crash replay; concurrent requests; missing/invalid proxy model; broken journal; illegal machine events; wrong-session access; and any alternate route bypass.
- Prove **a normal response cannot escape while feedback disposition remains blocked**. The UI must report a visible pending/blocked state, not hang.
- Run the full targeted Vitest/TypeScript/lint/format commands above and the host-specific tests. Record each exact command, exit code and failing/passing assertion; if time or access prevents a check, say `NOT RUN` rather than PASS.
- Demonstrate the Mac loopback chat with the real proxy before claiming `model-connected`. Capture sanitized /healthz and multi-turn transcript receipts, not credentials or unredacted private history.
- Check occupied ports and `tailscale serve status` **read-only**; prepare a non-conflicting Serve command/mapping for owner review. Do NOT apply Serve changes, create launchd persistence, open public interfaces, or auto-file a production GitHub issue without separate explicit authorization.

## Deliverable and final verification report

Commit code and tests **to the existing branch** and update draft [PR #1](https://github.com/toasterman234/agent/pull/1); don't open a duplicate PR. Include in its description/comment:
- pinned head SHA; files added/changed; test commands and actual exit status;
- probe outcome for the exact proxy/model and any unsupported API surface;
- demo evidence: real two-turn state, punctuation disposition, persistence/restart, negative bypass test;
- exact **local** URL only if verified listening; Tailscale URL only if actually authorized/configured and read back;
- what remains pending due to a missing case adapter, authorization, proxy access, or service deployment.

Update the relevant [#388](https://github.com/toasterman234/master-repo-0.1/issues/388) thread with the PR/verification summary. Keep the draft unmerged and do not close #388 merely because a local demo works. Source approval is not permission to activate live services.

**Do not stop after writing another plan.** If an optional external integration blocks, implement and verify the remaining isolated functional slice, clearly labeling the blocker. Prioritize a working, testable local harness and actionable receipts over additional exploratory documents.
