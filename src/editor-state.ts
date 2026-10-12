import type { EdgeChange, NodeChange } from "@xyflow/react";
import type { CanvasNode } from "./Nodes.tsx";
import { graphAt, serializeDraft, updateGraph, type Graph, type Workflow } from "./workflow.ts";

export type EditorState = {
  workflow: Workflow | null;
  path: string[];
  selected: string | null;
  selectedNodes: Set<string>;
  selectedEdges: Set<string>;
  nodeMeasurements: Map<string, NonNullable<CanvasNode["measured"]>>;
  saved: string;
};

export type EditorAction =
  | { type: "open"; workflow: Workflow }
  | { type: "home" }
  | { type: "select"; id: string | null }
  | { type: "navigate"; path: string[] }
  | { type: "graph"; path: string[]; change: (graph: Graph) => Graph }
  | { type: "selection"; path: string[]; nodes?: NodeChange[]; edges?: EdgeChange[] }
  | { type: "dimensions"; path: string[]; nodes: NodeChange<CanvasNode>[] }
  | { type: "name"; name: string }
  | { type: "saved"; snapshot: string };

export function createEditorState(): EditorState {
  return {
    workflow: null,
    path: [],
    selected: null,
    selectedNodes: new Set(),
    selectedEdges: new Set(),
    nodeMeasurements: new Map(),
    saved: "",
  };
}

export function getCanvasNodes(state: EditorState, editBody: (id: string) => void): CanvasNode[] {
  const graph = state.workflow ? graphAt(state.workflow, state.path) : null;
  return graph?.nodes.map((node) => ({
    id: node.id, type: "workflow", position: node.position, data: { node, editBody },
    measured: state.nodeMeasurements.get(node.id),
    selected: state.selectedNodes.has(node.id), ariaLabel: `${node.type}: ${node.name || "Unnamed"}`,
  })) || [];
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "open":
      return { ...createEditorState(), workflow: action.workflow, saved: serializeDraft(action.workflow) };
    case "home":
      return createEditorState();
    case "select":
      return {
        ...state,
        selected: action.id,
        selectedNodes: new Set(action.id ? [action.id] : []),
        selectedEdges: new Set(),
      };
    case "navigate":
      return {
        ...state, path: action.path, selected: null,
        selectedNodes: new Set(), selectedEdges: new Set(),
        nodeMeasurements: new Map(),
      };
    case "saved":
      return { ...state, saved: action.snapshot };
    case "name":
      return state.workflow
        ? { ...state, workflow: { ...state.workflow, name: action.name } }
        : state;
  }

  // React Flow may deliver changes from a canvas that was just unmounted.
  if (action.path.join("/") !== state.path.join("/")) return state;
  if (action.type === "dimensions") {
    if (!state.workflow) return state;
    const graph = graphAt(state.workflow, state.path);
    const nodeMeasurements = new Map(state.nodeMeasurements);
    for (const change of action.nodes) {
      if (change.type === "dimensions" && change.dimensions && graph.nodes.some((node) => node.id === change.id)) {
        nodeMeasurements.set(change.id, { ...change.dimensions });
      }
    }
    return { ...state, nodeMeasurements };
  }
  const selectedNodes = new Set(state.selectedNodes);
  const selectedEdges = new Set(state.selectedEdges);

  if (action.type === "selection") {
    for (const change of action.nodes || []) {
      if (change.type === "select" && change.selected) selectedNodes.add(change.id);
      else if (change.type === "select" || change.type === "remove") selectedNodes.delete(change.id);
    }
    for (const change of action.edges || []) {
      if (change.type === "select" && change.selected) selectedEdges.add(change.id);
      else if (change.type === "select" || change.type === "remove") selectedEdges.delete(change.id);
    }
    const selected = selectedNodes.has(state.selected || "")
      ? state.selected
      : [...selectedNodes].at(-1) || null;
    return { ...state, selectedNodes, selectedEdges, selected };
  }

  if (!state.workflow) return state;
  const workflow = updateGraph(state.workflow, action.path, action.change);
  const graph = graphAt(workflow, state.path);
  const nodeMeasurements = new Map(state.nodeMeasurements);
  for (const id of nodeMeasurements.keys()) {
    if (!graph.nodes.some((node) => node.id === id)) nodeMeasurements.delete(id);
  }
  for (const id of selectedNodes) {
    if (!graph.nodes.some((node) => node.id === id)) selectedNodes.delete(id);
  }
  for (const id of selectedEdges) {
    if (!graph.edges.some((edge) => edge.id === id)) selectedEdges.delete(id);
  }
  return {
    ...state, workflow, selectedNodes, selectedEdges, nodeMeasurements,
    selected: selectedNodes.has(state.selected || "") ? state.selected : null,
  };
}
