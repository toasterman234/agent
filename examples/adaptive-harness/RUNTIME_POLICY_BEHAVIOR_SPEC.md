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

## 11. Anti-sprawl: one component catalog, not another runtime

**Decision for review:** Extend the existing W0/W1 implementation with one Stately **Component Catalog**. The catalog is an indexed, typed projection of the **actual** Stately declarations and external authoritative metadata, not a fourth execution engine, a competing canonical store or a general-purpose ontology platform. This is essential for managing a growing collection of policy/behavior/skills/capabilities and must not become a separate new project.

### 11.1 Object model and ownership

A catalog entry is one logical component with immutable stable ID across revisions, current source reference, owner, lifecycle, interface, dependencies and tests. Component **kinds** are a controlled discriminator, not different incompatible schema/store subsystems:
- policy, rule, constraint, behavior, state_machine, state, transition, prompt, skill, capability, tool, integration, context_source, memory_binding, evaluation, verifier, documentation_view (add another kind only with explicit need);
- components may be granular, but not every ordinary TypeScript function becomes a component. Create entries for independently governed, configured, exposed, tested or reused things. Private implementation helpers remain code.
- relationships use a small vocabulary: \`depends_on\`, \`invokes\`, \`governed_by\`, \`implemented_by\`, \`enforced_at\`, \`tested_by\`, \`verified_by\`, \`produces\`, \`replaces\`, \`conflicts_with\`. Every target ID resolves within the catalog or to a documented typed external \`temper://\`, canonical ref or issue/PR/source evidence URI.
- **stable identity != revision**: an ID is never reused for a different concept. Record replacement/supersession with a link, and preserve retired history. A content/commit SHA identifies immutable revisions; the current pointer is explicit.
- A component can provide several capabilities; one capability can be consumed by several behaviors. Avoid cloning a policy for each caller.

Suggested co-located descriptor contract (illustrative, not runtime grant):

~~~ts
type ComponentKind =
  | "policy" | "rule" | "behavior" | "state_machine" | "skill"
  | "capability" | "tool" | "integration" | "verifier" | "evaluation"
  | "prompt" | "context_source" | "memory_binding";
type ComponentRelationship = {
  kind: "depends_on" | "invokes" | "governed_by" | "implemented_by"
      | "enforced_at" | "tested_by" | "verified_by" | "replaces" | "conflicts_with";
  target: string;
};
type ComponentDescriptor = {
  id: string; kind: ComponentKind; title: string;
  description: string;
  source: { path: string; exportName?: string };
  owner: "stately-host" | "xstate" | "tardigrade" | "temper" | "prompt";
  implementationRef?: string;  // real exported guard/transition/tool binding
  relations: ComponentRelationship[];
  lifecycle: "candidate" | "approved" | "retired";
  tests: string[]; evidenceRefs: string[];
  externalAuthorityRef?: string; // never interpreted as a local permit
};
~~~

The authoritative **definitions** remain in the code and external deployed Temper; the catalog doesn't reimplement guards. Keep descriptors co-located with their real implementation module, export registered descriptors through one explicit \`app/components/index.ts\` build manifest (avoid magic filesystem scanning with side effects). A simple build step resolves and validates references and emits a deterministic \`component-catalog.json\` *read model*. For external Temper entries, store binding IDs and verified observed metadata separately, never invented local policy bodies.

### 11.2 Strict separation of four different kinds of status

Do not compress these into a single "active" or "done":
1. **Lifecycle**: candidate/reviewed/accepted/retired/superseded, with explicit Decision/Gate/Work refs where authoritative.
2. **Source implementation**: absent/defined/wired/source-tested; tests have actual receipts or say unverified.
3. **Effective runtime**: unavailable/loaded/observed/independently verified, with process/start time, code+config hashes, freshness.
4. **Governed external state**: Temper policy/credential/spec and authoritative action state, sourced from authenticated readback or unknown.

An approved candidate isn't automatically deployed; a deployed component isn't automatically routable; documentation isn't permission. A component detail page must always show the distinctions and date of last observed evidence.

### 11.3 Anti-sprawl controls on every component addition/change

The write path for a component change is:
**find** existing ID/aliases/semantic equivalent and historical retired/rejected/superseded work -> **inspect** dependents, owners, permissions and policies -> **propose** edit or new component + expected user-visible behavior -> **compute impact** (dependents, callers, affected machines/events, tests, state migrations, Temper grants, docs) -> **review/gate** under existing lifecycle -> **implement** co-located code+descriptor+tests -> **validate** graph and enforcement -> **generate** catalog and docs -> **deploy separately** when authorized -> **read back** effective runtime -> **retire/supersede** stale components explicitly.

No automatic new GitHub issue, PR, directory, Plan, schema, policy engine, database or Temper object on every small change. Related additions are packaged in the **existing scoped Work/PR**, with refs linking to the same owner. A change request can touch several components without creating a new project.

At minimum CI rejects:
- duplicate logical IDs/aliases, unknown kinds, missing required identity/source or unresolved dependency target;
- dangling relations, self-dependency and forbidden dependency cycles, missing supersession target, retired capabilities still routed;
- exposed capability without a real host allowlist/auth/Temper boundary or without expected deny/bypass test references;
- a claim that a rule is blocking/enforced when interception and negative evidence are absent;
- missing or stale generated Markdown/catalog, conflicting source/effective version assertions, accidental new route bypass of the feedback gate;
- removed or renamed component with downstream references and no documented migration/supersession.
CI can enforce *presence/wiring plus test results*, not independently prove a deployed Temper policy or human approval. Implement validator cases and use actual tested runtime receipts for high-risk claims.

### 11.4 One API and one compact management surface

Reuse the **existing authenticated Stately Config/Skills mobile panel**, not a new dashboard/server:
- **Inventory**: filterable/searchable list of components by kind, owner, lifecycle, effective status and gaps.
- **Detail**: current declaration, docs, tests/evidence, policy/behavior version, related upstream/downstream components, source link and last effective observation.
- **Impact**: show "uses", "used by", and affected tests/guards/migrations before a proposed edit; surface conflicts/duplicates/retired identities.
- **Changes**: show proposed vs reviewed vs source-implemented vs deployed/verified separately, and GitHub Work/PR/Decision links. UI may start read-only; any future mutation must follow approved Stately/Temper path.
- **Live**: process code/config/machine/behavior, current session state, installed capabilities, connected Temper metadata (fresh or unknown), source/runtime drift.
Keep graph optional (the typed edges make a later graph view possible without another graph DB). Prioritize compact filterable tables, expandable rows and mobile readability.

Expose one redacted catalog endpoint such as \`GET /api/sessions/:id/components\`, plus component-detail/impact lookup as filters on the same handler if needed, authenticated with the existing session boundary. Reuse the spec's effective-contract API rather than create overlapping separate version/status endpoints. No arbitrary client-provided code or metadata-controlled execution.

### 11.5 Testing the anti-sprawl system

Add these cases to the existing 20-test plan; they are *specified, not run*:

| ID | Input / mutation attempt | Expected proof |
|---|---|---|
| T21 | Register duplicate ID/alias or component that repeats an existing logical capability | validation fails or review flags semantic duplicate; no silent second authority |
| T22 | Reference nonexistent guard, behavior, policy, skill, test or parent component | catalog validation fails with source location |
| T23 | Rename/remove component used by another behavior or state | impact shows all dependents; fails without migration or supersession |
| T24 | Retire a capability that is still exposed through a tool route | blocking test/validator fails, no live permission implied |
| T25 | Two components reference a prohibited dependency cycle | deterministic graph validation fails |
| T26 | Edit behavior/policy source without regenerating catalog/docs | CI drift check fails |
| T27 | Repository shows newest component revision but Mac runs older effective SHA | inventory shows source/runtime divergence; no "active" claim |
| T28 | External Temper policy/spec changes or metadata becomes unavailable | catalog keeps external authority, changes effective status to stale/unknown; no mirrored permit |
| T29 | Proposed behavior improvement repeats rejected/superseded prior component | lifecycle review shows prior identity, rationale, relevant evidence, and supersession before any activation |

**Efficiency:** catalog generation and graph validation run deterministically in CI/build or on approved activation, not every message; no added model inference, no per-turn remote scans. Serve a cached immutable source graph + separately timed, redacted runtime observation; invalidate only on code/contract version change and bounded refresh of external status. Measure build and UI query latency on growing fixture catalogs (at least 50, 500 and 5,000 entries); do not add a database until measured limitations justify it.

### 11.6 Merge into the EXISTING work packages

- **W0:** add component-source census, duplicate/supersession review and dependency/owner index to current control inventory.
- **W1:** implement the co-located component descriptors, explicit catalog assembly, deterministic validated JSON/docs and CI drift/relationship checks **together with** the original control registries. This is one implementation, not two registries.
- **W2/W3:** register actual machine/guard/behavior/verification bindings as they are implemented, then enforce through the existing trusted host and XState paths.
- **W4:** extend the existing effective-contract mobile/API screen for inventory/detail/impact/status, not a competing UI.
- **W5:** activation receipts compare catalog source hash, effective process version, independent Temper authority and observed denials/readbacks; migrate/retire replaced components with preserved lineage.

**Anti-sprawl acceptance:** each exposed component has exactly one stable logical ID, one accountable implementation owner, resolved typed links, a reviewed history, a single effective-status view, evidence classification and a discoverable detail page. Any missing item is explicitly a gap, not a silent pass. The catalog is an index and management projection, not an invented source of policy authority.

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
