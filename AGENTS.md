# Coding-agent entrypoint — Stately fork

This fork retains upstream Stately Agent examples and runtime. Do **not** start a new architectural exploration or rewrite the package.

## Current authorized work

The active deliverable is the **standalone adaptive harness** tracked in [draft PR #1](https://github.com/toasterman234/agent/pull/1), branch `work/388-feedback-trigger-scaffold`.

**Start with [examples/adaptive-harness/AGENTS.md](examples/adaptive-harness/AGENTS.md).** It provides the precise coding, validation, proxy and delivery instructions. Then read [the implementation plan](examples/adaptive-harness/IMPLEMENTATION_PLAN.md) and the existing [feedback-trigger README](examples/adaptive-harness/feedback-trigger/README.md).

**Do not create another PR or alternate agent framework.** Work on the existing branch; preserve the existing Stately core (`src/`) and upstream examples unless there is a demonstrated defect and a separately reviewed change. No Letta, Pi, Muse or Cloudflare as the runtime.

The owner selected the existing Mac CLIProxyAPI with model `gpt-5.6-luna`, and a Mac-local single-process Stately host reached privately from phone/desktop. No cloud-provider credentials should be requested for that choice. Model compatibility and proxy health require live verification, not assumptions.

**Permission boundaries:** Editing the fork's candidate branch is authorized. Do not deploy, merge, create production GitHub cases, change Mac service/launchd configuration, change Tailscale Serve or Funnel, expose the proxy externally, or access/print secrets without respecting the dedicated gates in the scoped instructions. Source completion is not a live deployment.

Report exact commands/tests, source SHA, remaining blockers, and a working local URL only after direct readback. Keep every significant update in draft PR #1 and link [master-repo issue #388](https://github.com/toasterman234/master-repo-0.1/issues/388).
