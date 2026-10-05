import { z } from "zod";

export type Primitive = string | number | boolean | null;
export type Json = Primitive | Json[] | { [key: string]: Json };
export type FieldType = "string" | "number" | "boolean" | "array" | "object";
export type Operator = "equals" | "notEquals" | "greater" | "less" | "contains";
export type Condition = {
  source: string;
  field: string;
  operator: Operator;
  value: Primitive;
};
export type McpServer =
  | { type: "local"; command: string; args: string[]; env: Record<string, string>; tools: string[] }
  | { type: "http"; url: string; headers: Record<string, string>; tools: string[] };
type BaseNode = { id: string; name: string; position: { x: number; y: number } };
export type AgentNode = BaseNode & {
  type: "agent";
  model?: string;
  prompt: string;
  task: string;
  tools: string[];
  mcpServers: Record<string, McpServer>;
  output: "text" | "json";
  fields: { name: string; type: FieldType }[];
};
export type DecisionNode = BaseNode & { type: "decision"; condition: Condition };
export type LoopNode = BaseNode & {
  type: "loop";
  mode: "repeat" | "each";
  condition: Condition;
  maxIterations: number;
  collection: { source: string; field: string };
  itemName: string;
  body: Graph;
};
export type WorkflowNode = AgentNode | DecisionNode | LoopNode;
export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  branch?: "true" | "false";
};
export type Graph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
export type Workflow = {
  version: 1;
  id: string;
  name: string;
  description: string;
  graph: Graph;
};

const identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64)
  .refine((name) => !["__proto__", "constructor", "prototype"].includes(name), "Reserved identifier");
const propertyName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .refine((name) => !["__proto__", "constructor", "prototype"].includes(name), "Reserved field name");
const modelSchema = z.string().trim().min(1, "Enter a model ID or leave it unset.").max(200);
const toolListSchema = z.array(z.string()).transform((tools) => (
  [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))]
));
const reference = z.string().regex(
  /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\{\{\s*(?:secrets|vars)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\})$/,
  "Use an environment or secret reference, not a credential value",
);
const serverSchema: z.ZodType<McpServer> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("local"), command: z.string().trim().min(1), args: z.array(z.string()),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), reference), tools: toolListSchema,
  }).strict(),
  z.object({
    type: z.literal("http"),
    url: z.string().refine((value) => {
      try {
        const url = new URL(value);
        return !url.username && !url.password && (
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        );
      } catch {
        return false;
      }
    }, "Use HTTPS (or localhost HTTP), without embedded credentials"),
    headers: z.record(z.string().trim().min(1), reference), tools: toolListSchema,
  }).strict(),
]);
export const mcpSchema = z.record(identifier, serverSchema);
export function allowedServerTools(name: string, server: McpServer, agentTools: string[]): string[] {
  const prefix = `${name}/`;
  const selected = agentTools.filter((tool) => tool.startsWith(prefix)).map((tool) => tool.slice(prefix.length));
  if (agentTools.includes("*") || selected.includes("*")) return server.tools;
  return selected.filter((tool) => server.tools.includes("*") || server.tools.includes(tool));
}
const conditionSchema: z.ZodType<Condition> = z.object({
  source: z.string(), field: z.string(), operator: z.enum(["equals", "notEquals", "greater", "less", "contains"]),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
}).strict();
const base = {
  id: identifier.refine((name) => name !== "input", "The node ID input is reserved for workflow inputs"), name: z.string().max(100),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
};
const nodeSchema: z.ZodType<WorkflowNode> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({
    ...base, type: z.literal("agent"), model: modelSchema.optional(), prompt: z.string().max(30_000), task: z.string().max(10_000),
    tools: z.array(z.string()), mcpServers: mcpSchema, output: z.enum(["text", "json"]),
    fields: z.array(z.object({ name: z.string(), type: z.enum(["string", "number", "boolean", "array", "object"]) }).strict()),
  }).strict(),
  z.object({ ...base, type: z.literal("decision"), condition: conditionSchema }).strict(),
  z.object({
    ...base, type: z.literal("loop"), mode: z.enum(["repeat", "each"]), condition: conditionSchema,
    maxIterations: z.number().finite(), itemName: z.string(),
    collection: z.object({ source: z.string(), field: z.string() }).strict(), body: graphSchema,
  }).strict(),
]));
const graphSchema: z.ZodType<Graph> = z.object({
  nodes: z.array(nodeSchema),
  edges: z.array(z.object({
    id: identifier, source: identifier, target: identifier, branch: z.enum(["true", "false"]).optional(),
  }).strict()),
}).strict();
const workflowSchema: z.ZodType<Workflow> = z.object({
  version: z.literal(1), id: identifier, name: z.string().max(100),
  description: z.string().max(2_000), graph: graphSchema,
}).strict();
const draftSchema = z.object({
  format: z.literal("blueprint-draft"),
  version: z.literal(1),
  workflow: workflowSchema,
  unfinishedConditions: z.array(identifier),
}).strict();

