import { useId, useState } from "react";
import { ModelField, type CopilotController } from "./Copilot.tsx";
import { Icon } from "./Nodes.tsx";
import { Field } from "./ui.tsx";
import { allowedServerTools, mcpSchema, outputFields, type AgentNode, type Condition, type FieldType, type Graph, type McpServer, type Operator, type Primitive, type WorkflowNode } from "./workflow.ts";

function Sources({ graph, current, exclude, onChange }: {
  graph: Graph; current: string; exclude?: string; onChange: (id: string) => void;
}) {
  return <select aria-label="Source" value={current} onChange={(event) => onChange(event.target.value)}>
    <option value="input">Workflow inputs</option>
    {graph.nodes.filter((node) => node.id !== exclude && (
      node.type === "loop" || (node.type === "agent" && node.output === "json")
    )).map((node) => <option value={node.id} key={node.id}>{node.name || "Unnamed"}</option>)}
  </select>;
}

export function ConditionFields({ condition, graph, exclude, onChange }: {
  condition: Condition; graph: Graph; exclude?: string; onChange: (value: Condition) => void;
}) {
  const source = graph.nodes.find((node) => node.id === condition.source);
  const fields = source ? outputFields(source).filter((field) => ["boolean", "string", "number"].includes(field.type)) : [];
  const selectedType = fields.find((field) => field.name === condition.field)?.type;
  const valueType = selectedType || (condition.value === null ? "null" : typeof condition.value);
  function changeField(field: string, origin = source, sourceId = condition.source) {
    const type = origin ? outputFields(origin).find((item) => item.name === field)?.type : undefined;
    const value = type === "boolean" ? true : type === "number" ? 0 : type === "string" ? "" : condition.value;
    onChange({ source: sourceId, field, operator: "equals", value });
  }
  const operators: { id: Operator; label: string }[] = [
    { id: "equals", label: "Equals" }, { id: "notEquals", label: "Does not equal" },
    ...(valueType === "number" ? [{ id: "greater" as const, label: "Greater than" }, { id: "less" as const, label: "Less than" }] : []),
    ...(valueType === "string" ? [{ id: "contains" as const, label: "Contains" }] : []),
  ];
  return <>
    <Field label="Source"><Sources graph={graph} current={condition.source} exclude={exclude} onChange={(id) => {
      const origin = graph.nodes.find((node) => node.id === id);
      const first = origin ? outputFields(origin).find((item) => ["boolean", "string", "number"].includes(item.type))?.name : undefined;
      changeField(first || (id === "input" ? "task" : ""), origin, id);
    }} /></Field>
    <Field label="Field">{source
      ? <select value={condition.field} onChange={(event) => changeField(event.target.value)}><option value="">Choose field</option>{fields.map((field) => <option key={field.name} value={field.name}>{field.label}</option>)}</select>
      : <input value={condition.field} placeholder="task" onChange={(event) => changeField(event.target.value)} />}</Field>
    {!selectedType && <Field label="Value type"><select value={valueType} onChange={(event) => {
      const values: Record<string, Primitive> = { string: "", number: 0, boolean: true, null: null };
      onChange({ ...condition, operator: "equals", value: values[event.target.value] });
    }}><option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="null">Null</option></select></Field>}
    <Field label="Rule"><select value={condition.operator} onChange={(event) => {
      const operator = operators.find((item) => item.id === event.target.value)?.id;
      if (operator) onChange({ ...condition, operator });
    }}>{operators.map((operator) => <option value={operator.id} key={operator.id}>{operator.label}</option>)}</select></Field>
    <Field label="Value">{valueType === "boolean"
      ? <select value={String(condition.value)} onChange={(event) => onChange({ ...condition, value: event.target.value === "true" })}><option>true</option><option>false</option></select>
      : valueType === "null" ? <input value="null" readOnly />
      : <input type={valueType === "number" ? "number" : "text"} step="any" value={valueType === "number" && !Number.isFinite(condition.value) ? "" : String(condition.value ?? "")} onChange={(event) => onChange({
        ...condition, value: valueType === "number" ? event.target.valueAsNumber : event.target.value,
      })} />}</Field>
  </>;
}

