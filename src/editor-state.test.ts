import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { adoptUserNodes, calculateNodePosition, type NodeLookup, type ParentLookup } from "@xyflow/system";
import { ReactFlow, type InternalNode, type NodeProps } from "@xyflow/react";
import { createEditorState, editorReducer, getCanvasNodes } from "./editor-state.ts";
import type { CanvasNode } from "./Nodes.tsx";
import { graphAt, newNode, newWorkflow, parseWorkflow, serializeDraft } from "./workflow.ts";

test("a newly created agent remains rendered and visible during and after dragging", () => {
  let state = editorReducer(createEditorState(), { type: "open", workflow: newWorkflow() });
  const agent = newNode("agent", { x: 50, y: 50 });
  state = editorReducer(state, {
    type: "graph", path: [],
    change: (graph) => ({ ...graph, nodes: [...graph.nodes, agent] }),
  });
  state = editorReducer(state, {
    type: "dimensions", path: [],
    nodes: [{ type: "dimensions", id: agent.id, dimensions: { width: 190, height: 90 } }],
  });
  const nodeTypes = {
    workflow: ({ data }: NodeProps<CanvasNode>) => createElement("div", null, data.node.name),
  };
  function renderNode(nodes = getCanvasNodes(state, () => {})) {
    const html = renderToStaticMarkup(createElement(ReactFlow<CanvasNode>, {
      nodes, edges: [], nodeTypes, width: 1000, height: 800,
    }));
    const wrapper = html.match(/<div[^>]*data-testid="rf__node-[^"]*"[^>]*>/g);
    assert.equal(wrapper?.length, 1);
    assert.ok(wrapper![0].includes(`data-id="${agent.id}"`));
    return wrapper![0];
  }
  function assertVisible() {
    const wrapper = renderNode();
    assert.match(wrapper, /visibility:visible/);
    assert.doesNotMatch(wrapper, /visibility:hidden/);
    const position = state.workflow!.graph.nodes[0].position;
    assert.ok(wrapper.includes(`transform:translate(${position.x}px,${position.y}px)`));
    assert.equal(state.workflow!.graph.nodes.length, 1);
  }

  // Losing measurements makes React Flow hide the node even though it still exists.
  assert.match(renderNode(getCanvasNodes(state, () => {}).map((node) => ({
    ...node, measured: undefined,
  }))), /visibility:hidden/);
  assertVisible();
  state = editorReducer(state, {
    type: "selection", path: [],
    nodes: [{ type: "select", id: agent.id, selected: true }],
  });
  assertVisible();
  for (const position of [{ x: 80, y: 70 }, { x: 120, y: 100 }, { x: 160, y: 130 }]) {
    state = editorReducer(state, {
      type: "graph", path: [],
      change: (graph) => ({ ...graph, nodes: graph.nodes.map((node) => ({ ...node, position })) }),
    });
    assertVisible();
  }
  // Mouse release also recreates the controlled node without changing its position.
  state = editorReducer(state, { type: "graph", path: [], change: (graph) => ({ ...graph }) });
  assertVisible();
  assert.deepEqual(parseWorkflow(serializeDraft(state.workflow!)).graph.nodes[0].position, { x: 160, y: 130 });
});

test("controlled nodes retain initialization through selection, dragging, and reopening a draft", () => {
  const workflow = newWorkflow();
  const agent = newNode("agent", { x: 50, y: 50 });
  workflow.graph.nodes.push(agent);
  let state = editorReducer(createEditorState(), { type: "open", workflow });
  const nodeLookup: NodeLookup<InternalNode<CanvasNode>> = new Map();
  const parentLookup: ParentLookup<InternalNode<CanvasNode>> = new Map();
  const editBody = () => {};
  const dimensions = { width: 190, height: 90 };
  const position = { x: 120, y: 160 };
  const errors: string[] = [];

  function drag() {
    adoptUserNodes(getCanvasNodes(state, editBody), nodeLookup, parentLookup);
    return calculateNodePosition({
      nodeId: agent.id, nextPosition: position, nodeLookup,
      onError: (code) => errors.push(code),
    });
  }

  // Exercise React Flow's actual error path, not just a measurement-field assertion.
  drag();
  assert.deepEqual(errors, ["015"]);
  errors.length = 0;
  for (let opened = 0; opened < 2; opened++) {
    const beforeMeasurement = state;
    state = editorReducer(state, {
      type: "dimensions", path: [],
      nodes: [{ type: "dimensions", id: agent.id, dimensions }],
    });
    assert.equal(beforeMeasurement.nodeMeasurements.size, 0);
    assert.equal(state.workflow, beforeMeasurement.workflow);
    assert.equal(serializeDraft(state.workflow!), state.saved);
    adoptUserNodes(getCanvasNodes(state, editBody), nodeLookup, parentLookup);

    state = editorReducer(state, {
      type: "selection", path: [],
      nodes: [{ type: "select", id: agent.id, selected: true }],
    });
    assert.deepEqual(drag().position, position);
    assert.deepEqual(errors, []);

    state = editorReducer(state, {
      type: "graph", path: [],
      change: (graph) => ({
        ...graph, nodes: graph.nodes.map((node) => ({ ...node, position })),
      }),
    });
    assert.deepEqual(drag().position, position);
    assert.deepEqual(errors, []);
    const draft = serializeDraft(state.workflow!);
    if (opened === 0) assert.notEqual(draft, state.saved);
    assert.equal(draft.includes("measured"), false);
    assert.equal(draft.includes("nodeMeasurements"), false);
    state = editorReducer(state, { type: "saved", snapshot: draft });
    state = editorReducer(state, { type: "open", workflow: parseWorkflow(draft) });
    assert.deepEqual(state.workflow?.graph.nodes[0].position, position);
    assert.equal(state.nodeMeasurements.size, 0);
    assert.equal(serializeDraft(state.workflow!), state.saved);
  }
});

test("canvas measurements are refreshed, removed, and scoped to the current graph", () => {
  const workflow = newWorkflow();
  const loop = newNode("loop", { x: 0, y: 0 });
  workflow.graph.nodes.push(loop);
  let state = editorReducer(createEditorState(), { type: "open", workflow });
  const measure = {
    type: "dimensions" as const, path: [],
    nodes: [{ type: "dimensions" as const, id: loop.id, dimensions: { width: 264, height: 320 } }],
  };
  state = editorReducer(state, measure);
  const beforeResize = state;
  state = editorReducer(state, {
    ...measure, nodes: [{ ...measure.nodes[0], dimensions: { width: 264, height: 400 } }],
  });
  assert.deepEqual(beforeResize.nodeMeasurements.get(loop.id), { width: 264, height: 320 });
  assert.deepEqual(getCanvasNodes(state, () => {})[0].measured, { width: 264, height: 400 });
  state = editorReducer(state, { type: "navigate", path: [loop.id] });
  assert.equal(state.nodeMeasurements.size, 0);
  assert.equal(editorReducer(state, measure), state);
  state = editorReducer(state, { type: "navigate", path: [] });
  assert.equal(state.nodeMeasurements.size, 0);
  state = editorReducer(state, measure);
  state = editorReducer(state, {
    type: "graph", path: [], change: () => ({ nodes: [], edges: [] }),
  });
  assert.equal(state.nodeMeasurements.size, 0);
  state = editorReducer(state, measure);
  assert.equal(state.nodeMeasurements.size, 0);
  state = editorReducer(state, { type: "home" });
  assert.equal(state.nodeMeasurements.size, 0);
});

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
