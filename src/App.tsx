import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Background, BackgroundVariant, Controls, MarkerType, ReactFlow, useReactFlow,
  type Connection, type Edge, type EdgeChange, type FitViewOptions, type NodeChange,
} from "@xyflow/react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEditorState, editorReducer } from "./editor-state.ts";
import { CopilotAccount, CopilotDialog, CustomModelDialog, PromptDialog, useCopilot } from "./Copilot.tsx";
import { applyGeneratedPrompt, message } from "./copilot.ts";
import { exportWorkflow } from "./export.ts";
import { chooseDraftFile, chooseFolder, openWorkflow, saveDraft, saveExport } from "./files.ts";
import { Inspector, ToolsEditor } from "./Inspector.tsx";
import { Icon, WorkflowCard, type CanvasNode } from "./Nodes.tsx";
import { Dialog, Field } from "./ui.tsx";
import {
  graphAt, newId, newNode, newWorkflow, orderedNodes, parseWorkflow, serializeDraft, slug, validateWorkflow,
  type AgentNode, type Graph, type WorkflowEdge, type WorkflowNode,
} from "./workflow.ts";
import "@xyflow/react/dist/style.css";
import "./App.css";

const nodeTypes = { workflow: WorkflowCard };
const fitViewOptions: FitViewOptions = {
  padding: { left: "296px", right: "48px", top: "116px", bottom: "48px" }, maxZoom: 1,
};
const palette = [
  { type: "agent", label: "Agent" }, { type: "connect", label: "Connect" },
  { type: "decision", label: "Decision" }, { type: "loop", label: "Loop" },
] as const;

