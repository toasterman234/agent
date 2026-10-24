# Stately executable policy and behavior contract — implementation specification v0.1

**Document status:** Proposed, reviewable SPEC; not activated policy, approved Work, canonical Plan, or evidence of a live change.  
**Source baseline:** toasterman234/agent **next** at 4f03a77c8d764c634ded43322422ac103e1ee0ec (merged PR #1, October 24, 2026).  
**Ownership and lineage:** master-repo-0.1 [#388](https://github.com/toasterman234/master-repo-0.1/issues/388), prior classification [#359](https://github.com/toasterman234/master-repo-0.1/issues/359)/[#360](https://github.com/toasterman234/master-repo-0.1/issues/360), closed bounded Temper integration [#393](https://github.com/toasterman234/master-repo-0.1/issues/393)/[#394](https://github.com/toasterman234/master-repo-0.1/issues/394), existing [DEEP_STATE_PLAN.md](./DEEP_STATE_PLAN.md).  
**Scope:** Only examples/adaptive-harness and its existing feedback-trigger seam; no Stately core rewrite, second database, new tool framework, privilege changes, automatic self-modification, or Mac deployment under this spec.  
**Decision requested for promotion:** separately scoped Work + required canonical Plan/Decision/Gate and deployment approval under master-repo component-onboarding contract. This document specifies what to build and how to prove it; approval of an architectural direction alone is not authorization for activation.

## 0. Source-backed baseline and corrected history

- Runtime agent/AGENTS.md, POLICY.md, BEHAVIOR.md and three SKILLS/*.md files load via app/agent-config.ts. POLICY.md and BEHAVIOR.md are currently included in the Luna system prompt, **not executable rule definitions**.
- app/behavior-composer.ts with pinned tardie@0.50.0 uses ephemeral atoms to classify continue/revise/verify/status/discuss, derives one of five behaviors, and writes an accepted behavior.selected event to the existing session journal. It is NOT a persistent Tardigrade actor and does not authorize actions.
- app/conversation.machine.ts uses xstate@6.0.0-alpha.69. server.ts creates and starts a fresh XState actor for each incoming message, checks SELECT_BEHAVIOR and then runs the feedback gate. It does not restore an actor across turns.
- app/session-store.ts is the sole local append-only hash-chained JSONL journal; preserving existing events and journal integrity is mandatory.
- app/feedback-trigger/gate.ts **does** enforce a pre-model reply gate on nominated feedback. Dismissals require journal readback; case submission remains pending-only without an authorized verified #76 adapter.
- app/temper-gateway.ts provides a host/UI-controlled read-only gateway for tenant incident-rca with dedicated stately identity and an allowlist of Incident, Remediation and Postmortem. It is not a model-facing tools loop and grants no write capability.
- Read-back receipts in master #394 reported a live Mac read-only Temper + Tardigrade rollout and a tested mobile UI on October 24. This is **historical observation, not a fresh probe in this spec**. Source and effective runtime versions must be checked independently.
- PR #1 is **merged** (old work documents still say draft/unmerged). Never attempt to append changes to that closed PR. Use the current next base and separate reviewed changes.
- Existing DEEP_STATE_PLAN.md is the owner for journal-backed XState restore/replay; this spec extends its contracts, not another competing persistence plan.
- Mac LaunchAgent startup was previously repaired to use **node --import tsx** instead of a hanging pnpm exec wrapper. Do not regress that existing operational fix.

## 1. Objective and precise meaning of "live policy/behavior"

A rule is not live because it appears in Markdown, a registry, a model prompt, a unit test file, or an installed package. It is live only when a specific installed, trusted **decision boundary** executes it for a supported class of events/actions; observed denial/allowance can be traced to the effective version and validated independently.

Success is an auditable path:
authored normative control -> executable implementation/Temper-deployed policy -> explicit interception point -> tests including deny/bypass cases -> reviewed artifact -> activated process and effective version -> independent runtime observation -> generated/readable description.

Maintain TWO different user-facing views:

1. **Source contract** (versioned in Git): deterministic generated app/agent/POLICY.md and app/agent/BEHAVIOR.md, describing implemented controls and expressly labeling advisory/unavailable behavior. Do not edit these descriptions by hand after generator adoption.
2. **Effective runtime contract** (read-only API/mobile): actual loaded config hash, source SHA, machine and behavior versions, current session state, and separately observed Temper information. If a live Temper policy hash or spec revision is not exposed by an authenticated documented API, report **unknown**, not inferred/green. Read-only health does not prove authorizations.

Never label a natural-language quality instruction as deterministically "enforced" merely because model output is prompted to comply. Enforcing "no false completion" must mean blocking a **structured terminal state/action** without evidence. It does not automatically prevent every misleading free-form sentence; those require separate output validation/evals with clearly bounded claims.

## 2. Authority and trust allocation

| Concern | Source of authority | Local role and security boundary |
|---|---|---|
| Agent identity, response style and prompt-only skills | reviewed Stately runtime configuration | Host loads and supplies text; advice and input-bound /skill allowlist only |
| Session state, legal event transitions, blocked feedback and completion gates | XState actor + host guards + one verified SessionStore journal | Host alone sends legal events; model and browser cannot generate authoritative events |
| Intent, context, goal candidate and response guidance | disposable Tardigrade derived atoms | Nominates behaviors; NO permission grant, irreversible state promotion or second durable store |
| Authenticated agent identity, tenant-scoped permissions, approved governed entity actions | actually deployed Temper credential/Cedar/spec/IOA authority | Narrow host-owned gateway; never mirror a permissive local "allow" instead of a real Temper authorization |
| External effects and factual success | native target and independent result readback | Temper governance plus native source receipt and verification; no model assertion as evidence |
| Human approval | authenticated approved decision service | Mobile session cookie / tailnet presence is NOT human approver identity |
| Work/canonical adoption | master-repo canonical Plan/Work/Decision/Gate | GitHub artifacts and CI do not self-promote or broaden runtime authority |

**No new mutating Temper actions are in scope.** Existing read-only behavior and pending-only Case must remain unchanged until a separately reviewed, scoped Work/authorization is proven.

## 3. Contract inventory and classification — starting denominator

Each existing prose assertion receives a stable control ID and a classification with precise interception. These rows are requirements to assess, NOT unconditional claims of complete runtime coverage.

| ID | Current description | Existing evidence | Required disposition |
|---|---|---|---|
| POL-001 | Model text cannot authorize transitions/actions | server XState host events, no model tools | host-bound state/action enforcement; test injected fake "approve" |
| POL-002 | Feedback nominations cannot bypass preflight | feedback-trigger/gate.ts, host.ts | blocking; preserve negative cases and readback |
| POL-003 | GitHub Case filing pending-only | server.ts returns 409 to file action | unavailable, explicitly deny attempt; future activation separate |
| POL-004 | No arbitrary shell/GitHub/network editing by model | provider currently uses no exposed tools, fixed APIs | capability deny boundary, verify no alternate egress route |
| POL-005 | Secrets and untrusted text boundaries | host token file/read-only gateway, prompt disclosure advice | separate host-secret controls from advisory text; negative secret exposure tests |
| POL-006 | Must not fabricate execution or "done" | current POL/BEHAVIOR prompt instructions | **advisory for free-form text**; enforce only structured verified completion with trusted evidence; separate output eval |
| POL-007 | Agent cannot self-promote policy | startup-only source config and no editing tool | host denies model config mutations; human reviewed promotion external to agent |
| BEH-001 | Versioned prompt and bounded recent context | agent-config.ts/server.ts | host-effective binding; bounded-context tests |
| BEH-002 | Feedback before model generation | gated host + feedback machine | blocking workflow invariant |
| BEH-003 | Pending feedback suspends work until disposition | feedback journal and app host | strengthen with persisted XState blocked state/recovery |
| BEH-004 | No long-term memory or self-editing claims | local message window, prompt | explicit unavailable features + LLM eval for language claims |
| BEH-005 | One explicitly selected prompt skill | /skill allowlist, systemInstructions | host-validated bounded selection; no tool grants |
| BEH-006 | Short response style | BEHAVIOR.md prompt | advisory, not a safety guard |
| BEH-007 | Five Tardigrade behavior selections | behavior-composer.ts | selection is deterministic; verification/working "phases" currently projections, NOT durable executed work states |

A requirement can have multiple controls; a failure case can point to multiple requirements. Preserve links to #359/#360's taxonomy and prior failure evidence, and mark missing evidence **unverified**, not "passed". Expand this table against source when implementing; acceptance requires **100% coverage of the explicitly enumerated POLICY/BEHAVIOR clauses as one of blocking/detecting/advisory/unavailable**, not 100% enforcement.

## 4. Typed descriptors — metadata, not an authorization engine

Implement within app/ as small definitions generated or exported from the actual enforcement modules. No independent Cedar clone, YAML runtime interpreter, extra Tardigrade host, or duplicated rule decision state.

Proposed TypeScript contract (fields illustrative and subject to type-level refinement):

~~~ts
type Strength = "block" | "detect" | "advise" | "unavailable";
type CodeStatus = "implemented" | "planned" | "retired";
type ActiveStatus = "active" | "inactive" | "unknown";
type Verification = "unverified" | "source-tested" | "runtime-observed" | "end-to-end-verified";
type EnforcementBinding =
  | { owner: "host"; interception: string; implementationId: string }
  | { owner: "xstate"; machineId: string; event: string; guardId: string }
  | { owner: "temper"; tenant: string; capabilityId: string; policyRef?: string; specRef?: string }
  | { owner: "advisory"; promptRef: string };
type ControlDefinition = {
  id: string;
  description: string;
  sourceRefs: string[];
  strength: Strength;
  codeStatus: CodeStatus;
  owner: "host" | "xstate" | "tardigrade" | "temper" | "prompt";
  binding: EnforcementBinding;
  positiveTests: string[];
  negativeTests: string[];
  evidenceRequirements: string[];
  supersedes?: string[];
};
type EffectiveManifest = {
  schemaVersion: 1;
  sourceSha: string | null;
  configHash: string;
  machineVersion: string;
  behaviorVersion: string;
  localPolicyVersion: string;
  startedAt: string;
  temper: { tenant: string; metadataHash?: string; policyVersion?: string; specVersion?: string;
            authObserved: boolean; status: ActiveStatus; checkedAt?: string };
  controls: Array<{ id: string; strength: Strength; active: ActiveStatus;
                    verification: Verification; evidenceRefs: string[] }>;
};
~~~

**Security model for bindings:** An ID string in metadata proves nothing. Every "block" ID must be bound by a trusted guard/interceptor used on the actual execution path, with an executing deny test and a bypass test. A compile-time path/name-only registration cannot grant "enforced" status. A Temper control must report locally "configured" separately from the remote policy's actual active status.

Versioning:
- immutable Git commit SHA **and** full content digest for loaded local contract;
- separate machineVersion, behaviorVersion, localPolicyVersion, skill/prompt configHash;
- separate independently read Temper effective policy/spec/tenant/identity revisions if exposed;
- each session pins effective versions at creation, with migration/event when changed.
No floating "latest" policy silently changes an in-flight or blocked session. Actual Temper authorization must always be evaluated against live credential/policy; a historical session pin is **audit provenance**, not a request to bypass current revocation.

## 5. Runtime event/state contract — reuse DEEP_STATE_PLAN.md

Implement DEEP_STATE_PLAN.md before claiming durable workflow enforcement. Use a single journal with typed machine.event, machine.checkpoint and optional control.evaluated/operation.* events. Never introduce a second canonical state source.

At a high level:
- awaitingMessage -> preflight -> composing -> generating -> awaitingVerification (only for actual proof-requiring operations) -> completed/failed/interrupted -> awaitingMessage.
- From preflight, feedback nomination can enter blockedFeedback. Pending remains blocked after restart until an authenticated permitted disposition. Current mobile dismissal is a bounded **feedback dismissal**, NOT approval for privileged external actions.
- Tardigrade selects a proposed behavior; XState validates it for active message, state and allowed behavior ID; accepted selection is recorded before model invocation.
- Verification behavior by itself means **verify intent and plan**. It must not falsely set verified without a verifier result. For a real completed action, terminal "verified" requires structured, independently validated EvidenceReceipt. No tool capability = "verification requested/awaiting evidence", not imaginary success.
- Explicit new-goal selection differs from guessing active goal from any conversational text. Continuation/revision preserves previously confirmed goal and restrictions; uncertain/ambiguous text does not silently create a Work entity.
- Every externally consequential event has stable eventId/requestId, expected journal revision, session/user identity and immutable correlation. Unknown/stale/wrong-session events fail before model/tool egress.
- Event intent is journaled and independently read back before a non-idempotent side effect. Completed result and source verification are journaled afterward. A crash between call and receipt yields **unknown/reconciliation**, not an unsupported exactly-once claim.

**Persistence API:** For pinned xstate@6.0.0-alpha.69 use actor.getPersistedSnapshot(), not actor.getSnapshot(), and restore using createActor(machine, { snapshot }).start() after compatibility validation. This is an alpha API; test exact version. Checkpoint is a cache tied to source journal seq/hash; source journal replay is authoritative. Never claim that restoring an actor recreates a pending HTTP request.

**Existing journal migration:** Preserve v1 records. Completed turns restore to awaitingMessage; pending feedback to blockedFeedback; interrupted or ambiguous calls to interrupted/unknown for reconciliation; malformed or version-mismatched events fail closed. Test on data copies before considering live migration.

## 6. A generated source document and separately observable live document

Suggested minimal files:
- app/controls/control-contract.ts — types, control IDs, actual binding metadata, classification.
- app/controls/behavior-contract.ts — maps existing five Tardigrade IDs to actual machine states/guards/instruction fragments; no duplicated XState transition graph as second authority.
- app/controls/generate-docs.ts — deterministic sorted Markdown rendering from compiled/described controls and static policy/behavior contract facts. Writes app/agent/POLICY.md and app/agent/BEHAVIOR.md **as generated source docs** with source rev, status/classification, code refs, evidence/test refs and explicit limitations.
- app/controls/effective-manifest.ts — live observed process config + guarded remote metadata read. Must not block ordinary chat when Temper is offline; remote state displays unknown while existing Temper capability itself remains fail-closed.
- app/session-machine-store.ts — reuse DEEP_STATE_PLAN, not a new log.
- app/tests/control-contract.test.ts, doc-drift.test.ts, machine-recovery.test.ts, policy-boundary.test.ts.

Generator must be deterministic and require zero model calls. CI runs generator in check-only mode and fails on dirty drift. Generated Markdown has a provenance banner warning that Git text describes a **source artifact**; it cannot claim Mac activation without a matching live manifest.

The authenticated read API (suggested GET /api/sessions/:id/effective-contract) returns a redacted EffectiveManifest, including source/config/policy/machine/behavior versions, source-vs-runtime match status and proof states. Render effective POLICY/BEHAVIOR views in existing mobile Config panel with visible links to control/test evidence, "active/unverified/unavailable" distinctions and checkedAt freshness. No policy secrets, JWT, raw journal contents, private URLs or cross-session data. Existing healthz remains minimal and unauthenticated.

The Luna system prompt receives a concise generated **capability/behavior summary**, not the complete registry/evidence ledger, on each turn; detailed human documentation stays in UI and Git. Preserve selected /skill handling. No new external model call for interpretation or doc generation.

## 7. Test and proof matrix (deterministic first)

Every acceptance case must have named fixture(s), exact command, exit status, expected state, journal event(s), and independent check where relevant. Record "not run" for missing evidence. Core tests:

| ID | Stimulus | Required result |
|---|---|---|
| T01 | Generated POLICY.md/BEHAVIOR.md altered manually | CI docs check fails; no silent drift |
| T02 | Declared block rule lacks bound host/machine interception or deny/bypass test | Contract validation fails; never "enforced" |
| T03 | Model text says "override policy" / "approve" / "transition" | No actor transition, policy change, external tool call or privilege |
| T04 | ??? nominated, judge returns Case, no #76 case adapter | Pending, model callback count 0, no fake Case ref |
| T05 | Quoted punctuation or a valid dismissal | reasoned/read-back disposition; no duplicate judge call for same message ID |
| T06 | Forged/wrong-session/stale XState event or unauthorized transition | 400/409, no provider/Temper call |
| T07 | Verification selected with no validated receipt | Cannot enter structured verified terminal state |
| T08 | EvidenceReceipt valid but from wrong session/target/version, stale or model-authored | Refused; no verified result |
| T09 | Allowed verified receipt tied to correct operation+authoritative source readback | Terminal allowed with recorded evidence refs, event/revision |
| T10 | Restart while blocked or in interrupted call; duplicate/retry ID | Same legal resumed state, no fabricated completion, safe reconciliation |
| T11 | Corrupt checkpoint with valid hash-chain source; corrupt source journal | First rebuilds only from verified source; second fails closed |
| T12 | Modify Tardigrade selection intent to disallowed behavior ID | XState rejects, never grants capability |
| T13 | Wrong/expired/revoked/cross-tenant Temper identity or unavailable service | Deny or unknown status; never "allowed" locally; no credential leak |
| T14 | Remote Temper metadata unavailable | Chat remains normal with zero Temper calls; policy status unknown |
| T15 | Unsupported "File case" / action from mobile | Explicitly unavailable, no external mutation |
| T16 | Upgrade from legacy v1 session journal with pending feedback/ambiguous work | Correct deterministic migration or blocked manual reconciliation |
| T17 | Source changes but Mac still serving old process | UI displays differing source/effective revisions, never silently green |
| T18 | Direct route accidentally bypasses feedback gate or trusted effect interceptor | Integration test fails |
| T19 | Remote and source policy versions differ, or no authorized policy read endpoint | Warn unknown/mismatch; no invented remote revision |
| T20 | Agent attempts self-edit/reconfigure, injects secrets in prompt/skill | Cannot mutate config or use unexposed tools; sensitive metadata redacted |

CI commands to wire:
~~~sh
pnpm exec vitest run examples/adaptive-harness/feedback-trigger/feedback-trigger.test.ts
pnpm exec vitest run examples/adaptive-harness/app/tests/
pnpm run typecheck:examples
pnpm run lint
pnpm run format:check
pnpm run knip
pnpm run test:ci
~~~
Add a documented deterministic docs check command and bind it to CI. CI success validates **source**, not active Mac or authoritative Temper policy.

Property-based/state-model tests: generate sequences of valid/invalid events, concurrent retries, interruption/restart points, stale versions and forged receipts; assert no unauthorized terminal state or model call from blocked state. Reuse test harness and existing journals with fake provider and fake gateway; run a limited real Luna/Tailscale smoke separately only when authorized.

## 8. Work packages, order, dependency and measurable acceptance

**W0 — source-to-control census and test inventory (read-only/design):**
- enumerate all normative assertions in current POLICY/BEHAVIOR and existing five behavior IDs; map source, actual code interception, scope, negative tests, gaps, and historic counterexamples (#359/#360).
- output one reconciled table with denominator, unverified/disputed controls and owning references.
- **accept:** no unknown "enforced" entries; cross-check current next, merged PR #1, closed #394 and effective Mac baseline separately.

**W1 — typed contract + generated docs (source-only, no live policy):**
- implement actual-bound descriptors, deterministic generator, docs-check, "implemented/advisory/unavailable" classifications, and status API schema.
- **accept:** T01/T02 and source docs regression, zero additional model requests, no change to original feedback behavior.
- This can be developed and reviewed independently while W2 durable-state testing proceeds.

**W2 — real durable XState recovery (DEEP_STATE_PLAN dependency):**
- migrate original v1 journal safely; restore/apply/checkpoint with source hash; persist legal events; enforce blocked feedback across requests/restarts.
- **accept:** T04/T06/T10/T11/T12/T16/T18; restart + negative-gate evidence, no duplicate local response, interruption marked unknown when necessary. No Temper write access.

**W3 — narrow executable behavior and evidence guard:**
- make behavior selections correspond to real machine procedures where capabilities exist; structured result/verification states only when supported. Implement host-owned EvidenceReceipt validator before terminal "verified".
- **accept:** T03/T07/T08/T09; verify behavior never authorizes remote tools, statuses and session transitions are read-backable. No broad self-modification.

**W4 — effective manifest + mobile inspect view:**
- report local installed source/config/behavior/machine versions and independently available Temper metadata/policy versions; distinguish unavailable from verified; present source-vs-running drift and named control evidence.
- **accept:** T13/T14/T15/T17/T19/T20, authenticated API tests, phone 390x844 readability. Do not invent a Temper version endpoint.

**W5 — separately authorized live activation and rollback:**
- governance/Work approval; exact Git SHA + lockfile; preserve Mac session journal and run.sh direct node --import tsx fix; backup/readback; bounded service restart; authenticated local and private tailnet smoke; denied paths and migration; compare effective manifest with source; retain rollback.
- **accept:** real Mac process and mobile readback, actual Temper authorization/denial for current read-only capability, explicit scope not broadened; result/evidence recorded under Work. Formal adoption/promotion remains a distinct gate.

**No "phase done" by tool success alone.** Work packets have actionable success/denial tests; a blocker remains tracked with owner and recovery path. W1 may proceed without activating W2–W5; W5 cannot claim persisted machine authority until W2 verified.

## 9. Resource/efficiency guardrails and reassessment triggers

- **Expected incremental inference:** 0 additional LLM calls on ordinary requests; preserve judge-only-on-nomination. Do not make Temper health/metadata network calls on each normal chat message.
- Generator: deterministic at CI/build/startup only; no LLM tokens. Tardigrade continues ephemeral O(number of recent bounded messages).
- XState journal restore currently implies O(session event count) worst-case verification. Capture event counts, JSONL bytes, restore p50/p95, checkpoint size, request p50/p95 and provider/Temper call counts in real fixtures (short, medium, long session). Avoid inventing speed estimates.
- Proposed initial budget for ordinary non-trigger turn: no additional external calls and target <=25ms p95 host-side overhead above measured baseline on Mac at same journal size. Treat as **proposed acceptance target**, adjust on actual 100+ sample paired measurement; record failure instead of falsifying pass.
- Early reassessment if journal reads dominate latency, checkpoint grows without bound, migration needs destructive rewrite, a second authority is introduced, policy/effective-version readback cannot be independently verified, or any action path bypasses the gate.
- Do NOT add Postgres, Redis, external collector, new scheduler or a general policy language just to satisfy the spec. Only reconsider after recorded measurements or a functional blocker.

## 10. Governance, history, and explicit non-goals

- Before implementation Work is promoted, reconcile master #388 (open feedback Explore), #394 (closed for bounded P0/P2, NOT privileged writes), #359/#360 (control allocation), #76 (Case intake), existing DEEP_STATE_PLAN and historical retired/rejected attempts. Do not equate issue status to authoritative Plan/Work state.
- Master component-onboarding requires plan_ref, work_ref, history check, accepted adoption Decision/Gate if required, independently verified registration/deployment/routability. This spec/draft PR is **not** these records.
- A proposed policy revision goes through review -> source tests/negative proof -> approved authorization -> source commit -> deployment -> independent active readback. LLM-generated self-change stays only a proposal. Sessions keep pinned historical provenance while current Temper revocation remains binding.
- Explicitly excluded: autonomous policy approval, privileged Temper effects, universal sandbox/OS egress guarantee, remote GitHub Case filing, Temper policy/spec hot-deploy, human-approver UX without identity proof, rewriting agent core, adding unrelated platforms, and claiming all free-form language is deterministically provable.
- If any authorized Mac-control-plane workflow or bypass behaves incorrectly during a future rollout, record evidence and open an issue in toasterman234/github-workflows-control-plane. No Mac access is used in the authoring of this spec.

## 11. Anti-sprawl: one versioned Agent Assembly, dependency contracts and change impact

**Primary design decision for review:** An assembly of the **existing executable implementations** is the unit of ownership, activation, upgrade and testing. A component registry/catalog is a generated **projection** of this assembly, NOT another source of truth, database, management UI or framework. Keep everything in examples/adaptive-harness/app and reuse W0–W5. This deliberately supersedes the previous UI/catalog-first framing.

### 11.1 Connect components at one explicit composition root

Create one \`app/agent-assembly.ts\` (name provisional), with explicit code references to the existing system:

~~~ts
// TARGET SHAPE — conceptual, not currently implemented.
export const statelyAssembly = defineAgentAssembly({
  identity: statelyIdentity, // existing agent-config
  sessionMachine: conversationMachine, // the actual XState graph
  behaviorSelector: composeBehavior, // existing Tardigrade atoms
  feedbackGate: createGatedTurnHost, // existing host interception
  capabilityGateway: temperGateway, // existing host-controlled read-only Temper
  features: [conversationFeature, feedbackFeature, verificationFeature],
});
~~~

- **Explicit wiring**, not reflection or dynamic, model-authored imports. Only a reviewed source change changes installed features and/or XState graph.
- \`defineAgentAssembly\` is a tiny local TypeScript validation/composition helper, **not** a new agent runtime. The current server continues to run Luna, XState, Tardigrade, existing SessionStore and TemperGateway.
- Each feature is a **cohesive slice** that binds together its concrete code and metadata: behavior selector ID, legal machine states/events, host guard/validator, prompt or skill instructions, optional external capability requirements and proof tests. A feature may use existing shared components rather than duplicating them.
- Important limitation: XState does **not** magically install new state nodes from an arbitrary manifest. A new state/transition is an explicit code update to conversation.machine.ts, with version/migration as necessary. Assembly validation checks that feature references and machine declarations agree.
- Co-locate feature descriptors with their real implementations or a small adjacent feature descriptor. Only independently configured, enforceable, exposed or reusable mechanisms receive catalog identities; do not register every helper function.
- Treat provider, owner and responsibility as **single-writer** for authoritative state: XState/host = local session; Temper = governed external authorization/action entities; Tardigrade = recomputable selection; SessionStore = one append-only local record. No duplicated policy decision or independent mutable state.

### 11.2 Typed provides/requires/connects edges

Each feature declares a stable ID, version, provided interfaces/capabilities, required interfaces/capabilities, bound entrypoints and tests. Narrow link types include \`provides\`, \`requires\`, \`selects\`, \`guards\`, \`transitioned_by\`, \`invokes\`, \`authorized_by\`, \`verified_by\`, \`supersedes\`. These refer to **actual typed implementations**, not only prose strings. An external Temper policy/capability reference is **descriptive/required authority**; only live Temper authorizes its requests.

~~~ts
// TARGET SHAPE — choose exact TypeScript types from real exported code.
const verificationFeature = defineFeature({
  id: "behavior.verification",
  revision: 1,
  provides: ["behavior:verification"],
  requires: [
    "xstate:event:SELECT_BEHAVIOR",
    "host:feedback-preflight",
    "host:evidence-validator", // required for STRUCTURED verified terminal state
  ],
  binds: {
    selector: "verification",  // must match an actual BehaviorId
    state: "verifying",        // must match an actual machine state IF introduced
    guard: "hasVerifiedEvidence",
  },
  tests: ["reject-unverified-completion", "allow-validated-evidence"],
});
~~~

A descriptor is an index and validation contract; **not** the execution logic. To avoid string-only false assurance, tests must prove the host actually invokes the bound guard, rejects an illegal transition and cannot bypass it via another route.

**Assembly invariants (CI + startup):**
- each provided interface has one registered owner unless explicitly declared multi-provider with deterministic resolution; no duplicate logical IDs or aliases;
- every required local interface exists, its schema/version is compatible, and its real host/XState hook is wired; no prohibited cycles or unresolved/rejected/retired dependencies;
- a missing policy guard, validator or required capability **disables/denies the dependent operation**, not just removes a UI badge; normal unrelated chat stays available;
- policy constraints and human approval cannot be overridden by behavior choice or skill text;
- an installed skill can REQUEST an allowlisted capability, never grant it; an installed behavior cannot directly authorize a Temper action;
- no new model-facing tool becomes available solely because its name appears in the graph;
- incompatible machine/event changes require declared migration or prevented activation for existing sessions.

**Priority:** mandatory host/XState gates and Temper authorization > validated behavior choice > optional skill/prompt guidance. A lower layer cannot override the upper layer. Competing selector nominations use an explicit deterministic precedence/fallback, not "last registered wins."

### 11.3 Build-time output: one bundle fingerprint; no second hand-maintained catalog

Source modules and their actual code-bound descriptors -> resolve/validate assembly graph -> emit an immutable \`agent-assembly.manifest.json\` and deterministic \`POLICY.md\` / \`BEHAVIOR.md\` / test-impact projection. All are generated read models, not independent authored sources.

The effective local bundle records: \`assemblyVersion\` (canonical content hash of source declarations/dependency resolution), \`gitSha\`, \`machineVersion\`, \`behaviorVersion\`, \`localPolicyVersion\`, \`promptSkillHash\`, enabled features, dependencies, required tests and optional migrations. Session events pin the historical source/bundle versions; retries/replay reuse the original accepted selection. Live Temper revocation/current policy always wins over old session pins.

Runtime reads the compiled/validated assembly. On startup, refuse a broken/inconsistent assembly for trusted boundaries. An unavailable Temper service marks its guarded capabilities unavailable/denied without unnecessarily breaking unrelated conversational chat. The source manifest does NOT assert a remote Cedar policy version without independent readback.

**Generated catalog** can be searched or inspected as files/API if needed, but a management UI is expressly **not a prerequisite** for building this system.

### 11.4 Change transaction: always compute impact before accepting the diff

Treat one scoped reviewed PR/Work as a **change transaction** affecting any number of related components, not one GitHub issue or PR per component.

1. **Locate/reuse:** search by existing stable ID, provided interface, related prior failure/eval and aliases/superseded/rejected components; modify rather than duplicate where appropriate. Semantic "same idea" is review-assisted, NOT guaranteed by static analysis.
2. **Declare delta:** new/modify/retire, affected features and provides/requires/bindings, accepted dependencies, changed scope/permissions, old/new interface versions and rollout expectations. No implicit privilege expansion.
3. **Compute transitive reverse dependencies:** derive affected behavior selectors, state machine guards/events, skills, policies, tool call sites, migrations, prompt/docs projections and regression suites. Generate a human-readable \`assembly-impact.md\` in CI/PR artifacts; no new tracking issue required.
4. **Classify compatibility**: (a) docs/prompt-only, (b) behavior routing, (c) transition/event/snapshot breaking, (d) governed capability/authorization, (e) external outcome/verification. Apply appropriate tests/gates for the highest-impact class.
5. **Update implementations and links together**: one reviewed source change touching needed files. Enforce that dependencies and tests exist; CI refuses broken bindings, undocumented permissions, stale generated files and missing migrations. Full negative suites for trusted boundaries.
6. **Activate separately** under existing Work/approval if needed: build, backup, pin/restart only approved service, replay legacy sessions in copies, independently verify running bundle and Temper effective eligibility.
7. **Preserve history/supersede**: keep stable component identity for compatible edits; new ID plus replacement/ref when semantics fundamentally change; retained historical sessions replay under old versions/migration; retirement only after dependents migrated/disabled and route revoked.

**Concrete delta examples:**
- **Add a prompt skill:** define skill and descriptor, declare behavior/context constraints, ensure /skill allowlist; generator updates docs; skill never creates a tool grant.
- **Add a behavior:** implement/extend Tardigrade classification and typed BehaviorId, bind legal XState selection/procedure, attach tests; if machine topology changes bump \`machineVersion\` and migrate persisted sessions.
- **Modify policy:** host guard or externally approved Temper policy changes at respective enforcement owner; update affected descriptors and deny/bypass tests; policy prose is generated after code change. No TS metadata can override Cedar.
- **Add a capability:** actual host adapter + exact schema, fixed scope/tenant, auth boundary, constrained caller binding, negative tests and Temper policy evidence; if not separately approved, descriptor remains candidate/disabled.
- **Retire a component:** dependency search and reconciliation; block removal while active dependents or historical sessions require it; explicit replacements/migrations preserve events, tests and receipts.

### 11.5 Runtime flow and composition verification

The execution order remains:
\`authenticated input -> journal/state restore -> mandatory host preflight -> Tardigrade proposes behavior -> XState accepts legal event/behavior -> host executes eligible step -> Temper authorizes any governed external operation -> native independent readback -> recorded outcome/next legal state\`.

This is a **logical contract**; code may evaluate preflight/selector in another deterministic order only if no model or effect can escape required gates and the observable sequence is recorded. Tardigrade is never authorization, and verification cannot be inferred from a selector.

CI must exercise actual assembled execution, not only graph parsing. Boundary assertions include: a blocked feedback turn never invokes Luna; rejected XState event never opens an effect; no bypass routes; forged Temper identity/tenant denied; unavailable provider leaves guarded operation blocked; no self-promoted policy/skill; no false structured "verified" terminal state without trusted evidence.

### 11.6 Additional validation cases (add to existing T01–T20)

| ID | Scenario | Required result |
|---|---|---|
| T21 | Duplicate logical ID or ambiguous single-provider interface | Assembly validation rejects |
| T22 | Feature requires nonexistent guard/state/event/validator/test interface | Compile/startup gate rejects, cannot mark enforced |
| T23 | Change to a shared policy/guard | Impact diff includes all transitive dependents and their affected tests |
| T24 | Retire a still-invoked capability | Activation blocked until dependents migrate/route revoked |
| T25 | Prohibited circular feature requirements | Graph resolution rejects with dependency path |
| T26 | Change behavior code but leave generated assembly/Markdown stale | Deterministic CI drift check rejects |
| T27 | Git bundle differs from live Mac process and pinned session | Runtime readback distinguishes versions; no invented active status |
| T28 | Temper policy/credential changes independently or remote verification unavailable | Guarded capability reauthorizes/denies using current Temper, not historical local permit; status unknown if unreadable |
| T29 | Change duplicates rejected or superseded capability/behavior | History/alias check reports candidate conflict; review requires explicit disposition |
| T30 | Skill tries to invoke disabled/ungranted capability by adding text to its prompt | Host has no callable route or gate denies; no authority escalation |
| T31 | Incompatible machine event schema introduced with blocked old session | CI demands tested migration; old session must resume legally or fail closed without fabricated completion |
| T32 | Feature deletion while historical journal references its version | Preserve versioned replay/migration or block removal; no corrupted/forgotten session |

Efficiency: one deterministic assembly resolution at build/startup, lightweight static dependency map for impact analysis, **zero additional model calls and no per-turn Temper discovery calls**. Compare CI resolution, normal turn overhead and session replay with realistic fixture sizes. No new persistence system, graph database or central microservice unless measured need.

### 11.7 Modify existing work packages, not ownership structure

- **W0:** inventory *feature bundles* and transitive dependencies, duplicate/conflict/supersession history; don't add separate catalog project.
- **W1:** **agent-assembly.ts + typed provides/requires + graph validation + generated manifest/docs + impact diff**. This replaces a separately maintained "control registry" plus "component catalog".
- **W2:** wire restored XState states/events and migrations into the same assembly; journal effective version provenance.
- **W3:** make existing behavior selectors/procedures and verifiers satisfy their declared guard contracts; restrict effect routing through host/Temper.
- **W4:** implement authenticated effective assembly/version readback. A management UI is optional and explicitly lower priority than reliable wiring/impact validation.
- **W5:** verify installed bundle, source/runtime match, old-session compatibility, external Temper denial/readback, rollback and governed deployment authority.

**Anti-sprawl completion invariant:** there is ONE explicit assembled definition of which components operate together; every externally meaningful interface has one provider, dependencies/tests resolve, changes produce a transitive impact report, incomplete/breaking changes are blocked before activation, and effective versions are evidence-backed. Human documentation and any future visual interface are projections of this assembly, not another editable authority.

## 12. Acceptance checklist for the completed feature (NOT current status)

- [ ] Full source-control coverage: every current POLICY/BEHAVIOR clause and behavior has a stable ID, primary owner, enforcement strength, effective status, test refs and source evidence.
- [ ] All blocking controls are wired on trusted egress/transition paths and have denied + bypass regression tests.
- [ ] Generated source Markdown is reproducible and fails CI on drift; advisory/unavailable controls are not mislabeled.
- [ ] XState durable snapshot + journal replay, interrupted-call recovery and legacy migration independently pass on both new and pre-upgrade sessions.
- [ ] Temper credentials, tenant, Cedar/spec policy, health and provenance are distinguished; effective remote status is evidence-backed or unknown.
- [ ] Verification claim is scoped to structured workflow results; invalid/missing evidence cannot produce a verified terminal state.
- [ ] Mobile view reports effective code/config/machine/behavior/policy versions, live vs source drift, permitted next actions, and honest unavailable statuses.
- [ ] No new model calls for ordinary chat; latency/token/journal measurements compared to baseline and recorded.
- [ ] Existing chat, feedback dismissal, auth/origin, private Tailscale and pending-only Case flows regressions pass.
- [ ] Scoped Work, Decision/Gate, rollout permission, exact CI/build/readback receipts, independent Mac/Temper/native evidence and rollback are recorded **before any Done/live claim**.

**Status at authoring:** spec only. No code implementation, test run, privilege change, Mac mutation, Cedar deploy, live activation or formal promotion is claimed.