export function Inspector({ node, graph, onChange, editBody, editTools, remove, copilot, generatePrompt, editModel }: {
  node: WorkflowNode; graph: Graph; onChange: (node: WorkflowNode) => void;
  editBody: () => void; editTools: () => void; remove: () => void;
  copilot: CopilotController; generatePrompt: () => void; editModel: () => void;
}) {
  const promptId = useId();
  return <section className="inspector">
    <h2>{node.name || "Unnamed"}</h2>
    <Field label="Name"><input value={node.name} maxLength={100} onChange={(event) => onChange({ ...node, name: event.target.value })} /></Field>
    {node.type === "agent" ? <>
      <ModelField agent={node} copilot={copilot} onChange={(model) => onChange({ ...node, model })} onManual={editModel} />
      <div className="field"><div className="prompt-field-heading"><label htmlFor={promptId}>System prompt</label><button className="text-button generate-prompt" onClick={generatePrompt}><Icon type="sparkles" />Generate</button></div>
        <textarea id={promptId} value={node.prompt} rows={6} maxLength={30_000} placeholder="Describe this agent's role and instructions." onChange={(event) => onChange({ ...node, prompt: event.target.value })} />
      </div>
      <button className="wide" onClick={editTools}>Tools &amp; MCP</button>
      <Field label="Output"><select value={node.output} onChange={(event) => {
        const output = event.target.value === "json" ? "json" : "text";
        onChange({ ...node, output, fields: output === "json" && !node.fields.length ? [{ name: "passed", type: "boolean" }] : node.fields });
      }}><option value="text">Text</option><option value="json">JSON</option></select></Field>
      {node.output === "json" && <OutputFields node={node} onChange={onChange} />}
      <details className="advanced"><summary>Task input</summary><Field label="Task prompt"><textarea rows={3} value={node.task} maxLength={10_000} onChange={(event) => onChange({ ...node, task: event.target.value })} /></Field><p className="muted">Workflow inputs and upstream results are appended automatically.</p></details>
    </> : node.type === "decision" ? <>
      <ConditionFields condition={node.condition} graph={graph} exclude={node.id} onChange={(condition) => onChange({ ...node, condition })} />
      <p className="muted">Only the chosen path runs. Missing fields are errors, not False.</p>
    </> : <>
      <div className="segmented" aria-label="Loop mode">{(["repeat", "each"] as const).map((mode) => <button key={mode} aria-pressed={node.mode === mode} onClick={() => onChange({ ...node, mode })}>{mode === "repeat" ? "Repeat" : "For each"}</button>)}</div>
      {node.mode === "repeat" ? <>
        <Field label="Max iterations *"><input type="number" min={1} step={1} value={node.maxIterations || ""} onChange={(event) => onChange({ ...node, maxIterations: Number(event.target.value) })} /></Field>
        <h3>Repeat until</h3>
        <ConditionFields condition={node.condition} graph={node.body} onChange={(condition) => onChange({ ...node, condition })} />
      </> : <>
        <Field label="Collection source"><Sources graph={graph} current={node.collection.source} exclude={node.id} onChange={(source) => {
          const origin = graph.nodes.find((item) => item.id === source);
          onChange({ ...node, collection: { source, field: origin ? outputFields(origin).find((field) => field.type === "array")?.name || "" : "files" } });
        }} /></Field>
        <Field label="Collection field">{node.collection.source === "input" ? <input value={node.collection.field} placeholder="files" onChange={(event) => onChange({ ...node, collection: { ...node.collection, field: event.target.value } })} />
          : <select value={node.collection.field} onChange={(event) => onChange({ ...node, collection: { ...node.collection, field: event.target.value } })}><option value="">Choose an array field</option>{graph.nodes.filter((item) => item.id === node.collection.source).flatMap((item) => outputFields(item)).filter((field) => field.type === "array").map((field) => <option key={field.name} value={field.name}>{field.label}</option>)}</select>}</Field>
        <Field label="Item name"><input value={node.itemName} onChange={(event) => onChange({ ...node, itemName: event.target.value })} /></Field>
        <p className="muted">Runs once per item, in order. Each agent receives the item and index.</p>
      </>}
      <button className="wide" onClick={editBody}>Edit body</button>
    </>}
    <button className="text-button danger remove-node" onClick={remove}>Delete node</button>
  </section>;
}

