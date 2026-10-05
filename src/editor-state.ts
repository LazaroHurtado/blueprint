import type { EdgeChange, NodeChange } from "@xyflow/react";
import { graphAt, serializeDraft, updateGraph, type Graph, type Workflow } from "./workflow.ts";

export type EditorState = {
  workflow: Workflow | null;
  path: string[];
  selected: string | null;
  selectedNodes: Set<string>;
  selectedEdges: Set<string>;
  saved: string;
};

export type EditorAction =
  | { type: "open"; workflow: Workflow }
  | { type: "home" }
  | { type: "select"; id: string | null }
  | { type: "navigate"; path: string[] }
  | { type: "graph"; path: string[]; change: (graph: Graph) => Graph }
  | { type: "selection"; path: string[]; nodes?: NodeChange[]; edges?: EdgeChange[] }
  | { type: "name"; name: string }
  | { type: "saved"; snapshot: string };

export function createEditorState(): EditorState {
  return {
    workflow: null,
    path: [],
    selected: null,
    selectedNodes: new Set(),
    selectedEdges: new Set(),
    saved: "",
  };
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
  for (const id of selectedNodes) {
    if (!graph.nodes.some((node) => node.id === id)) selectedNodes.delete(id);
  }
  for (const id of selectedEdges) {
    if (!graph.edges.some((edge) => edge.id === id)) selectedEdges.delete(id);
  }
  return {
    ...state, workflow, selectedNodes, selectedEdges,
    selected: selectedNodes.has(state.selected || "") ? state.selected : null,
  };
}
