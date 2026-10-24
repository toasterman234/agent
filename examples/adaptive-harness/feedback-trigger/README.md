# Standalone adaptive harness — feedback trigger (candidate)

**Status:** isolated fork scaffold, **not** deployed or activated by Stately. No Letta.
Source requirement: [master-repo-0.1 #388](https://github.com/toasterman234/master-repo-0.1/issues/388). This is the bounded implementation spike approved by the user for the fork. It does not select #388's A/B/C production options, change the canonical Case lifecycle, or supersede [#76](https://github.com/toasterman234/master-repo-0.1/issues/76).

## Why this is a harness behavior

The **host** (not the model) exposes `createGatedTurnHost`, which calls `gateInboundFeedback` before invoking the ordinary agent. The wrapper refuses to invoke that callback when the gate blocks. `detector.ts` deterministically nominates a feedback review; `machine.ts` restricts the flow to `detected → judging → recordingDismissal/recordingCase → allowed/blocked`. The host owns the actor instance and the ALLOW_* events. A hosted model must never be handed the actor handle or those events as callable tools.

`gate.ts` requires a reasoned judgment and durable journal readback for dismissal; a case judgment additionally requires a case sink's independently verified reference and saved disposition. When judgment, Case intake, or persistence fails, it returns `replyAllowed: false` with a visible pending record where possible. The application MUST withhold its normal reply unless `replyAllowed` is true. It may send a separate operational error/blocked notification. Merely importing the module, or attaching passive trace observers, cannot enforce the guarantee.

## Signals

- Contiguous `[!?]{3,}` anywhere (e.g. `???`, `!!!`, `?!?`, `!!?`, `????????`).
- Whole message of 1–3 `?` / `!` characters, allowing spaces (includes historic `??`).
- Anchored commands such as `/eval`, `Eval case`, `Eval/feedback`, `feedback/eval`.

Quotations and excitement still nominate; the contextual judge must dismiss false positives with a recorded reason. Nomination alone does **not** assert an agent failure.

## Minimal host wiring

```ts
import { createGatedTurnHost } from "./feedback-trigger/host.js";
import { FileDispositionJournal } from "./feedback-trigger/journal.js";

const journal = new FileDispositionJournal("./.local-feedback-dispositions");
// Judge has an app-owned LLM interface and may inspect the current session.
// It must return a validated { kind: "dismiss", reason } or
// { kind: "case", reason, category }. The example does not choose a model.
const judge = { evaluate: async ({ message, signal }) => yourFeedbackJudge(message, signal) };
// Case sink MUST route through the existing approved #76 intake contract:
// fileOrLink({ idempotencyKey, ... }) -> { ref }; verify(ref) -> boolean.
const caseSink = yourAuthorizedCaseSink;

const onIncomingMessage = createGatedTurnHost({ judge, journal, caseSink }, runNormalAgentTurn);
// Expose onIncomingMessage as the ONLY public ingress. When blocked, the
// result is { kind: "blocked", feedback: ... } and normalTurn was not called.
```

The snippet is **integration pseudocode**: `yourFeedbackJudge`, `yourAuthorizedCaseSink`, and `runNormalAgentTurn` are host-provided functions, not implemented library exports. The tests use injected fakes. Without a case sink, case-worthy verdicts remain pending and blocked, not falsely "filed".

## Journal guarantees and limitations

`FileDispositionJournal` stores JSON per (sessionId, messageId), with the message text SHA-256. It uses per-key exclusive directory locks and atomic rename for local single-host access, then reads the record back. It preserves final dispositions and allows retrying a pending one. An existing lock or malformed journal entry **fails closed**, requiring investigation; don't delete a lock without checking whether its writer is active. The example is not a database, distributed lease service, fsync-backed transaction manager, or evidence of multi-host reliability.

The _Case sink itself_ must guarantee idempotent `fileOrLink` by the provided key, because process death after remote filing but before journal commit could otherwise create duplicate cases. Search open/closed/superseded history and preserve recurrence links per #76. Merely recording a `filed` status locally is not enough; the sink's `verify(ref)` reads the authoritative record. If no sink is provided, the trigger is not yet an active case-filing capability.

## Run tests

From repo root, with exact fork dependencies installed:

```sh
pnpm exec vitest run examples/adaptive-harness/feedback-trigger/feedback-trigger.test.ts
pnpm run typecheck:examples
```

Also run the repository's existing lint and format checks before adoption. No production keys or LLM provider are required for these fixtures.

## What this does NOT yet solve

- **E36/#386:** a status response from a worker "running" flag must be separately gated on fresh worker transcript **and** system-of-record reads.
- **E37/#387:** an assistant's self-diagnosis can occur in generated output; it needs a controlled egress/finalization check, not just this inbound punctuation detector.
- Session-oriented intent routing, KiwiFS, Temper, agent policy evolution, scheduled backstop auditor, UI, and adapter deployment are outside this bounded candidate.
- Runtime interception applies only to inbound messages that actually flow through the gated host entry point. Other ingress and alternate tool routes must be closed/tested before claiming enforcement in a deployed agent.

## Acceptance and traceability

Testing this module proves only the fixture behavior under the host wrapper. A later adoption requires pinned dependency versions, independent live-case readback, positive and false-positive fixtures, crash/restart checks, alternate ingress negative tests, and the authorized Case/approval decision. Keep the draft PR and [#388](https://github.com/toasterman234/master-repo-0.1/issues/388) linked; do not close the incident loop merely because source files exist.
