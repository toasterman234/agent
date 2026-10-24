import OpenAI from "openai";
import { createOpenAiExecutors, type OpenAiGenerateResult } from "@statelyai/agent/openai";

export type ProviderMessage = { role: "system" | "user" | "assistant"; content: string };
export type ProviderUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };

export type ChatProvider = {
  readonly baseUrl: string;
  readonly model: string;
  readonly configured: boolean;
  generate(
    messages: ProviderMessage[],
    options?: { maxOutputTokens?: number },
  ): Promise<{ text: string; usage?: ProviderUsage; model: string }>;
};

export class ProxyProviderError extends Error {
  constructor(
    message: string,
    readonly code = "proxy-error",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProxyProviderError";
  }
}

export type ProxyProviderOptions = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  client?: OpenAI;
};

const trimBaseUrl = (value: string) => value.replace(/\/$/u, "");

export function createProxyProvider(options: ProxyProviderOptions = {}): ChatProvider {
  const baseUrl = trimBaseUrl(
    options.baseUrl ?? process.env.STATELY_PROXY_BASE_URL ?? "http://127.0.0.1:8317/v1",
  );
  const model = options.model ?? process.env.STATELY_PROXY_MODEL ?? "gpt-5.6-luna";
  const apiKey =
    options.apiKey ?? process.env.STATELY_PROXY_API_KEY ?? process.env.CLIPROXY_API_KEY;
  const client = options.client ?? (apiKey ? new OpenAI({ apiKey, baseURL: baseUrl }) : undefined);
  const configured = Boolean(client);

  return {
    baseUrl,
    model,
    configured,
    async generate(messages, generationOptions) {
      if (!client)
        throw new ProxyProviderError("CLIProxyAPI key is not configured", "missing-api-key");
      const executors = createOpenAiExecutors({ client, resolveModel: () => model });
      try {
        const result: OpenAiGenerateResult = await executors.generateText({
          model,
          messages,
          tools: {},
          maxOutputTokens: generationOptions?.maxOutputTokens ?? 512,
        });
        const text =
          typeof result.result === "string" ? result.result : JSON.stringify(result.result);
        if (!text?.trim())
          throw new ProxyProviderError("CLIProxyAPI returned an empty response", "empty-response");
        return { text, usage: result.usage, model };
      } catch (error) {
        if (error instanceof ProxyProviderError) throw error;
        const status =
          typeof error === "object" &&
          error &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : undefined;
        throw new ProxyProviderError("CLIProxyAPI request failed", "request-failed", status);
      }
    },
  };
}
