import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { newNode } from "./workflow.ts";

let native = true;
let response: unknown;
const calls: { command: string; arguments: unknown }[] = [];
mock.module("@tauri-apps/api/core", { namedExports: {
  isTauri: () => native,
  invoke: async (command: string, args: unknown) => {
    calls.push({ command, arguments: args });
    if (response instanceof Error) throw response;
    return response;
  },
} });
const {
  applyGeneratedPrompt, cancelCopilot, disconnectCopilot, generatePrompt,
  getCopilotModels, getCopilotStatus, loginCopilot, promptRequest, reopenCopilotBrowser,
} = await import("./copilot.ts");

function agent() {
  const node = newNode("agent", { x: 0, y: 0 });
  assert.ok(node.type === "agent");
  return {
    ...node, prompt: "Keep this existing prompt.", task: "Private task input", model: "saved-model",
    tools: ["read", "private/search"],
    mcpServers: { private: { type: "local" as const, command: "private-command", args: [], env: { TOKEN: "${PRIVATE_TOKEN}" }, tools: ["search"] } },
  };
}

test("Copilot auth stays in native commands and browser preview makes no native calls", async () => {
  response = { connected: true, login: "example", host: "https://github.com" };
  assert.deepEqual(await getCopilotStatus(), response);
  assert.deepEqual(await loginCopilot("login-one"), response);
  assert.deepEqual(calls.at(-1), { command: "copilot_login", arguments: { requestId: "login-one" } });
  response = { connected: false, login: null, host: null };
  assert.deepEqual(await disconnectCopilot(), response);
  native = false;
  const count = calls.length;
  await assert.rejects(getCopilotStatus(), /desktop app/);
  await assert.rejects(loginCopilot("login-two"), /desktop app/);
  assert.equal(calls.length, count);
  native = true;
});

test("model catalog retains policy explanations and does not invent or replace IDs", async () => {
  const selected = agent();
  response = [{ id: "other-model", name: "Other model", selectable: false, policy: "Disabled by your organization", notices: ["A service notice"] }];
  assert.deepEqual(await getCopilotModels(), response);
  assert.equal(selected.model, "saved-model");
  response = [{ id: "", name: "Invalid" }];
  await assert.rejects(getCopilotModels(), /unexpected response/);
  response = new Error("Check your Copilot entitlement");
  await assert.rejects(getCopilotModels(), /entitlement/);
});

test("prompt drafting sends only description and minimal agent settings, not MCP configuration or existing content", async () => {
  const selected = agent();
  const before = structuredClone(selected);
  const request = promptRequest(selected, "  Review changes.  ");
  assert.deepEqual(Object.keys(request).sort(), ["description", "fields", "name", "output", "tools"]);
  assert.equal(request.description, "Review changes.");
  assert.deepEqual(request.tools, selected.tools);
  const serialized = JSON.stringify(request);
  for (const excluded of ["PRIVATE_TOKEN", "private-command", "Private task input", "Keep this existing prompt.", "saved-model"]) {
    assert.ok(!serialized.includes(excluded), excluded);
  }
  request.tools.push("edit");
  assert.deepEqual(selected, before);
  assert.throws(() => promptRequest(selected, " "), /Describe/);
  assert.throws(() => promptRequest(selected, "x".repeat(10_001)), /10000/);
});

test("JSON output contracts are copied into the drafting request", () => {
  const selected = { ...agent(), output: "json" as const, fields: [{ name: "needsChanges", type: "boolean" as const }] };
  const request = promptRequest(selected, "Review changes");
  request.fields[0].name = "changed";
  assert.equal(selected.fields[0].name, "needsChanges");
  assert.equal(request.output, "json");
});

test("a returned draft does not modify an agent until explicitly applied", async () => {
  const selected = agent();
  response = { prompt: "  A generated system prompt.  ", warning: null };
  const draft = await generatePrompt("generation-one", selected, "Review changes");
  assert.equal(draft?.prompt, "A generated system prompt.");
  assert.equal(selected.prompt, "Keep this existing prompt.");
  assert.deepEqual(calls.at(-1), {
    command: "copilot_generate",
    arguments: { requestId: "generation-one", input: promptRequest(selected, "Review changes") },
  });
  const changed = applyGeneratedPrompt({ ...selected, model: "new-model" }, selected, draft!.prompt);
  assert.deepEqual(changed, { ...selected, model: "new-model", prompt: draft!.prompt });
  assert.equal(selected.prompt, "Keep this existing prompt.");
  assert.throws(() => applyGeneratedPrompt({ ...selected, prompt: "Concurrent edit" }, selected, "Draft"), /changed/);
  assert.throws(() => applyGeneratedPrompt({ ...selected, id: "another-agent" }, selected, "Draft"), /changed/);
  assert.throws(() => applyGeneratedPrompt(selected, selected, " "), /empty/);
});

test("cancellation is distinct from failed or empty generation and uses the original request ID", async () => {
  response = null;
  assert.equal(await loginCopilot("cancel-login"), null);
  assert.equal(await generatePrompt("cancel-prompt", agent(), "Review changes"), null);
  await cancelCopilot("cancel-prompt");
  assert.deepEqual(calls.at(-1), { command: "copilot_cancel", arguments: { requestId: "cancel-prompt" } });
  await reopenCopilotBrowser("browser-one");
  assert.deepEqual(calls.at(-1), { command: "copilot_reopen_browser", arguments: { requestId: "browser-one" } });
  response = { prompt: "", warning: null };
  await assert.rejects(generatePrompt("empty-prompt", agent(), "Review changes"), /unexpected response/);
  response = new Error("Generation timed out");
  await assert.rejects(generatePrompt("failed-prompt", agent(), "Review changes"), /timed out/);
  const warning = "Temporary session cleanup failed; runtime stopped.";
  response = { prompt: "Draft retained", warning };
  assert.equal((await generatePrompt("warning-prompt", agent(), "Review changes"))?.warning, warning);
});
