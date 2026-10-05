import assert from "node:assert/strict";
import { test } from "node:test";
import { createEditorState, editorReducer } from "./editor-state.ts";
import { exportWorkflow } from "./export.ts";
import { newNode, newWorkflow, parseWorkflow, serializeDraft, validateWorkflow } from "./workflow.ts";

test("drafts preserve incomplete graphs, names, prompts, positions, and nested models", () => {
  const workflow = newWorkflow();
  workflow.name = "";
  const loop = newNode("loop", { x: 200, y: 70 });
  const agent = newNode("agent", { x: 10, y: 20 });
  assert.ok(loop.type === "loop" && agent.type === "agent");
  agent.model = "my-model";
  loop.maxIterations = -1;
  loop.body.nodes.push(agent);
  workflow.graph.nodes.push(loop, newNode("decision", { x: 100, y: 300 }));
  const text = serializeDraft(workflow);
  assert.equal(JSON.parse(text).format, "blueprint-draft");
  assert.deepEqual(parseWorkflow(text), workflow);
  assert.ok(validateWorkflow(parseWorkflow(text)).length > 0);
  assert.throws(() => exportWorkflow(parseWorkflow(text)), /name|prompt|iteration/);
});

test("an unfinished numeric condition remains distinct from an intentional null", () => {
  const workflow = newWorkflow();
  const decision = newNode("decision", { x: 0, y: 0 });
  assert.ok(decision.type === "decision");
  decision.condition.value = Number.NaN;
  workflow.graph.nodes.push(decision);
  const draft = serializeDraft(workflow);
  const restored = parseWorkflow(draft);
  const node = restored.graph.nodes[0];
  assert.ok(node.type === "decision");
  assert.ok(Number.isNaN(node.condition.value));
  assert.ok(validateWorkflow(restored).some((error) => error.includes("finite number")));
  const state = editorReducer(createEditorState(), { type: "open", workflow: restored });
  assert.equal(state.saved, serializeDraft(restored));
  node.condition.value = null;
  assert.notEqual(state.saved, serializeDraft(restored));
});

test("exported documents remain compatible and valid drafts can become runnable exports", () => {
  const workflow = newWorkflow();
  const agent = newNode("agent", { x: 0, y: 0 });
  assert.ok(agent.type === "agent");
  agent.prompt = "Review the input.";
  workflow.graph.nodes.push(agent);
  assert.deepEqual(parseWorkflow(JSON.stringify(workflow)), workflow);
  const files = exportWorkflow(parseWorkflow(serializeDraft(workflow)));
  assert.equal(files.length, 4);
  const document = JSON.parse(files.find((file) => file.path.endsWith("/blueprint.json"))!.content);
  assert.equal(document.version, 1);
  assert.equal(Object.hasOwn(document, "format"), false);
});

test("malformed draft metadata and unsupported versions fail explicitly", () => {
  const workflow = newWorkflow();
  workflow.graph.nodes.push(newNode("agent", { x: 0, y: 0 }));
  const data = JSON.parse(serializeDraft(workflow));
  data.unfinishedConditions = [workflow.graph.nodes[0].id];
  assert.throws(() => parseWorkflow(JSON.stringify(data)), /metadata/);
  data.version = 99;
  assert.throws(() => parseWorkflow(JSON.stringify(data)), /version/);
});
