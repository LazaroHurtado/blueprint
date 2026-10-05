import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { WorkflowNode } from "./workflow.ts";

export type CanvasNode = Node<{ node: WorkflowNode; editBody: (id: string) => void }, "workflow">;
export function Icon({ type }: { type: "agent" | "decision" | "loop" | "connect" | "back" | "save" | "edit" | "sparkles" }) {
  const paths = {
    agent: <><rect x="5" y="7" width="14" height="12" rx="3" /><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" /></>,
    decision: <path d="m12 3 9 9-9 9-9-9z" />,
    loop: <path d="M19 8a8 8 0 1 0 1 8M19 3v5h-5" />,
    connect: <path d="M4 12h16m-5-5 5 5-5 5" />,
    back: <path d="M19 12H5m5-5-5 5 5 5" />,
    save: <path d="M4 3h13l4 4v14H3V3h1zM7 3v6h10V3M7 21v-8h10v8" />,
    edit: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4zM15 5l3 3" />,
    sparkles: <path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7z" />,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type]}</svg>;
}

export function WorkflowCard({ data, selected }: NodeProps<CanvasNode>) {
  const node = data.node;
  return (
    <div className={`workflow-node ${node.type}-node${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="node-heading" title={node.name}><Icon type={node.type} /><span>{node.name || "Unnamed"}</span></div>
      {node.type === "loop" ? <>
        <p className="node-caption">{node.mode === "repeat" ? `Repeat · max ${node.maxIterations || "?"}` : "For each · sequential"}</p>
        <div className="loop-preview">
          {node.body.nodes.slice(0, 3).map((item) => <div key={item.id}><Icon type={item.type} /><span>{item.name || "Unnamed"}</span></div>)}
          {!node.body.nodes.length && <span className="muted">Empty body</span>}
          {node.body.nodes.length > 3 && <span className="muted">+{node.body.nodes.length - 3} nodes</span>}
        </div>
        <button className="text-button nodrag" onClick={(event) => { event.stopPropagation(); data.editBody(node.id); }}>Edit body</button>
        <Handle type="source" position={Position.Right} id="out" />
      </> : node.type === "decision" ? <>
        <p className="node-caption">Decision</p>
        <Handle type="source" position={Position.Top} id="true" aria-label="True output" />
        <Handle type="source" position={Position.Bottom} id="false" aria-label="False output" />
        <span className="branch-label true-label">True</span><span className="branch-label false-label">False</span>
      </> : <>
        <p className="node-caption">Agent</p>
        <Handle type="source" position={Position.Right} id="out" />
      </>}
    </div>
  );
}
