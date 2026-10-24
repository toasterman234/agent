import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type {
  FeedbackCaseSink,
  FeedbackVerdict,
  IncomingMessage,
} from "../feedback-trigger/host.js";
import type { FeedbackSignal } from "../feedback-trigger/detector.js";
import { CaseFilingUnavailableError } from "./case-adapter.js";

/**
 * #76 GitHub case sink (master-repo-0.1 #399). Replaces the pending-only
 * stub for the live host: a case-verdict feedback disposition becomes a
 * GitHub issue in the fixed case repository, deduped by the gate's
 * idempotency key at GitHub itself, and verified by an independent
 * readback GET — never by the write receipt alone.
 *
 * Credential (Ben's Option B, 2026-10-24): the same host token file Pi
 * uses. The token VALUE is resolved per call, used only in the
 * Authorization header of api.github.com requests, and never logged,
 * returned, or embedded in an error message.
 */

export const GITHUB_CASE_OWNER = "toasterman234";
export const GITHUB_CASE_REPO = "master-repo-0.1";
export const GITHUB_CASE_TARGET = `github:${GITHUB_CASE_OWNER}/${GITHUB_CASE_REPO}`;
export const GITHUB_CASE_LABEL = "stately-case";
export const DEFAULT_GITHUB_TOKEN_FILE =
  "/Users/bencharney/pi/agent-config/profiles/master-repo-v0.1/secrets.env";
const GITHUB_API_BASE = "https://api.github.com";
const MARKER_PREFIX = "stately-case-key:";

type FetchLike = typeof fetch;

export type GitHubCaseSinkOptions = {
  fetchImpl?: FetchLike;
  tokenFilePath?: string;
  owner?: string;
  repo?: string;
  apiBaseUrl?: string;
};

export class GitHubCaseError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubCaseError";
    this.status = status;
  }
}

const tokenFilePathOf = (optionPath?: string): string =>
  optionPath ?? process.env.STATELY_GITHUB_TOKEN_FILE ?? DEFAULT_GITHUB_TOKEN_FILE;

/** Parse `GITHUB_TOKEN=<value>` (optional `export`, optional quotes) out of an env file body. */
export function parseGitHubToken(contents: string): string | undefined {
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?GITHUB_TOKEN\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[1] ?? "").trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/** Non-throwing startup probe for healthz: does the configured token file resolve a token? */
export function githubCaseTokenResolvable(optionPath?: string): boolean {
  try {
    return parseGitHubToken(readFileSync(tokenFilePathOf(optionPath), "utf8")) !== undefined;
  } catch {
    return false;
  }
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

type IssueSummary = { number: number; body?: unknown };

export class GitHubCaseSink implements FeedbackCaseSink {
  private readonly fetchImpl: FetchLike;
  private readonly tokenFileOption?: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBaseUrl: string;

  constructor(options: GitHubCaseSinkOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenFileOption = options.tokenFilePath;
    this.owner = options.owner ?? GITHUB_CASE_OWNER;
    this.repo = options.repo ?? GITHUB_CASE_REPO;
    this.apiBaseUrl = options.apiBaseUrl ?? GITHUB_API_BASE;
  }

  get target(): string {
    return `github:${this.owner}/${this.repo}`;
  }

  private async resolveToken(): Promise<string> {
    let contents: string;
    try {
      contents = await readFile(tokenFilePathOf(this.tokenFileOption), "utf8");
    } catch {
      throw new CaseFilingUnavailableError();
    }
    const token = parseGitHubToken(contents);
    if (!token) throw new CaseFilingUnavailableError();
    return token;
  }

  private async request(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "stately-adaptive-harness",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private async errorFrom(response: Response, what: string): Promise<GitHubCaseError> {
    let detail = "";
    try {
      detail = truncate(await response.text(), 300);
    } catch {
      detail = "";
    }
    return new GitHubCaseError(
      `GitHub ${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }

  /** Scan issues (optionally label-filtered) for one carrying this idempotency key. */
  private async scanForKey(
    token: string,
    marker: string,
    labeled: boolean,
  ): Promise<number | undefined> {
    for (let page = 1; ; page += 1) {
      const params = new URLSearchParams({ state: "all", per_page: "100", page: String(page) });
      if (labeled) params.set("labels", GITHUB_CASE_LABEL);
      const response = await this.request(
        token,
        "GET",
        `/repos/${this.owner}/${this.repo}/issues?${params}`,
      );
      if (!response.ok) throw await this.errorFrom(response, "issue scan");
      const issues = (await response.json()) as IssueSummary[];
      if (!Array.isArray(issues))
        throw new GitHubCaseError("GitHub issue scan returned a non-list");
      for (const issue of issues) {
        if (typeof issue?.body === "string" && issue.body.includes(marker)) return issue.number;
      }
      if (issues.length < 100) return undefined;
    }
  }

  async fileOrLink(input: {
    idempotencyKey: string;
    message: IncomingMessage;
    signal: FeedbackSignal;
    verdict: Extract<FeedbackVerdict, { kind: "case" }>;
  }): Promise<{ ref: string }> {
    const token = await this.resolveToken();
    const marker = `<!-- ${MARKER_PREFIX}${input.idempotencyKey} -->`;
    // Dedupe at the case system: an earlier filing of this exact key links,
    // it never duplicates. Every issue this sink creates carries the label,
    // so a completed labeled scan is conclusive; only if GitHub rejects the
    // label query itself (404/422) do we rescan unfiltered.
    let existing: number | undefined;
    try {
      existing = await this.scanForKey(token, marker, true);
    } catch (error) {
      if (error instanceof GitHubCaseError && (error.status === 404 || error.status === 422)) {
        existing = await this.scanForKey(token, marker, false);
      } else throw error;
    }
    if (existing !== undefined) return { ref: `${this.target}#${existing}` };

    const { verdict, message, signal } = input;
    const title = truncate(
      `[Stately case] ${verdict.category}: ${truncate(verdict.reason.trim(), 80)}`,
      120,
    );
    const body = [
      verdict.reason,
      "",
      "## Source feedback",
      "",
      `> ${message.text}`,
      "",
      `- Signal: ${signal.kind}`,
      `- Session: ${message.sessionId}`,
      `- Message: ${message.messageId}`,
      `- Idempotency key: ${input.idempotencyKey}`,
      "",
      marker,
    ].join("\n");
    const response = await this.request(token, "POST", `/repos/${this.owner}/${this.repo}/issues`, {
      title,
      body,
      labels: [GITHUB_CASE_LABEL],
    });
    if (!response.ok) throw await this.errorFrom(response, "issue creation");
    const created = (await response.json()) as { number?: unknown };
    if (typeof created.number !== "number")
      throw new GitHubCaseError("GitHub issue creation returned no issue number");
    return { ref: `${this.target}#${created.number}` };
  }

  async verify(ref: string): Promise<boolean> {
    const match = /^github:([^/]+)\/([^#]+)#(\d+)$/.exec(ref.trim());
    if (!match) return false;
    const [, owner, repo, number] = match;
    if (owner !== this.owner || repo !== this.repo) return false;
    let token: string;
    try {
      token = await this.resolveToken();
    } catch {
      return false;
    }
    try {
      const response = await this.request(
        token,
        "GET",
        `/repos/${this.owner}/${this.repo}/issues/${number}`,
      );
      if (!response.ok) return false;
      const issue = (await response.json()) as IssueSummary;
      return typeof issue?.body === "string" && issue.body.includes(MARKER_PREFIX);
    } catch {
      return false;
    }
  }
}
