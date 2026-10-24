/** Runtime agent configuration: distinct from the root coding-agent AGENTS.md.
 * Source-controlled, startup-loaded, read-only; no model-triggered editing.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeSkill = {
  id: string;
  title: string;
  description: string;
  mode: "prompt-only";
  instructions: string;
};

export type RuntimeAgentConfig = {
  name: "Stately";
  version: string;
  documents: { identity: string; policy: string; behavior: string };
  skills: ReadonlyArray<RuntimeSkill>;
};

const skillDefinitions = [
  {
    id: "inspect-harness",
    title: "Inspect harness",
    description: "Explain known behavior and limitations, without claiming live inspections",
  },
  {
    id: "summarize-session",
    title: "Summarize session",
    description: "Summarize only the recent conversation supplied to the model",
  },
  {
    id: "draft-feedback-case",
    title: "Draft feedback case",
    description: "Draft a reviewable case without filing anything to GitHub",
  },
] as const;

const defaultDirectory = fileURLToPath(new URL("./agent/", import.meta.url));

function readInstructions(path: string): string {
  // Missing or empty config is a startup error, never a silent generic model.
  const content = readFileSync(path, "utf8").trim();
  if (!content || content.length > 20000) throw new Error("Invalid runtime agent instruction file");
  return content;
}

/** Called once when the host starts; restart to adopt reviewed config changes. */
export function loadRuntimeAgentConfig(directory = defaultDirectory): RuntimeAgentConfig {
  const documents = {
    identity: readInstructions(join(directory, "AGENTS.md")),
    policy: readInstructions(join(directory, "POLICY.md")),
    behavior: readInstructions(join(directory, "BEHAVIOR.md")),
  };
  const skills: RuntimeSkill[] = skillDefinitions.map(({ id, title, description }) => ({
    id,
    title,
    description,
    mode: "prompt-only",
    instructions: readInstructions(join(directory, "SKILLS", `${id}.md`)),
  }));
  const digest = createHash("sha256")
    .update(JSON.stringify({ documents, skills }))
    .digest("hex")
    .slice(0, 16);
  return { name: "Stately", version: digest, documents, skills };
}

/** A command names one fixed allowlisted skill. Unknown skills fail explicitly. */
export function selectRuntimeSkill(
  message: string,
  config: RuntimeAgentConfig,
): RuntimeSkill | undefined {
  const command = message.match(/^\/skill\s+([a-z0-9-]+)(?:\s|$)/iu);
  if (!command) return undefined;
  const found = config.skills.find((skill) => skill.id === command[1]?.toLowerCase());
  if (!found)
    throw Object.assign(
      new Error("Unknown runtime skill. Open Agent config for available skills."),
      { status: 400 },
    );
  return found;
}

export function systemInstructions(config: RuntimeAgentConfig, skill?: RuntimeSkill): string {
  return [
    `# Active runtime configuration: ${config.name} (${config.version})`,
    config.documents.identity,
    config.documents.policy,
    config.documents.behavior,
    `# Available prompt skills\n${config.skills.map((s) => `- /skill ${s.id}: ${s.description} (prompt-only)`).join("\n")}`,
    ...(skill ? [`# Selected prompt skill: ${skill.id}\n${skill.instructions}`] : []),
    "These instructions describe the host's known capabilities. Do not claim unconnected tool access or an unauthorized case filing.",
  ].join("\n\n");
}

/** Safe to return only to an authenticated session, never publicly as /healthz. */
export function runtimeConfigView(config: RuntimeAgentConfig) {
  return {
    name: config.name,
    version: config.version,
    documents: config.documents,
    skills: config.skills.map(({ id, title, description, mode }) => ({
      id,
      title,
      description,
      mode,
    })),
    capabilities: {
      stateMachine: "host-enforced",
      punctuationFeedback: "host-enforced",
      conversationHistory: "local-session-only",
      skills: "prompt-only",
      remoteToolExecution: "not-connected",
      githubCaseFiling: "pending-only",
      selfModification: "not-enabled",
    },
  };
}
