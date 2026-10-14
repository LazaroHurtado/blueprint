import { invoke, isTauri } from "@tauri-apps/api/core";
import { z } from "zod";
import { setAgentModel, type CopilotModel } from "./copilot.ts";
import { mcpSchema, type AgentNode } from "./workflow.ts";

const profileSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["project", "personal"]),
  fileName: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  description: z.string().min(1).max(2_000),
  prompt: z.string().min(1).max(30_000),
  model: z.string().trim().min(1).max(200).nullable(),
  tools: z.array(z.string()),
  mcpServers: mcpSchema,
  warnings: z.array(z.string()),
});
const catalogueSchema = z.object({ profiles: z.array(z.unknown()), issues: z.array(z.string()) });
export type AgentProfile = z.infer<typeof profileSchema>;
export type AgentCatalogue = { profiles: AgentProfile[]; issues: string[] };

export async function discoverAgents(folder: string): Promise<AgentCatalogue> {
  if (!isTauri()) throw new Error("Agent discovery requires the desktop app. Custom agents remain available in this preview.");
  const result = catalogueSchema.safeParse(await invoke("discover_agents", { root: folder || null }));
  if (!result.success) throw new Error("Agent discovery returned an unexpected response. Retry loading profiles.");
  const profiles: AgentProfile[] = [];
  const issues = [...result.data.issues];
  for (const value of result.data.profiles) {
    const profile = profileSchema.safeParse(value);
    if (profile.success) profiles.push(profile.data);
    else {
      const identity = profileSchema.pick({ source: true, fileName: true }).safeParse(value);
      const name = identity.success ? `${identity.data.source}/${identity.data.fileName}` : "An agent profile";
      issues.push(`${name}: unsupported settings; this profile was not loaded.`);
    }
  }
  return { profiles, issues };
}

function settings(agent: Pick<AgentNode, "name" | "prompt" | "model" | "tools" | "mcpServers">) {
  return JSON.stringify([agent.name, agent.prompt, agent.model || null, agent.tools, agent.mcpServers]);
}

export function matchesAgentProfile(agent: AgentNode, profile: AgentProfile): boolean {
  return settings(agent) === settings({ ...profile, model: profile.model ?? undefined });
}

export function applyAgentProfile(current: AgentNode, original: AgentNode, profile: AgentProfile, models: CopilotModel[]): AgentNode {
  if (current.id !== original.id || settings(current) !== settings(original) || current.reasoningEffort !== original.reasoningEffort) {
    throw new Error("This agent's settings changed while the profile was open. Select the profile again before replacing them.");
  }
  const { agent } = setAgentModel(current, profile.model ?? undefined, models, profile.model === null);
  return {
    ...agent, name: profile.name, prompt: profile.prompt,
    tools: [...profile.tools], mcpServers: structuredClone(profile.mcpServers),
  };
}
