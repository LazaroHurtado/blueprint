import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { newNode, newWorkflow, parseWorkflow, serializeDraft } from "./workflow.ts";
import { exportWorkflow } from "./export.ts";
import { createEditorState, editorReducer } from "./editor-state.ts";

let native = true;
let response: unknown;
const calls: { command: string; args: unknown }[] = [];
mock.module("@tauri-apps/api/core", { namedExports: {
  isTauri: () => native,
  invoke: async (command: string, args: unknown) => {
    calls.push({ command, args });
    if (response instanceof Error) throw response;
    return response;
  },
} });
const { applyAgentProfile, discoverAgents, matchesAgentProfile } = await import("./agents.ts");

const profile = {
  id: "project:review.agent.md", source: "project" as const, fileName: "review.agent.md",
  name: "Code review", description: "Review code", prompt: "Report actionable defects.",
  model: "unknown-model", tools: ["read", "example/search"],
  mcpServers: { example: {
    type: "local" as const, command: "example-server", args: [], tools: ["search"],
    env: { TOKEN: "${TOKEN}" },
  } },
  warnings: [],
};

test("discovery is a typed, scoped native call with distinct project/personal entries and explicit errors", async () => {
  response = { profiles: [profile, { ...profile, id: "personal:review.agent.md", source: "personal" }], issues: ["project/broken.md: Invalid YAML"] };
  const catalogue = await discoverAgents("/picked/project");
  assert.deepEqual(calls.at(-1), { command: "discover_agents", args: { root: "/picked/project" } });
  assert.equal(catalogue.profiles.length, 2);
  assert.notEqual(catalogue.profiles[0].id, catalogue.profiles[1].id);
  assert.deepEqual(catalogue.issues, ["project/broken.md: Invalid YAML"]);
  await discoverAgents("");
  assert.deepEqual(calls.at(-1)?.args, { root: null });
  response = { profiles: [profile, { ...profile, mcpServers: { unsafe: { type: "local", command: "example", env: { TOKEN: "not-a-reference" } } } }], issues: [] };
  const rejected = await discoverAgents("/picked/project");
  assert.equal(rejected.profiles.length, 1);
  assert.equal(rejected.issues.length, 1);
  response = {};
  await assert.rejects(discoverAgents(""), /unexpected response/);
  response = new Error("Cannot read profiles");
  await assert.rejects(discoverAgents(""), /Cannot read profiles/);
  native = false;
  const count = calls.length;
  try {
    await assert.rejects(discoverAgents(""), /desktop app/);
    assert.equal(calls.length, count);
  } finally { native = true; }
});

test("approved profile copies preserve identity, task, output, position, connections and unknown model IDs", () => {
  const agent = newNode("agent", { x: 12, y: 34 });
  assert.ok(agent.type === "agent");
  agent.name = "Original";
  agent.prompt = "Original prompt";
  agent.task = "Keep this task.";
  agent.output = "json";
  agent.fields = [{ name: "passed", type: "boolean" }];
  const before = structuredClone(agent);
  assert.equal(matchesAgentProfile(agent, profile), false);
  const current = { ...agent, task: "Task changed while confirmation was open." };
  const imported = applyAgentProfile(current, agent, profile, []);
  assert.deepEqual(agent, before);
  assert.equal(imported.name, profile.name);
  assert.equal(imported.model, "unknown-model");
  assert.equal(imported.prompt, profile.prompt);
  assert.equal(imported.id, agent.id);
  assert.deepEqual(imported.position, agent.position);
  assert.equal(imported.task, current.task);
  assert.equal(imported.output, "json");
  assert.deepEqual(imported.fields, agent.fields);
  assert.equal(matchesAgentProfile(imported, profile), true);
  assert.equal(matchesAgentProfile({ ...imported, prompt: "Manual edit" }, profile), false);
  imported.tools.push("edit");
  imported.mcpServers.example.tools.push("other");
  assert.deepEqual(profile.tools, ["read", "example/search"]);
  assert.deepEqual(profile.mcpServers.example.tools, ["search"]);
  assert.throws(() => applyAgentProfile({ ...agent, prompt: "Concurrent edit" }, agent, profile, []), /settings changed/);
  assert.throws(() => applyAgentProfile({ ...agent, id: "another" }, agent, profile, []), /settings changed/);
  const workflow = newWorkflow();
  const downstream = newNode("agent", { x: 300, y: 34 });
  assert.ok(downstream.type === "agent");
  downstream.prompt = "Summarize the upstream review.";
  workflow.graph.nodes.push(agent, downstream);
  workflow.graph.edges.push({ id: "review-summary", source: agent.id, target: downstream.id });
  const state = editorReducer(createEditorState(), { type: "open", workflow });
  const updated = editorReducer(state, { type: "graph", path: [], change: (graph) => ({
    ...graph, nodes: graph.nodes.map((node) => node.id === agent.id ? applyAgentProfile(agent, agent, profile, []) : node),
  }) });
  assert.ok(updated.workflow);
  assert.deepEqual(updated.workflow.graph.edges, workflow.graph.edges);
  assert.equal(updated.workflow.graph.nodes[1], downstream);
  assert.notEqual(serializeDraft(updated.workflow), updated.saved);
  assert.deepEqual(state.workflow, workflow);
  const draft = serializeDraft(updated.workflow);
  assert.deepEqual(parseWorkflow(draft), updated.workflow);
  assert.ok(!draft.includes(profile.fileName) && !draft.includes(profile.id));
  const exportFiles = exportWorkflow(updated.workflow);
  const exported = exportFiles.find((file) => file.path.endsWith(".agent.md"));
  assert.ok(exported?.content.includes("unknown-model"));
  assert.ok(exported?.content.includes(profile.prompt));
});

test("profile model import follows existing reasoning-effort compatibility rules", () => {
  const agent = newNode("agent", { x: 0, y: 0 });
  assert.ok(agent.type === "agent");
  agent.model = "old-model";
  agent.reasoningEffort = "low";
  const unknown = applyAgentProfile(agent, agent, profile, []);
  assert.equal(unknown.reasoningEffort, "low");
  const incompatible = applyAgentProfile(agent, agent, profile, [{
    id: "unknown-model", name: "Known now", selectable: true, policy: null, notices: [], supportedReasoningEfforts: ["high"],
  }]);
  assert.equal(incompatible.reasoningEffort, undefined);
  const defaults = applyAgentProfile(agent, agent, { ...profile, model: null, tools: [], mcpServers: {} }, []);
  assert.equal(defaults.model, undefined);
  assert.equal(defaults.reasoningEffort, undefined);
  assert.deepEqual(defaults.tools, []);
  assert.deepEqual(defaults.mcpServers, {});
});