export default function App({ startupNotice = "" }: { startupNotice?: string }) {
  const [state, dispatch] = useReducer(editorReducer, undefined, createEditorState);
  const copilot = useCopilot();
  const [tool, setTool] = useState<"select" | "connect">("select");
  const [dialog, setDialog] = useState<"save" | "tools" | "saved" | "connections" | "prompt" | "model" | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [agentTarget, setAgentTarget] = useState<{ workflowId: string; path: string[]; agent: AgentNode } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pending, setPending] = useState<"home" | "close">("home");
  const [folder, setFolder] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [saveMode, setSaveMode] = useState<"draft" | "export">("export");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(startupNotice);
  const [notice, setNotice] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [branch, setBranch] = useState<"true" | "false">("true");
  const canvas = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const workflowName = useRef<HTMLInputElement>(null);
  const flow = useReactFlow<CanvasNode>();
  const workflow = state.workflow;
  const graph = workflow ? graphAt(workflow, state.path) : null;
  const selected = state.selectedNodes.size === 1 ? graph?.nodes.find((node) => node.id === state.selected) : undefined;
  const errors = useMemo(() => workflow ? validateWorkflow(workflow) : [], [workflow]);
  const snapshot = useMemo(() => workflow ? serializeDraft(workflow) : "", [workflow]);
  const dirty = workflow !== null && snapshot !== state.saved;
  const modalDraft = dialog === "tools" || dialog === "prompt" || dialog === "model";
  const copilotPending = copilot.phase !== "idle";
  const editGraph = useCallback((change: (graph: Graph) => Graph) => dispatch({ type: "graph", path: state.path, change }), [state.path]);
  function changeNode(node: WorkflowNode) {
    editGraph((current) => ({ ...current, nodes: current.nodes.map((item) => item.id === node.id ? node : item) }));
  }
  function openCopilot() {
    setCopilotOpen(true);
    if (!copilot.status?.connected && !copilot.checking && copilot.phase === "idle") copilot.login();
  }
  function openAgentDialog(kind: "prompt" | "model") {
    if (!workflow || selected?.type !== "agent") { setError("Select an agent first."); return; }
    if (kind === "prompt" && !copilot.status?.connected) { openCopilot(); return; }
    setAgentTarget({ workflowId: workflow.id, path: [...state.path], agent: structuredClone(selected) });
    setDialog(kind);
  }
  function currentTarget(): AgentNode {
    if (!agentTarget || !workflow || workflow.id !== agentTarget.workflowId || state.path.join("/") !== agentTarget.path.join("/")) {
      throw new Error("The original workflow changed. Copy your draft before closing this dialog.");
    }
    const node = graph?.nodes.find((node) => node.id === agentTarget.agent.id);
    if (node?.type !== "agent") throw new Error("The original agent is no longer available. Copy your draft before closing this dialog.");
    return node;
  }
  function closeAgentDialog() { setDialog(null); setAgentTarget(null); }
  const editBody = useCallback((id: string) => {
    dispatch({ type: "navigate", path: [...state.path, id] });
    setTool("select");
    setError("");
  }, [state.path]);
  const canvasNodes = useMemo<CanvasNode[]>(() => graph?.nodes.map((node) => ({
    id: node.id, type: "workflow", position: node.position, data: { node, editBody },
    selected: state.selectedNodes.has(node.id), ariaLabel: `${node.type}: ${node.name || "Unnamed"}`,
  })) || [], [graph, state.selectedNodes, editBody]);
  const canvasEdges = useMemo<Edge[]>(() => graph?.edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target,
    selected: state.selectedEdges.has(edge.id),
    sourceHandle: edge.branch || "out", targetHandle: "in",
    type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "#969aa1" },
  })) || [], [graph, state.selectedEdges]);

  async function openDocument() {
    setError("");
    if (!isTauri()) { fileInput.current?.click(); return; }
    setBusy(true);
    try {
      const document = await openWorkflow();
      if (document) { dispatch({ type: "open", workflow: document }); setFolder(""); setDraftPath(""); setTool("select"); }
    } catch (problem) { setError(message(problem)); } finally { setBusy(false); }
  }
  function addNode(type: WorkflowNode["type"], position?: { x: number; y: number }) {
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds) return;
    const origin = flow.screenToFlowPosition({ x: bounds.left + 332, y: bounds.top + 160 });
    const columns = Math.max(1, Math.floor((bounds.width - 344) / (300 * flow.getViewport().zoom)));
    let point = position || origin;
    if (!position) {
      let slot = 0;
      do {
        point = { x: origin.x + (slot % columns) * 300, y: origin.y + Math.floor(slot / columns) * 360 };
        slot++;
      } while (graph?.nodes.some((node) => (
        point.x < node.position.x + (node.type === "loop" ? 264 : 190) + 24 &&
        point.x + (type === "loop" ? 264 : 190) + 24 > node.position.x &&
        point.y < node.position.y + (node.type === "loop" ? 320 : 90) + 24 &&
        point.y + (type === "loop" ? 320 : 90) + 24 > node.position.y
      )));
    }
    const node = newNode(type, point);
    editGraph((current) => ({ ...current, nodes: [...current.nodes, node] }));
    dispatch({ type: "select", id: null });
    setTool("select");
    setError("");
  }
  function connect(connection: Connection) {
    if (!graph || !connection.source || !connection.target) { setError("Choose both connection endpoints."); return; }
    const source = graph.nodes.find((node) => node.id === connection.source);
    if (!source || !graph.nodes.some((node) => node.id === connection.target)) { setError("Connection endpoints must be in the current graph."); return; }
    const handle = connection.sourceHandle;
    if (source.type === "decision" && handle !== "true" && handle !== "false") { setError("Choose the decision's True or False output."); return; }
    const edge: WorkflowEdge = {
      id: newId(), source: connection.source, target: connection.target,
      ...(source.type === "decision" && (handle === "true" || handle === "false") ? { branch: handle } : {}),
    };
    if (edge.source === edge.target) { setError("Use a Loop instead of a connection to the same node."); return; }
    if (graph.edges.some((item) => item.source === edge.source && item.target === edge.target && item.branch === edge.branch)) {
      setError("That connection already exists."); return;
    }
    try { orderedNodes({ ...graph, edges: [...graph.edges, edge] }); }
    catch (problem) { setError(message(problem)); return; }
    editGraph((current) => ({ ...current, edges: [...current.edges, edge] }));
    setSourceId("");
    setTargetId("");
    setError("");
  }
  function onNodesChange(changes: NodeChange<CanvasNode>[]) {
    const positions = new Map(changes.filter((change) => change.type === "position").map((change) => [change.id, change.position]));
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    if (changes.some((change) => change.type === "select" || change.type === "remove")) {
      dispatch({ type: "selection", path: state.path, nodes: changes });
    }
    if (positions.size || removed.size) {
      editGraph((current) => ({
        nodes: current.nodes.filter((node) => !removed.has(node.id)).map((node) => {
          const position = positions.get(node.id);
          return position ? { ...node, position } : node;
        }),
        edges: current.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)),
      }));
    }
  }
  function onEdgesChange(changes: EdgeChange[]) {
    dispatch({ type: "selection", path: state.path, edges: changes });
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    if (removed.size) editGraph((current) => ({ ...current, edges: current.edges.filter((edge) => !removed.has(edge.id)) }));
  }
  function removeNode() {
    if (!selected) return;
    const id = selected.id;
    editGraph((current) => ({ nodes: current.nodes.filter((node) => node.id !== id), edges: current.edges.filter((edge) => edge.source !== id && edge.target !== id) }));
    dispatch({ type: "select", id: null });
  }
  function requestHome() {
    if (busy) return;
    if (dirty) { setPending("home"); setDiscardOpen(true); }
    else { dispatch({ type: "home" }); setError(""); setNotice(""); }
  }
  async function discard() {
    if (pending === "close" && isTauri()) {
      try { await getCurrentWindow().destroy(); } catch (problem) { setError(message(problem)); }
    } else { dispatch({ type: "home" }); setDialog(null); setDiscardOpen(false); setError(""); setNotice(""); }
  }
  async function browse() {
    setError("");
    try {
      const path = saveMode === "draft" ? await chooseDraftFile(workflow?.name || "") : await chooseFolder();
      if (path) { if (saveMode === "draft") setDraftPath(path); else setFolder(path); }
    } catch (problem) { setError(message(problem)); }
  }
  function openSave() {
    setSaveMode(errors.length ? "draft" : "export");
    setError("");
    setDialog("save");
  }
  async function save() {
    if (!workflow) return;
    setBusy(true);
    setError("");
    try {
      if (!(saveMode === "draft" ? draftPath : folder)) throw new Error("Choose a save location first.");
      const result = saveMode === "draft"
        ? await saveDraft(draftPath, workflow)
        : await saveExport(folder, exportWorkflow(workflow));
      if (result.saved) {
        dispatch({ type: "saved", snapshot });
        setDialog("saved");
        setNotice([saveMode === "draft" ? `Draft saved to ${draftPath}` : `Saved in ${folder}`, result.recovered].filter(Boolean).join("\n"));
      } else if (result.recovered) {
        setError(result.recovered);
      }
    } catch (problem) { setError(message(problem)); } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!notice || dialog) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice, dialog]);
  useEffect(() => {
    setSourceId("");
    setTargetId("");
    setTool("select");
  }, [workflow?.id, state.path]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && workflow) {
        event.preventDefault();
        if (!dialog && !copilotOpen && !discardOpen && !busy) openSave();
      }
      if (event.key === "Escape" && !dialog && !copilotOpen && !discardOpen) { dispatch({ type: "select", id: null }); setTool("select"); setError(""); }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [workflow, errors.length, busy, dialog, copilotOpen, discardOpen]);
  useEffect(() => {
    if (!isTauri()) {
      function beforeUnload(event: BeforeUnloadEvent) { if (dirty || busy || modalDraft || copilotPending) { event.preventDefault(); event.returnValue = ""; } }
      window.addEventListener("beforeunload", beforeUnload);
      return () => window.removeEventListener("beforeunload", beforeUnload);
    }
    let stopped = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested((event) => {
      if (busy || dirty || modalDraft || copilotPending) {
        event.preventDefault();
        if (busy) setError("Wait for the file operation to finish before closing.");
        else { setPending("close"); setDiscardOpen(true); }
      }
    }).then((stop) => { if (stopped) stop(); else unlisten = stop; }).catch((problem: unknown) => setError(message(problem)));
    return () => { stopped = true; unlisten?.(); };
  }, [dirty, busy, modalDraft, copilotPending]);

  const bodyNames = workflow ? state.path.map((id, index) => graphAt(workflow, state.path.slice(0, index)).nodes.find((node) => node.id === id)?.name || "Loop") : [];
  return <>
    <input ref={fileInput} className="file-input" type="file" accept=".json,application/json" aria-label="Open Blueprint document" onChange={async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      setError("");
      setBusy(true);
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error("Blueprint documents must be smaller than 5 MB.");
        dispatch({ type: "open", workflow: parseWorkflow(await file.text()) });
        setFolder("");
        setDraftPath("");
        setTool("select");
      } catch (problem) { setError(message(problem)); } finally { setBusy(false); }
    }} />
    {!workflow ? <main className="welcome">
      <div className="welcome-content"><h1>blueprint</h1><div className="welcome-actions">
        <button className="primary" disabled={busy} onClick={() => { dispatch({ type: "open", workflow: newWorkflow() }); setFolder(""); setDraftPath(""); setError(""); }}>Create new workflow</button>
        <button disabled={busy} onClick={openDocument}>Open existing workflow</button>
      </div><CopilotAccount copilot={copilot} onOpen={openCopilot} />
        {error && <p className="error" role="alert">{error}</p>}</div>
    </main> : <div className="app">
      <div className="workflow-panel" role="group" aria-label="Workflow name panel">
        <button className="text-button" onClick={requestHome} aria-label="Back to welcome" title="Back to welcome"><Icon type="back" /></button>
        <input ref={workflowName} aria-label="Workflow name" value={workflow.name} maxLength={100} onChange={(event) => dispatch({ type: "name", name: event.target.value })} />
        <button className="text-button" aria-label="Rename workflow" title="Rename workflow" onClick={() => { workflowName.current?.focus(); workflowName.current?.select(); }}><Icon type="edit" /></button>
      </div>
      <nav className="toolbar" aria-label="Workflow toolbar">
        <div className="toolbar-tools">
          {palette.map(({ type, label }) => <button key={type} draggable={type !== "connect"} title={type === "connect" ? "Connect nodes using the form or their handles" : `Add ${label.toLowerCase()} (click or drag)`}
            aria-pressed={type === "connect" ? tool === "connect" : undefined}
            onDragStart={(event) => { if (type !== "connect") event.dataTransfer.setData("application/blueprint-node", type); }}
            onClick={() => {
              if (type === "connect") { dispatch({ type: "select", id: null }); setTool((value) => value === "connect" ? "select" : "connect"); setError(""); }
              else addNode(type);
            }}>
            <Icon type={type} /><span>{label}</span>
          </button>)}
        </div>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical" />
        <button className="toolbar-save" aria-label="Save workflow" disabled={busy} title="Save a draft or export the workflow" onClick={openSave}><Icon type="save" /><span>Save</span></button>
      </nav>
      {tool === "connect" && <div className="connection-hint"><span>Click an output, then an input.</span><button className="text-button" onClick={() => { setError(""); setDialog("connections"); }}>Use form</button></div>}
      {selected && graph && tool === "select" && <aside className="left-panel" aria-label="Block configuration">
        <button className="close-inspector text-button" aria-label="Close block configuration" onClick={() => dispatch({ type: "select", id: null })}>×</button>
        <div className="panel-content">
          <Inspector node={selected} graph={graph} onChange={changeNode} editBody={() => editBody(selected.id)}
            editTools={() => setDialog("tools")} remove={removeNode} copilot={copilot}
            generatePrompt={() => openAgentDialog("prompt")} editModel={() => openAgentDialog("model")} />
          {errors.length > 0 && <details className="problems"><summary>{errors.length} {errors.length === 1 ? "issue" : "issues"} to fix before saving</summary><ul>{errors.map((issue) => <li key={issue}>{issue}</li>)}</ul></details>}
        </div>
        {selected.type === "agent" && <CopilotAccount copilot={copilot} onOpen={openCopilot} compact />}
      </aside>}
      <main className="canvas" ref={canvas} aria-label="Workflow canvas" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => {
        event.preventDefault();
        const type = event.dataTransfer.getData("application/blueprint-node");
        if (type === "agent" || type === "decision" || type === "loop") addNode(type, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }}>
        {state.path.length > 0 && <div className="loop-navigation"><button className="back-to-workflow" onClick={() => {
          dispatch({ type: "navigate", path: state.path.slice(0, -1) });
          setTool("select");
        }}><Icon type="back" />{state.path.length === 1 ? "Workflow" : "Parent loop"}</button><span title={bodyNames.join(" / ")}>{bodyNames.join(" / ")}</span></div>}
        <ReactFlow<CanvasNode> key={state.path.join("/")} nodes={canvasNodes} edges={canvasEdges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={connect} onNodeClick={(_, node) => {
            if (tool === "connect") { if (!sourceId) setSourceId(node.id); else setTargetId(node.id); }
          }} onNodeDoubleClick={(_, node) => { if (node.data.node.type === "loop") editBody(node.id); }}
          onPaneClick={() => dispatch({ type: "select", id: null })}
          onError={(_, detail) => setError(detail)} minZoom={0.25} maxZoom={2} deleteKeyCode={["Backspace", "Delete"]}
          fitView={canvasNodes.length > 0} fitViewOptions={fitViewOptions}
          defaultEdgeOptions={{ style: { stroke: "#969aa1", strokeWidth: 1.25 } }} connectOnClick>
          <Background variant={BackgroundVariant.Dots} gap={32} size={1.2} color="#e1e3e6" />
          <Controls position="bottom-right" showInteractive={false} fitViewOptions={fitViewOptions} />
        </ReactFlow>
        {graph?.nodes.length === 0 && <div className="empty-canvas"><h2>{state.path.length ? "Add the loop's first agent" : "Start with an agent"}</h2><button className="primary" onClick={() => addNode("agent")}>Add agent</button></div>}
        {error && !dialog && <div className="canvas-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
        {notice && !dialog && !error && <div className="canvas-notice" role="status">{notice}</div>}
      </main>
    </div>}
    {dialog === "prompt" && agentTarget && <PromptDialog agent={agentTarget.agent} onClose={closeAgentDialog} onConnect={() => {
      setCopilotOpen(true);
      void copilot.refresh();
    }} onApply={(prompt) => {
      changeNode(applyGeneratedPrompt(currentTarget(), agentTarget.agent, prompt));
      closeAgentDialog();
      setNotice("System prompt updated");
    }} />}
    {dialog === "model" && agentTarget && <CustomModelDialog agent={agentTarget.agent} onClose={closeAgentDialog} onSave={(model) => {
      changeNode({ ...currentTarget(), model });
      closeAgentDialog();
    }} />}
    {dialog === "connections" && graph && <Dialog title="Connect nodes" onClose={() => setDialog(null)}>
      <Field label="From"><select value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">Choose node</option>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.name || "Unnamed"}</option>)}</select></Field>
      {graph.nodes.find((node) => node.id === sourceId)?.type === "decision" && <Field label="Output"><select value={branch} onChange={(event) => setBranch(event.target.value === "true" ? "true" : "false")}><option value="true">True</option><option value="false">False</option></select></Field>}
      <Field label="To"><select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">Choose node</option>{graph.nodes.filter((node) => node.id !== sourceId).map((node) => <option key={node.id} value={node.id}>{node.name || "Unnamed"}</option>)}</select></Field>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="wide" disabled={!graph.nodes.some((node) => node.id === sourceId) || !graph.nodes.some((node) => node.id === targetId)} onClick={() => connect({ source: sourceId, target: targetId, sourceHandle: graph.nodes.find((node) => node.id === sourceId)?.type === "decision" ? branch : "out", targetHandle: "in" })}>Connect</button>
      {!!graph.edges.length && <div className="connection-list"><h3>Connections</h3>{graph.edges.map((edge) => <div key={edge.id}>
        <span>{graph.nodes.find((node) => node.id === edge.source)?.name} → {graph.nodes.find((node) => node.id === edge.target)?.name}{edge.branch ? ` (${edge.branch})` : ""}</span>
        <button aria-label="Delete connection" onClick={() => editGraph((current) => ({ ...current, edges: current.edges.filter((item) => item.id !== edge.id) }))}>×</button>
      </div>)}</div>}
    </Dialog>}
    {dialog === "tools" && selected?.type === "agent" && <Dialog title="Tools & MCP" onClose={() => setDialog(null)}>
      <ToolsEditor agent={selected} onCancel={() => setDialog(null)} onSave={(node) => { changeNode(node); setDialog(null); }} />
    </Dialog>}
    {dialog === "save" && workflow && <Dialog title="Save workflow" onClose={() => { if (!busy) setDialog(null); }} busy={busy}>
      <div className="segmented" aria-label="Save format">
        <button disabled={busy} aria-pressed={saveMode === "draft"} onClick={() => { setSaveMode("draft"); setError(""); }}>Draft file</button>
        <button disabled={busy} aria-pressed={saveMode === "export"} onClick={() => { setSaveMode("export"); setError(""); }}>Repository export</button>
      </div>
      <Field label="Name"><input value={workflow.name} maxLength={100} disabled={busy} onChange={(event) => dispatch({ type: "name", name: event.target.value })} /></Field>
      <Field label={saveMode === "draft" ? "File" : "Folder"}><div className="folder-picker"><input value={saveMode === "draft" ? draftPath : folder} placeholder={saveMode === "draft" ? "Choose a .blueprint.json file" : "Choose an export folder"} readOnly /><button disabled={busy} onClick={browse}>Browse</button></div></Field>
      {saveMode === "draft" ? <p className="muted">Saves the editable canvas, including unfinished settings. Runnable files are not created or changed.</p> : <div className="export-preview"><span className="muted">.github/</span>
        <code>extensions/{slug(workflow.name)}/extension.mjs<br />extensions/{slug(workflow.name)}/workflow.ts<br />extensions/{slug(workflow.name)}/blueprint.json<br />agents/*.agent.md</code>
      </div>}
      {errors.length > 0 && (saveMode === "export" ? <p className="error" role="alert">{errors.join("\n")}</p>
        : <p className="muted">{errors.length} {errors.length === 1 ? "issue needs" : "issues need"} attention before repository export. You can save this draft now.</p>)}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="primary" disabled={busy || !(saveMode === "draft" ? draftPath : folder) || (saveMode === "export" && errors.length > 0)} onClick={save}>{busy ? "Saving…" : saveMode === "draft" ? "Save draft" : "Save & export"}</button></div>
    </Dialog>}
    {dialog === "saved" && workflow && <Dialog title={saveMode === "draft" ? "Draft saved" : "Workflow exported"} onClose={() => { setDialog(null); setNotice(""); }}>
      <p>{notice}</p>
      {saveMode === "draft" ? <p className="muted">Open this file in Blueprint to keep editing. Runnable exports are unchanged.</p> : <>
        <code className="run-command">copilot --experimental workflow run {slug(workflow.name)}</code>
        <p className="muted">Run from the exported repository with Copilot authentication and the required tool permissions. Saving does not run a workflow.</p>
      </>}
      <div className="dialog-actions"><button className="primary" onClick={() => { setDialog(null); setNotice(""); }}>Back to canvas</button></div>
    </Dialog>}
    {copilotOpen && <CopilotDialog copilot={copilot} onClose={() => setCopilotOpen(false)} />}
    {discardOpen && <Dialog title="Unsaved changes" onClose={() => setDiscardOpen(false)}>
      <p>Discard your unsaved workflow changes?</p>
      {dialog === "prompt" && <p className="muted">This also discards the prompt description or unapplied draft.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button onClick={() => setDiscardOpen(false)}>Keep editing</button><button className="primary" onClick={discard}>Discard changes</button></div>
    </Dialog>}
  </>;
}
