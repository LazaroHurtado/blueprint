import { invoke, isTauri } from "@tauri-apps/api/core";
import { z } from "zod";
import type { AgentNode } from "./workflow.ts";

const authSchema = z.object({
  connected: z.boolean(), login: z.string().nullable(), host: z.string().nullable(),
});
const modelSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1), selectable: z.boolean(),
  policy: z.string().nullable(), notices: z.array(z.string()),
});
const promptSchema = z.string().trim().min(1, "The generated prompt cannot be empty.").max(30_000);
const draftSchema = z.object({ prompt: promptSchema, warning: z.string().nullable() });

export type CopilotStatus = z.infer<typeof authSchema>;
export type CopilotModel = z.infer<typeof modelSchema>;
export type PromptDraft = z.infer<typeof draftSchema>;

export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function call<T>(command: string, schema: z.ZodType<T>, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Copilot connection requires the Blueprint desktop app. You can still edit and open workflows in this browser preview.");
  const result = schema.safeParse(await invoke(command, args));
  if (!result.success) throw new Error("Copilot returned an unexpected response. Restart the connection and try again.");
  return result.data;
}

export const getCopilotStatus = (restart = false) => call("copilot_status", authSchema, { restart });
export const getCopilotModels = () => call("copilot_models", z.array(modelSchema));
export const loginCopilot = (requestId: string) => call("copilot_login", authSchema.nullable(), { requestId });
export const disconnectCopilot = () => call("copilot_disconnect", authSchema);
export const cancelCopilot = (requestId: string) => call("copilot_cancel", z.null(), { requestId });
export const reopenCopilotBrowser = (requestId: string) => call("copilot_reopen_browser", z.null(), { requestId });

export function promptRequest(agent: AgentNode, description: string) {
  if (!description.trim() || description.length > 10_000) throw new Error("Describe the agent in 1 to 10000 characters.");
  return {
    description: description.trim(), name: agent.name,
    tools: [...agent.tools], output: agent.output,
    fields: agent.output === "json" ? agent.fields.map((field) => ({ ...field })) : [],
  };
}

export function generatePrompt(requestId: string, agent: AgentNode, description: string) {
  return call("copilot_generate", draftSchema.nullable(), { requestId, input: promptRequest(agent, description) });
}

export function applyGeneratedPrompt(current: AgentNode, original: AgentNode, prompt: string): AgentNode {
  if (current.id !== original.id || current.prompt !== original.prompt) {
    throw new Error("This agent's system prompt changed while the draft was open. Copy your draft before closing and generating again.");
  }
  return { ...current, prompt: promptSchema.parse(prompt) };
}
