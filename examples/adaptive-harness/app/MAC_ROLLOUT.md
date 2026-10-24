# Mac rollout runbook — Stately/Tardigrade behavior bridge

**Status:** ready for an authorized Mac operator; **not executed from this ChatGPT session**. As of 2026-10-24, connected Desktop Commander lists all Mac devices offline. Executor discovery did not reveal an authorized Mac shell; do not infer access via the private Tailscale URL.

**Source to deploy:** CI-verified `a50393f06e9f669fa5825a24500535a413c9308d` from branch `work/388-feedback-trigger-scaffold`, draft [PR #1](https://github.com/toasterman234/agent/pull/1). [CI run #40068259735](https://github.com/toasterman234/agent/actions/runs/40068259735) passed frozen install, lint, format, knip, 1,656 main tests and all typechecks. Later documentation-only commits need separate readback if deploying the branch tip instead. Do **not** merge or deploy `DEEP_STATE_PLAN.md` as if it were implemented.

**Last documented installation:** Mac LaunchAgent `com.bencharney.stately-adaptive-harness`, loopback chat `127.0.0.1:8787`, model proxy `127.0.0.1:8317/v1`, private Tailscale Serve `https://bens-mac-mini.taila1553c.ts.net:8787/`. Last documented live code revision `731a648a6dc5198e330914388d2b30d292ef5cfe`; the currently running revision is **unknown until a live Mac check**. No case-filing permission or automatic issue creation is authorized.

## Mac operator: read-only preflight

1. Confirm you're **on the Mac**, not a GitHub runner, VPS or Cloudflare Worker. Confirm `launchctl list | grep com.bencharney.stately-adaptive-harness`, `lsof -nP -iTCP:8787 -sTCP:LISTEN`, `curl -fsS --max-time 5 http://127.0.0.1:8787/healthz` and `tailscale serve status`. Report sanitized health only—do not log API keys or raw environment variables.
2. Discover the active LaunchAgent checkout/working directory and runtime config by examining the **ProgramArguments and WorkingDirectory fields only** of the existing plist and the running process's invocation. Do **not** print the entire plist if it contains environment credentials. Confirm `git -C <CHECKOUT> rev-parse HEAD`, branch, `git status --short`, and `git log -1 --oneline`. Check whether a local agent is already changing the worktree.
3. Compare current service source hash, runtime prompt/config hash, Tailscale binding, session count and data directory (default `~/.local/share/stately-adaptive-harness`). Validate free disk space. Do not change the Serve mapping, proxy listener or secrets.

## Safe activation within the existing installation

4. If the worktree is dirty, current revision diverges, package manager differs or the service is owned by another active worker, **stop** and reconcile; don't reset, clean, force checkout or kill processes. Capture pre-deploy commit for rollback. Verify intended `a50393f...` exists on origin and matches this PR.
5. Protect the existing data and runtime config with an appropriately restricted _local_ backup and verify its checksums. Do not copy local credentials into the repository or logs. Existing JSONL messages and feedback must remain readable after the upgrade.
6. Prepare exact `a50393f...` in a separate checkout or a clean, verified fast-forward of the actual installation. Use the checked-in package manager/lockfile with `pnpm install --frozen-lockfile`; avoid global package manager changes. On the Mac, run `pnpm exec vitest run examples/adaptive-harness/app/tests/behavior-composer.test.ts examples/adaptive-harness/app/tests/behavior-integration.test.ts`, `pnpm run typecheck:examples`, and a bounded local health check. Preserve CLIProxyAPI secrets via the existing Mac-only runtime configuration.
7. When no other worker owns the service and the actual installed code matches the intended commit, use the existing LaunchAgent's restart mechanism to replace **only that service** (typically `launchctl kickstart -k gui/$(id -u)/com.bencharney.stately-adaptive-harness`, after verifying the exact label and target user). Do **not** change LaunchAgent plist, proxy service, GitHub credentials, macOS login items or Tailscale Serve.
8. Independently read back `/healthz` (HTTP 200, model `gpt-5.6-luna`, pending-only case policy). From an authenticated new chat session, test a normal message establishing a goal, then `continue`; fetch the authenticated `/api/sessions/<id>/behavior` and check `intent=continue`, `behaviorId=continue-work`, prior goal preserved. Confirm mobile activity displays the behavior label. Verify a resumed/repeated message ID does not call Luna twice and the existing `???` feedback gate still blocks or dismisses correctly.
9. Test from an iPhone signed in to the tailnet using the **existing** HTTPS page. Verify previous session data is intact and new state is available without any public Funnel route. Confirm `127.0.0.1:8317` remains loopback-only. Record sanitized actual tests, deployment SHA, backup path (without secrets), liveness, and rollback commit in [PR #1](https://github.com/toasterman234/agent/pull/1) and [master #388](https://github.com/toasterman234/master-repo-0.1/issues/388).

## Failure and rollback

On install/test/health failure, do not advertise it as live. Restore the prior known-good checkout and existing LaunchAgent startup target, restart only this service, read back its original `/healthz` and chat sessions, and retain the backup. Do **not** restore/overwrite the data directory blindly if new client writes may have occurred; reconcile journal additions and schema compatibility first. Never mark the deployment complete without verification from the actual Mac and tailnet session.

**Important:** The `a50393f` bridge only durably persists the **behavior selection** and the existing session log. Full persisted XState actor snapshots, crash-safe machine restore and migration are **not** in that commit; see [`DEEP_STATE_PLAN.md`](../DEEP_STATE_PLAN.md) for the separately specified implementation.

## If the Mac cannot be reached

Keep PR #1 draft; leave the running Mac unchanged. Ask an authorized Mac coding agent to execute this exact runbook instead of creating a duplicate plan, project or cloud deployment. When Desktop Commander is reconnected, rerun the read-only preflight before any write.