function OutputFields({ node, onChange }: { node: AgentNode; onChange: (node: AgentNode) => void }) {
  const types: FieldType[] = ["string", "number", "boolean", "array", "object"];
  return <section className="output-fields" aria-label="JSON output fields">
    {node.fields.map((field, index) => <div className="output-field" key={index}>
      <input aria-label={`Output field ${index + 1}`} placeholder="Field name" value={field.name} onChange={(event) => onChange({
        ...node, fields: node.fields.map((item, offset) => offset === index ? { ...item, name: event.target.value } : item),
      })} />
      <select aria-label={`Type of output field ${index + 1}`} value={field.type} onChange={(event) => {
        const type = types.find((item) => item === event.target.value);
        if (type) onChange({ ...node, fields: node.fields.map((item, offset) => offset === index ? { ...item, type } : item) });
      }}>{types.map((type) => <option key={type}>{type}</option>)}</select>
      <button aria-label={`Remove output field ${index + 1}`} onClick={() => onChange({ ...node, fields: node.fields.filter((_, offset) => offset !== index) })}>×</button>
    </div>)}
    <button className="text-button" onClick={() => onChange({ ...node, fields: [...node.fields, { name: "", type: "string" }] })}>Add field</button>
  </section>;
}

export function ToolsEditor({ agent, onSave, onCancel }: {
  agent: AgentNode; onSave: (agent: AgentNode) => void; onCancel: () => void;
}) {
  const builtins = ["read", "search", "edit", "execute", "agent", "web"];
  const managed = Object.keys(agent.mcpServers);
  const [tools, setTools] = useState(agent.tools.filter((tool) => builtins.includes(tool) || tool === "*"));
  const [custom, setCustom] = useState(agent.tools.filter((tool) => !builtins.includes(tool) && tool !== "*" && !managed.some((name) => tool.startsWith(`${name}/`))).join(", "));
  const [servers, setServers] = useState(Object.entries(agent.mcpServers).map(([name, config]) => ({
    name, config: { ...config, tools: allowedServerTools(name, config, agent.tools) },
  })));
  const [error, setError] = useState("");
  function update(index: number, config: McpServer) {
    setServers((items) => items.map((item, offset) => offset === index ? { ...item, config } : item));
  }
  function save() {
    const names = servers.map((server) => server.name.trim());
    if (new Set(names).size !== names.length) { setError("MCP server names must be unique."); return; }
    const result = mcpSchema.safeParse(Object.fromEntries(servers.map((server, index) => [names[index], server.config])));
    if (!result.success) {
      setError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
      return;
    }
    const serverTools = Object.entries(result.data).flatMap(([name, server]) => server.tools.map((tool) => `${name}/${tool}`));
    onSave({ ...agent, tools: [...new Set([...tools, ...custom.split(",").map((tool) => tool.trim()).filter(Boolean), ...serverTools])], mcpServers: result.data });
  }
  return <>
    <div className="tools-list">
      {["*", ...builtins].map((tool) => <label key={tool}><input type="checkbox" checked={tools.includes(tool)} onChange={(event) => {
        setTools((values) => event.target.checked ? [...values, tool] : values.filter((item) => item !== tool));
      }} />{tool === "*" ? "All available tools" : tool}</label>)}
    </div>
    <Field label="Other tools"><input value={custom} placeholder="github/*, server/tool" onChange={(event) => setCustom(event.target.value)} /></Field>
    <h3>MCP servers</h3>
    {servers.map(({ name, config }, index) => <section className="mcp-server" key={index}>
      <div className="two-fields">
        <Field label="Server name"><input value={name} onChange={(event) => setServers((items) => items.map((item, offset) => offset === index ? { ...item, name: event.target.value } : item))} /></Field>
        <Field label="Transport"><select value={config.type} onChange={(event) => update(index, event.target.value === "http"
          ? { type: "http", url: "", headers: {}, tools: ["*"] }
          : { type: "local", command: "", args: [], env: {}, tools: ["*"] })}><option value="local">Local / stdio</option><option value="http">HTTP</option></select></Field>
      </div>
      {config.type === "local" ? <>
        <Field label="Command"><input value={config.command} placeholder="npx" onChange={(event) => update(index, { ...config, command: event.target.value })} /></Field>
        {config.args.map((argument, offset) => <div className="argument-row" key={offset}>
          <input aria-label={`Argument ${offset + 1}`} value={argument} onChange={(event) => update(index, { ...config, args: config.args.map((item, position) => position === offset ? event.target.value : item) })} />
          <button aria-label={`Remove argument ${offset + 1}`} onClick={() => update(index, { ...config, args: config.args.filter((_, position) => position !== offset) })}>×</button>
        </div>)}
        <button className="text-button" onClick={() => update(index, { ...config, args: [...config.args, ""] })}>Add argument</button>
      </> : <Field label="URL"><input value={config.url} placeholder="https://example.com/mcp" onChange={(event) => update(index, { ...config, url: event.target.value })} /></Field>}
      <Field label="Allowed server tools"><input value={config.tools.join(",")} onChange={(event) => update(index, { ...config, tools: event.target.value.split(",") })} /></Field>
      <SecretReferences values={config.type === "local" ? config.env : config.headers} onChange={(values) => update(index,
        config.type === "local" ? { ...config, env: values } : { ...config, headers: values },
      )} />
      <button className="text-button danger" onClick={() => setServers((items) => items.filter((_, offset) => offset !== index))}>Remove server</button>
    </section>)}
    <button className="text-button" onClick={() => setServers((items) => [...items, { name: "", config: { type: "local", command: "", args: [], env: {}, tools: ["*"] } }])}>Add MCP server</button>
    <p className="muted">Tools still require Copilot permissions. Credentials must be environment references, never secret values.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="dialog-actions"><button onClick={onCancel}>Cancel</button><button className="primary" onClick={save}>Done</button></div>
  </>;
}