export function serializeDraft(workflow: Workflow): string {
  const document = structuredClone(workflow);
  const unfinishedConditions: string[] = [];
  for (const node of nodesIn(document.graph)) {
    if (node.type !== "agent" && Number.isNaN(node.condition.value)) {
      node.condition.value = null;
      unfinishedConditions.push(node.id);
    }
  }
  return `${JSON.stringify({
    format: "blueprint-draft", version: 1, workflow: document, unfinishedConditions,
  }, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Draft contains an invalid number outside an unfinished condition.");
    }
    return value;
  }, 2)}\n`;
}

export function parseWorkflow(text: string): Workflow {
  if (new TextEncoder().encode(text).length > 5 * 1024 * 1024) throw new Error("Blueprint documents must be smaller than 5 MB.");
  const input: unknown = JSON.parse(text);
  const graphDocument = input && typeof input === "object" && "format" in input && "workflow" in input
    ? input.workflow : input;
  const pending: { value: unknown; depth: number }[] = [{ value: graphDocument, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.depth > 64) throw new Error("Document nesting exceeds the safe import limit.");
    if (entry.value && typeof entry.value === "object") {
      for (const value of Object.values(entry.value)) pending.push({ value, depth: entry.depth + 1 });
    }
  }
  let document: Workflow;
  let unfinishedConditions: string[] = [];
  if (input && typeof input === "object" && "format" in input) {
    const result = draftSchema.safeParse(input);
    if (!result.success) throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
    document = result.data.workflow;
    unfinishedConditions = result.data.unfinishedConditions;
  } else {
    const result = workflowSchema.safeParse(input);
    if (!result.success) throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
    document = result.data;
  }
  const nodes = nodesIn(document.graph);
  const ids = nodes.map((node) => node.id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new Error("Every workflow node must have a unique ID (case-insensitive for macOS exports).");
  if (new Set(unfinishedConditions).size !== unfinishedConditions.length) throw new Error("Duplicate unfinished conditions in draft.");
  for (const id of unfinishedConditions) {
    const node = nodes.find((node) => node.id === id);
    if (!node || node.type === "agent" || node.condition.value !== null) {
      throw new Error("Draft unfinished-condition metadata does not match its graph.");
    }
    node.condition.value = Number.NaN;
  }
  return document;
}

export function slug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

export function orderedNodes(graph: Graph): WorkflowNode[] {
  // ponytail: small DAG scan; use indexed indegrees if large canvases make validation slow.
  const remaining = [...graph.nodes];
  const ordered: WorkflowNode[] = [];
  while (remaining.length) {
    const index = remaining.findIndex((node) => graph.edges.every(
      (edge) => edge.target !== node.id || ordered.some((parent) => parent.id === edge.source),
    ));
    if (index < 0) throw new Error("Connections must not contain cycles or missing nodes. Use a Loop for repetition.");
    ordered.push(remaining.splice(index, 1)[0]);
  }
  return ordered;
}

export type ActivationRule = number | { all: ActivationRule[] } | { any: ActivationRule[] };
type Branch = { decision: string; value: "true" | "false" };
type BranchInput = { index: number; path: Branch[] };

export function planGraph(graph: Graph): {
  node: WorkflowNode; incoming: WorkflowEdge[]; activation: ActivationRule;
}[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const paths = new Map<string, Branch[]>();
  const name = (id: string) => byId.get(id)?.name || id;

  function combine(inputs: BranchInput[], target: WorkflowNode): { path: Branch[]; activation: ActivationRule } {
    const required: ActivationRule[] = inputs.filter((input) => !input.path.length).map((input) => input.index);
    const conditional = inputs.filter((input) => input.path.length);
    if (!conditional.length) return { path: [], activation: { all: required } };

    const decision = conditional[0].path[0].decision;
    const unrelated = conditional.find((input) => input.path[0].decision !== decision);
    if (unrelated) {
      throw new Error(
        `${target.name}: inputs from unrelated decisions "${name(decision)}" and "${name(unrelated.path[0].decision)}". ` +
        "Merge each decision's branches first, or express the combined condition explicitly.",
      );
    }
    const branch = (value: Branch["value"]) => conditional
      .filter((input) => input.path[0].value === value)
      .map((input) => ({ ...input, path: input.path.slice(1) }));
    const trueInputs = branch("true");
    const falseInputs = branch("false");

    if (trueInputs.length && falseInputs.length) {
      const yes = combine(trueInputs, target);
      const no = combine(falseInputs, target);
      const unfinished = [...yes.path, ...no.path][0];
      if (unfinished) {
        throw new Error(
          `${target.name}: complete both branches of "${name(unfinished.decision)}" before merging ` +
          `"${name(decision)}". Inner decisions must rejoin before their outer decision.`,
        );
      }
      // Only complementary branches remove a gate; shared inputs remain required.
      required.push({ any: [yes.activation, no.activation] });
      return { path: [], activation: { all: required } };
    }

    const value = trueInputs.length ? "true" : "false";
    const child = combine(trueInputs.length ? trueInputs : falseInputs, target);
    required.push(child.activation);
    return { path: [{ decision, value }, ...child.path], activation: { all: required } };
  }

  return orderedNodes(graph).map((node) => {
    const incoming = graph.edges.filter((edge) => edge.target === node.id);
    const inputs = incoming.map((edge, index): BranchInput => {
      const source = byId.get(edge.source);
      const path = paths.get(edge.source);
      if (!source || !path) throw new Error(`${node.name}: an incoming node is missing.`);
      if (source.type !== "decision") return { index, path };
      if (!edge.branch) throw new Error(`${source.name}: choose True or False for each outgoing connection.`);
      return { index, path: [...path, { decision: source.id, value: edge.branch }] };
    });
    const { path, activation } = combine(inputs, node);
    paths.set(node.id, path);
    return { node, incoming, activation };
  });
}

export function nodesIn(graph: Graph): WorkflowNode[] {
  return graph.nodes.flatMap((node) => node.type === "loop" ? [node, ...nodesIn(node.body)] : [node]);
}

export function outputFields(node: WorkflowNode): { name: string; label: string; type: FieldType }[] {
  if (node.type === "agent") return node.output === "json" ? node.fields.flatMap((field) => [
    { ...field, label: field.name },
    ...(field.type === "array" ? [{ name: `${field.name}.length`, label: `${field.name} count`, type: "number" as const }] : []),
  ]) : [];
  if (node.type === "decision") return [];
  if (node.mode === "each") return [
    { name: "items", label: "Item results", type: "array" },
    { name: "items.length", label: "Item count", type: "number" },
  ];
  return [
    { name: "iterations", label: "Iterations", type: "number" },
    { name: "results", label: "Body results", type: "object" },
    ...node.body.nodes.flatMap((child) => outputFields(child).map((field) => ({
      ...field, name: `results.${child.id}.${field.name}`, label: `${child.name} · ${field.label}`,
    }))),
  ];
}

export function validateWorkflow(workflow: Workflow): string[] {
  const errors: string[] = [];
  const identifiers = new Set<string>();
  if (!slug(workflow.name)) errors.push("Give the workflow a name containing letters or numbers.");
  function inspect(graph: Graph, context: string) {
    if (!graph.nodes.length) errors.push(`${context}: add at least one node.`);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of graph.nodes) {
      const id = node.id.toLowerCase();
      if (identifiers.has(id)) errors.push(`${context}: duplicate node ID ${node.id} (IDs must be case-insensitive unique).`);
      identifiers.add(id);
      if (!node.name.trim()) errors.push(`${context}: every node needs a name.`);
    }
    const edgeIds = new Set<string>();
    for (const edge of graph.edges) {
      if (edgeIds.has(edge.id)) errors.push(`${context}: duplicate connection ID.`);
      edgeIds.add(edge.id);
      const source = byId.get(edge.source);
      if (!source || !byId.has(edge.target)) errors.push(`${context}: connection refers to a missing node.`);
      if (edge.source === edge.target) errors.push(`${context}: a node cannot connect to itself.`);
      if (source?.type === "decision" && !edge.branch) errors.push(`${source.name}: choose True or False for each outgoing connection.`);
      if (source?.type !== "decision" && edge.branch) errors.push(`${context}: only decisions have conditional connections.`);
      if (graph.edges.some((other) => other !== edge && other.source === edge.source && other.target === edge.target && other.branch === edge.branch)) {
        errors.push(`${context}: remove the duplicate connection.`);
      }
    }
    try { planGraph(graph); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    function referenceIsValid(source: string, field: string, target?: string) {
      if (!field.trim() || field.split(".").some((part) => !part || ["__proto__", "constructor", "prototype"].includes(part))) {
        errors.push(`${context}: choose a valid field path.`);
      }
      if (source === "input") return;
      const origin = byId.get(source);
      if (!origin) { errors.push(`${context}: choose an available output source.`); return; }
      if (!outputFields(origin).some((item) => item.name === field)) errors.push(`${context}: field "${field}" is not declared by ${origin.name}.`);
      if (origin.type === "decision") errors.push(`${context}: use a decision's True/False connections, not its fields.`);
      if (target) {
        const ancestors = new Set<string>();
        function visit(id: string) {
          for (const edge of graph.edges.filter((edge) => edge.target === id)) {
            if (!ancestors.has(edge.source)) { ancestors.add(edge.source); visit(edge.source); }
          }
        }
        visit(target);
        if (source === target || !ancestors.has(source)) errors.push(`${context}: ${origin.name} must run before the node using its output.`);
      }
    }
    for (const node of graph.nodes) {
      if (node.type === "agent") {
        if (node.model !== undefined && !modelSchema.safeParse(node.model).success) errors.push(`${node.name}: enter a valid model ID or leave it unset.`);
        if (!node.prompt.trim()) errors.push(`${node.name}: enter a system prompt.`);
        if (node.output === "json" && !node.fields.length) errors.push(`${node.name}: define at least one output field.`);
        const names = new Set<string>();
        for (const field of node.fields) {
          if (!propertyName.safeParse(field.name).success) errors.push(`${node.name}: "${field.name}" is not a valid output field name.`);
          if (names.has(field.name)) errors.push(`${node.name}: output fields must have unique names.`);
          names.add(field.name);
        }
        const servers = mcpSchema.safeParse(node.mcpServers);
        if (!servers.success) errors.push(`${node.name}: ${servers.error.issues.map((issue) => issue.message).join("; ")}`);
      } else if (node.type === "decision") {
        referenceIsValid(node.condition.source, node.condition.field, node.id);
        errors.push(...conditionErrors(node.condition, graph).map((message) => `${node.name}: ${message}`));
        for (const branch of ["true", "false"]) {
          if (!graph.edges.some((edge) => edge.source === node.id && edge.branch === branch)) errors.push(`${node.name}: connect the ${branch} path.`);
        }
      } else {
        inspect(node.body, node.name || "Loop body");
        if (node.mode === "repeat") {
          if (!Number.isSafeInteger(node.maxIterations) || node.maxIterations < 1) errors.push(`${node.name}: enter a positive maximum iteration count.`);
          const output = node.body.nodes.find((item) => item.id === node.condition.source);
          if (node.condition.source !== "input" && !output) errors.push(`${node.name}: choose an output from its loop body.`);
          if (output && !outputFields(output).some((field) => field.name === node.condition.field)) errors.push(`${node.name}: choose a declared output field for the stop condition.`);
          if (output?.type === "decision") errors.push(`${node.name}: choose structured output, not a decision's fields.`);
          if (!node.condition.field.trim()) errors.push(`${node.name}: choose a stop-condition field.`);
          errors.push(...conditionErrors(node.condition, node.body).map((message) => `${node.name}: ${message}`));
        } else {
          referenceIsValid(node.collection.source, node.collection.field, node.id);
          const origin = byId.get(node.collection.source);
          const field = origin ? outputFields(origin).find((field) => field.name === node.collection.field) : undefined;
          if (field && field.type !== "array") errors.push(`${node.name}: the collection source must be an array field.`);
          if (!propertyName.safeParse(node.itemName).success || ["index", "previous", "upstream"].includes(node.itemName)) errors.push(`${node.name}: choose a valid item name other than index, previous, or upstream.`);
        }
      }
    }
  }
  inspect(workflow.graph, "Workflow");
  return [...new Set(errors)];
}

function conditionErrors(condition: Condition, graph: Graph): string[] {
  const errors: string[] = [];
  if (typeof condition.value === "number" && !Number.isFinite(condition.value)) {
    errors.push("Enter a finite number for the condition value.");
  }
  if (condition.field.split(".").some((part) => !part || ["__proto__", "constructor", "prototype"].includes(part))) {
    errors.push("Choose a valid condition field path.");
  }
  const source = graph.nodes.find((node) => node.id === condition.source);
  const field = source ? outputFields(source).find((item) => item.name === condition.field) : undefined;
  if (field && field.type !== typeof condition.value) errors.push("Condition values must match the source field's type.");
  if (["greater", "less"].includes(condition.operator) && typeof condition.value !== "number") errors.push("Numeric comparisons require a number.");
  if (condition.operator === "contains" && typeof condition.value !== "string") errors.push("Contains requires a text value.");
  return errors;
}

export function graphAt(workflow: Workflow, path: string[]): Graph {
  let graph = workflow.graph;
  for (const id of path) {
    const node = graph.nodes.find((node) => node.id === id);
    if (!node || node.type !== "loop") throw new Error("The loop body no longer exists.");
    graph = node.body;
  }
  return graph;
}

export function updateGraph(workflow: Workflow, path: string[], change: (graph: Graph) => Graph): Workflow {
  function update(graph: Graph, depth: number): Graph {
    if (depth === path.length) return change(graph);
    return { ...graph, nodes: graph.nodes.map((node) => node.id === path[depth] && node.type === "loop"
      ? { ...node, body: update(node.body, depth + 1) } : node) };
  }
  return { ...workflow, graph: update(workflow.graph, 0) };
}

export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newWorkflow(): Workflow {
  return { version: 1, id: newId(), name: "Untitled workflow", description: "Created with Blueprint", graph: { nodes: [], edges: [] } };
}

export function newNode(type: WorkflowNode["type"], position: BaseNode["position"]): WorkflowNode {
  const base = { id: newId(), name: type === "agent" ? "Agent" : type === "decision" ? "Decision" : "Loop", position };
  const condition: Condition = { source: "input", field: "", operator: "equals", value: true };
  if (type === "agent") return {
    ...base, type, prompt: "", task: "Perform your role using the workflow input and upstream results.",
    tools: ["read", "search"], mcpServers: {}, output: "text", fields: [],
  };
  if (type === "decision") return { ...base, type, condition };
  return {
    ...base, type, mode: "repeat", condition, maxIterations: 3,
    collection: { source: "input", field: "files" }, itemName: "currentFile", body: { nodes: [], edges: [] },
  };
}
