# Durable XState session lifecycle — executable implementation specification

**Status:** planned and documented; **not implemented** in the current Stately harness. This is the next bounded work item on existing draft [PR #1](https://github.com/toasterman234/agent/pull/1), following the already CI-verified Tardigrade atom composer. Do not treat persistent `behavior.selected` as a persisted XState actor. Do not open another competing agent runtime or canonical event log.

## Objective

A message such as "continue", a pending feedback approval, an interrupted model call, and a suspended verification should all resume with the **same effective XState session state** after the HTTP handler finishes, a Mac LaunchAgent restarts, or an authorized application upgrade occurs. Session state includes active goal, mode, phase, selected behavior, pending feedback, outstanding work/correlation IDs, and legal next events. **XState owns legal transitions**; Tardigrade derives read-only behavior projections from the canonical journal. Luna is still used through the Mac's loopback CLIProxyAPI.

## Existing source, verified baseline

- `app/conversation.machine.ts` defines the XState v6 alpha machine with `awaitingMessage / reviewing / generating / blocked`, but `server.ts` currently executes `createConversationActor(sessionId); actor.start()` **for each message**. It never restores the previous actor snapshot.
- `app/session-store.ts` is an append-only, SHA-256 hash-chained JSONL journal holding `session.created`, `message.*`, `feedback.updated`, `turn.trace` and `behavior.selected`. The file is authoritative for the pilot; write operations use one process plus per-session serialization. Message dedupe uses stable `messageId`.
- `behavior-composer.ts` uses `tardie@0.50.0` pure atoms to derive session intent/goal/mode/phase and writes the **accepted** route to the same journal. It is **not a separate Tardigrade actor or a durable machine**.
- Current behavior and live telemetry are already attached to the mobile UI. CI verification for the bridge: [#40068259735](https://github.com/toasterman234/agent/actions/runs/40068259735) at `a50393f06e9f669fa5825a24500535a413c9308d`, 1,656 main tests passed.
- Upstream Stately references: `docs/persistence.md`, `docs/event-log.md`, `docs/choosing-a-run-mode.md`, `docs/advanced.md`. **For the current plain XState machine**, prefer native XState persisted snapshots plus host-written events. Do not imply the Stately `AgentRuntime` `result.persist()` method is already wired: that would require adopting its corresponding machine/runtime/host store contract. Avoid an unnecessary full rewrite for v1.

## Minimal design — one journal, replayable external events, snapshot as cache

### Machine state, versioning, and envelope

Define a versioned `SessionMachineRecord` with `sessionId`, `machineId`, `machineVersion`, monotonic `revision`, `lastAppliedSeq`, persisted snapshot, a source-journal hash/checkpoint anchor, and creation timestamp. This is JSON-only; prohibit executable clients, secrets, raw provider credentials and nonserializable objects.

Add a typed `machine.event` variant to `SessionEvent` containing **host-authorized external XState events** and their stable `eventId` / `messageId`, and a `machine.checkpoint` cache variant containing the validated persisted snapshot and the journal anchor. Keep existing `message.*` and `feedback.updated` entries backward compatible. A checkpoint is never its own authority; the ordered journal is.

Only persist/checkpoint at safe, quiescent boundaries: ready for another message, waiting for human feedback, or an explicit interrupted/failed state. Never pretend that a mid-flight actor snapshot includes an in-flight Luna HTTP request or a process-local promise.

### Read / write path

1. Under the existing `SessionStore.withSession(sessionId)` lock, read and validate the full chain **before** launching any side effects.
2. Load the most recent compatible checkpoint, verify its machine ID/version, source sequence/hash and JSON payload; otherwise rebuild from the prior machine events. For pre-upgrade v1 sessions with no `machine.event` entries, **derive a deterministic migration seed from verified existing journal records** (messages, pending feedback and behavior); do not guess unfinished actions.
3. Restore the existing XState machine using `createActor(conversationMachine, { snapshot })` after validating snapshot compatibility, or begin from the migrated seed. Start the actor once for this locked, resumed turn; it may be discarded after the stable checkpoint is recorded. An alternative long-lived registry must still serialize/recover from the same canonical log and must not hold session truth only in RAM.
4. Interpret incoming JSON as a _host-validated event_, with stable idempotency identity and expected revision. Before sending each event, verify that the actor can accept it in the current state; unknown, stale or forbidden transitions return 400/409 **without generating Luna output**.
5. Journal the accepted external event and any semantic `message.*`/`behavior.selected` write in a strictly ordered, idempotent operation; check append readback. **No external model/tool action until its initiating state transition is durably recorded.**
6. Use Tardigrade atoms to propose the behavior; let XState accept `SELECT_BEHAVIOR` only for the active message. Resume/generate as permitted. Persist the resulting external completion event and response receipt before returning an HTTP success. Append the checkpoint at a stable boundary.
7. On duplicate `messageId`, read the recorded response or pending disposition. Never invoke Luna again for an already-completed message.

A missing/corrupt journal segment fails closed. A cache-only corrupt checkpoint is discarded **only after** the underlying verified journal can reconstruct a compatible state; do not fabricate recovery from an incomplete history.

### Side-effect recovery (must be demonstrated)

- Associate each Luna/Case/tool request with a stable `callKey` derived from `sessionId + messageId + operationId` and record request intent before execution and completion after. On restart, reconcile existing results before retrying; a provider lacking idempotency cannot promise exactly-once external execution. The safe claim is **at-least-once execution with local dedupe/reconciliation**, not "never repeated" if the provider completed during a crash window.
- Pending approval/feedback is a **first-class machine state**, not only a UI/card or heuristic. `FEEDBACK_DISMISSED` and authorized `FEEDBACK_FILED` resume exactly the correct suspended turn; a newly arriving unrelated message must not bypass that wait.
- Concurrent requests to the same session are serialized; stale HTTP retries cannot apply duplicate or out-of-order transitions. Treat process restarts and network timeouts as normal recovery paths.
- Keep source `machineVersion`, `policyVersion` and `behaviorVersion` separate. A proposed policy update cannot silently rewrite active sessions.

### Migration

- Preserve existing `session.created`, messages, feedback and behavior journal entries unchanged; never truncate or rewrite the current `*.jsonl` files in place.
- Build `migrateLegacySessionV1` with explicit rules for: completed latest turn → `awaitingMessage`; existing pending feedback → `blocked`; incomplete user message without assistant output → `interrupted` for manual/deduplicated recovery (not automatic fresh generation); disallowed/unknown legacy shape → migration failure.
- Make migration pure and replayable. Version a **new machine version** and audit the exact old/new journal positions. Rebuild/verify in a temporary scratch directory against copies before enabling migration against actual Mac data.
- Atomic upgrade: stop only Stately, make a timestamped backup of its data and executable configuration without moving secrets into Git, verify the backup, update pin, run preflight, restart, read back, and retain rollback pointer. Rollback must be able to use preserved old records; don't make destructive schema migrations.

## Implementation work list (do the code, not another planning loop)

1. Add `app/session-machine-store.ts` with checked `restore / apply / checkpoint / replay` operations **on top of** the current `SessionStore` and one append-only log. Avoid parallel stores or always-resident actors on the first slice.
2. Make `conversation.machine.ts` versioned with typed events, guards and machine-owned migration. Extend context minimally: active goal/phase/behavior, pending turn/call correlation; do not redundantly store the full transcript if `SessionStore` already owns it. Decide duplication only after profiling.
3. Replace `server.ts`'s per-message brand-new actor with read → restore → verified transition → record → settle → checkpoint. Preserve the existing `createGatedTurnHost`, authenticating routes, `/activity`, `/behavior`, and pending-only Case behavior. Do not expose `actor.send` to the model or browser.
4. Add tests for a session spanning three messages and two independent process/store instances; restart while blocked; repeated same ID; wrong/stale revision; concurrent posts; unknown event; mismatched machine version; corrupt snapshot with intact log; corrupt journal; legacy v1 migration; crash after initiated call but before result; failed write with zero side effects.
5. Add one authenticated `GET /api/sessions/:id/state` returning **redacted** value, legal host events, machine/policy/behavior version, journal revision, pending status and last checkpoint age. Extend the mobile activity display to show the _actual restored machine state_ and allowed actions, not just a string derived from a one-turn actor.
6. Run scoped and repo CI tests, full typecheck, frozen lock install and a bounded local smoke. Measure typical replay and checkpoint sizes/latency; retain simple file storage unless contention or volume justifies a DB.
7. Deploy to the existing Mac LaunchAgent only with verified remote access and explicit live-rollout authorization. Check exact checkout/dirty state and existing Tailscale routes; protect the CLIProxyAPI loopback and credentials; record actual real-Luna resume/restart proof and rollback.
8. Update **the existing PR #1 and master issue #388** with code SHA, CI run, migration test evidence, live or blocked Mac proof. No duplicate PR or new runtime.

## Acceptance gates

- **Functional:** conversation active goal and selected behavior persist across three turns _and_ a fresh server process; a pending feedback turn restores exactly to an approval-required state; selected behavior and legal transitions display correctly on the phone.
- **Integrity:** hash-chain verified before recovery; journal/event writes are ordered; illegal events rejected; same ID never creates a second local completion; rollback works with archived original data.
- **Recovery:** simulate crash before and after a model completion; no unsupported exactly-once claim; a request with uncertain completion is flagged for reconciliation rather than blindly run or falsely marked done.
- **Efficiency:** normal nontrigger turns still have zero extra intent-model calls; session restore/derivation is batched/deterministic. Track replay time and JSONL size; only introduce a DB when thresholds show it is needed.
- **Evidence:** actual CI PASS at the candidate SHA and authorized Mac restart/real-Luna verification. Without latter, mark **source verified, rollout pending**.

**Do not conclude this work by only writing further plans.** Code the smallest deterministic restore/replay path, test it, and use bounded, explicit failure statuses when an external approval or disconnected Mac blocks activation.