function SecretReferences({ values, onChange }: { values: Record<string, string>; onChange: (values: Record<string, string>) => void }) {
  const entries = Object.entries(values);
  const [error, setError] = useState("");
  return <div className="references">
    {entries.map(([key, value], index) => <div className="reference-row" key={index}>
      <input aria-label={`Environment or header name ${index + 1}`} value={key} placeholder="TOKEN" onChange={(event) => {
        const changed = entries.map((entry, offset) => offset === index ? [event.target.value, value] : entry);
        if (new Set(changed.map((entry) => entry[0])).size !== changed.length) { setError("Reference names must be unique."); return; }
        setError("");
        onChange(Object.fromEntries(changed));
      }} />
      <input aria-label={`Secret reference ${index + 1}`} value={value} placeholder="${TOKEN}" onChange={(event) => onChange({ ...values, [key]: event.target.value })} />
      <button aria-label={`Remove reference ${index + 1}`} onClick={() => onChange(Object.fromEntries(entries.filter((_, offset) => offset !== index)))}>×</button>
    </div>)}
    <button className="text-button" onClick={() => {
      let name = "TOKEN";
      while (Object.hasOwn(values, name)) name += "_";
      onChange({ ...values, [name]: `\${${name}}` });
    }}>Add environment / header reference</button>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
