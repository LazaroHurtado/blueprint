import assert from "node:assert/strict";
import { test } from "node:test";
import { createEditorState, editorReducer } from "./editor-state.ts";
import { graphAt, newNode, newWorkflow, serializeDraft } from "./workflow.ts";

test("editor selection and nested editing preserve model settings and the saved snapshot", () => {
  const workflow = newWorkflow();
  const loop = newNode("loop", { x: 0, y: 0 });
  const agent = newNode("agent", { x: 50, y: 50 });
  assert.ok(loop.type === "loop" && agent.type === "agent");
  loop.body.nodes.push({ ...agent, model: "chosen-model" });
  workflow.graph.nodes.push(loop);

  let state = editorReducer(createEditorState(), { type: "open", workflow });
  const snapshot = state.saved;
  state = editorReducer(state, { type: "navigate", path: [loop.id] });
  state = editorReducer(state, { type: "select", id: agent.id });
  const before = state;
  state = editorReducer(state, {
    type: "graph", path: [loop.id],
    change: (graph) => ({ ...graph, nodes: graph.nodes.map((node) => ({ ...node, name: "Reviewer" })) }),
  });
  assert.ok(state.workflow);
  const updated = graphAt(state.workflow, [loop.id]).nodes[0];
  assert.ok(updated.type === "agent");
  assert.equal(updated.model, "chosen-model");
  assert.equal(updated.name, "Reviewer");
  assert.equal(graphAt(before.workflow!, [loop.id]).nodes[0].name, "Agent");
  assert.equal(state.saved, snapshot);
  assert.notEqual(serializeDraft(state.workflow), state.saved);

  const selectionBefore = state.selectedNodes;
  state = editorReducer(state, { type: "select", id: null });
  assert.equal(state.selected, null);
  assert.equal(state.selectedNodes.size, 0);
  assert.deepEqual([...selectionBefore], [agent.id]);
  state = editorReducer(state, { type: "saved", snapshot: serializeDraft(state.workflow!) });
  assert.equal(state.saved, serializeDraft(state.workflow!));
});

test("edge selection and node deletion do not leave stale selection behind", () => {
  const workflow = newWorkflow();
  const first = newNode("agent", { x: 0, y: 0 });
  const second = newNode("agent", { x: 300, y: 0 });
  workflow.graph = {
    nodes: [first, second],
    edges: [{ id: "edge", source: first.id, target: second.id }],
  };
  let state = editorReducer(createEditorState(), { type: "open", workflow });
  state = editorReducer(state, { type: "select", id: first.id });
  state = editorReducer(state, {
    type: "selection", path: [],
    nodes: [{ type: "select", id: first.id, selected: false }],
    edges: [{ type: "select", id: "edge", selected: true }],
  });
  assert.equal(state.selectedNodes.size, 0);
  assert.equal(state.selected, null);
  assert.deepEqual([...state.selectedEdges], ["edge"]);
  state = editorReducer(state, {
    type: "graph", path: [],
    change: (graph) => ({ ...graph, edges: [] }),
  });
  assert.equal(state.workflow?.graph.nodes.length, 2);
  assert.equal(state.selectedEdges.size, 0);
  state = editorReducer(state, { type: "select", id: second.id });
  state = editorReducer(state, {
    type: "graph", path: [],
    change: (graph) => ({ ...graph, nodes: [first] }),
  });
  assert.equal(state.selected, null);
  assert.equal(state.selectedNodes.size, 0);
});

test("late canvas events cannot modify a different loop or reset its selection", () => {
  const workflow = newWorkflow();
  const loop = newNode("loop", { x: 0, y: 0 });
  workflow.graph.nodes.push(loop);
  let state = editorReducer(createEditorState(), { type: "open", workflow });
  state = editorReducer(state, { type: "navigate", path: [loop.id] });
  assert.equal(editorReducer(state, {
    type: "selection", path: [], nodes: [{ type: "select", id: loop.id, selected: true }],
  }), state);
  assert.equal(editorReducer(state, {
    type: "graph", path: [], change: () => ({ nodes: [], edges: [] }),
  }), state);
});
