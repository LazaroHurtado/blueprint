import {
  nodesIn, parseWorkflow, planGraph, slug, validateWorkflow,
  type ActivationRule, type AgentNode, type Condition, type Graph, type Workflow,
} from "./workflow.ts";

export type ExportFile = { path: string; content: string };
const quote = (value: unknown) => JSON.stringify(value);

function agentName(workflow: Workflow, agent: AgentNode): string {
  return `${slug(workflow.name)}-${workflow.id.slice(0, 16)}-${agent.id}`;
}

function helpers(typed: boolean): string {
  const type = (value: string) => typed ? value : "";
  return `
${typed ? "type Step = { active: boolean; value: JsonValue; carried?: JsonValue[] };" : ""}
function json(value${type(": unknown")})${type(": JsonValue")} {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)]));
  }
  throw new Error("A workflow value is not JSON-serializable.");
}
function record(value${type(": unknown")})${type(": { [key: string]: JsonValue }")} {
  const parsed = json(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workflow inputs and structured outputs must be objects.");
  }
  return parsed;
}
function field(value${type(": unknown")}, path${type(": string")})${type(": unknown")} {
  let current${type(": unknown")} = value;
  for (const key of path.split(".")) {
    if (!key || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid field path.");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) {
      throw new Error("Required field is missing: " + path);
    }
    current = Object.getOwnPropertyDescriptor(current, key)?.value;
  }
  return current;
}
function compare(value${type(": unknown")}, operator${type(": string")}, expected${type(": unknown")})${type(": boolean")} {
  if (typeof value !== typeof expected) throw new Error("Condition value types do not match.");
  if (operator === "equals") return value === expected;
  if (operator === "notEquals") return value !== expected;
  if (operator === "contains" && typeof value === "string" && typeof expected === "string") return value.includes(expected);
  if (typeof value === "number" && typeof expected === "number") {
    if (operator === "greater") return value > expected;
    if (operator === "less") return value < expected;
  }
  throw new Error("Condition operator is incompatible with its values.");
}
function structured(value${type(": unknown")}, fields${type(": Array<{ name: string; type: string }>")}) {
  const output = record(value);
  for (const item of fields) {
    const actual = output[item.name];
    const matches = item.type === "array" ? Array.isArray(actual)
      : item.type === "object" ? actual !== null && typeof actual === "object" && !Array.isArray(actual)
      : typeof actual === item.type;
    if (!Object.hasOwn(output, item.name) || !matches) {
      throw new Error("Agent returned an invalid output field: " + item.name);
    }
  }
  return output;
}
`;
}

function sourceCode(workflow: Workflow, typed: boolean): string {
  let counter = 0;
  const annotation = (text: string) => typed ? text : "";
  function conditionCode(condition: Condition, input: string, variables: Map<string, string>): string {
    const source = condition.source === "input" ? input : `(await ${variables.get(condition.source)}).value`;
    return `compare(field(${source}, ${quote(condition.field)}), ${quote(condition.operator)}, ${quote(condition.value)})`;
  }
  function activationCode(rule: ActivationRule): string {
    if (typeof rule === "number") return `activeParents[${rule}]`;
    const all = "all" in rule;
    const terms = all ? rule.all : rule.any;
    if (!terms.length) return all ? "true" : "false";
    return `(${terms.map(activationCode).join(all ? " && " : " || ")})`;
  }
  function compileGraph(graph: Graph, input: string, path: string): { code: string; output: string; variables: Map<string, string> } {
    const variables = new Map<string, string>();
    const lines: string[] = [];
    for (const { node, incoming: edges, activation } of planGraph(graph)) {
      const variable = `step${counter++}`;
      variables.set(node.id, variable);
      lines.push(`const ${variable}${annotation(": Promise<Step>")} = (async () => {`);
      lines.push("ctx.signal.throwIfAborted();");
      lines.push(`const parents = await Promise.all([${edges.map((edge) => variables.get(edge.source)).join(", ")}]);`);
      lines.push(`const activeParents = [${edges.map((edge, index) => `parents[${index}].active${edge.branch ? ` && parents[${index}].value === ${edge.branch}` : ""}`).join(", ")}];`);
      const incoming = edges.map((edge, index) => {
        const origin = graph.nodes.find((item) => item.id === edge.source)!;
        const values = origin.type === "decision" ? `(parents[${index}].carried || [])`
          : `[{ id: ${quote(origin.id)}, name: ${quote(origin.name)}, value: parents[${index}].value }]`;
        return `...(activeParents[${index}] ? ${values} : [])`;
      });
      lines.push(`const incoming${annotation(": JsonValue[]")} = [${incoming.join(", ")}];`);
      if (edges.length) lines.push(`if (!${activationCode(activation)}) return { active: false, value: null };`);
      const label = `${path} + ${quote(`/${node.id}`)}`;
      if (node.type === "agent") {
        const options = {
          agent: agentName(workflow, node),
          ...(node.model ? { model: node.model } : {}),
          ...(node.output === "json" ? {
            schema: {
              type: "object", required: node.fields.map((item) => item.name),
              properties: Object.fromEntries(node.fields.map((item) => [item.name, { type: item.type }])),
            },
          } : {}),
        };
        lines.push(`const result = await ctx.agent(${quote(node.task)} + "\\n\\nWorkflow input:\\n" + JSON.stringify(${input}) + "\\n\\nUpstream results:\\n" + JSON.stringify(incoming), { ...${quote(options)}, label: ${label} });`);
        lines.push(`if (result === null || result === undefined) throw new Error(${quote(`${node.name}: agent failed or returned no result.`)});`);
        if (node.output === "text") {
          lines.push(`if (typeof result !== "string") throw new Error(${quote(`${node.name}: expected a text response.`)});`);
          lines.push("return { active: true, value: result };");
        } else {
          lines.push(`return { active: true, value: structured(result, ${quote(node.fields)}) };`);
        }
      } else if (node.type === "decision") {
        lines.push(`return { active: true, value: ${conditionCode(node.condition, input, variables)}, carried: incoming };`);
      } else {
        const iterationInput = `input${counter++}`;
        const iterationPath = `path${counter++}`;
        const body = compileGraph(node.body, iterationInput, iterationPath);
        if (node.mode === "repeat") {
          lines.push(`let previous${annotation(": JsonValue")} = null;`);
          lines.push(`for (let index = 0; index < ${node.maxIterations}; index++) {`);
          lines.push("ctx.signal.throwIfAborted();");
          lines.push(`const ${iterationInput} = { ...${input}, upstream: incoming, previous, index };`);
          lines.push(`const ${iterationPath} = ${label} + "/" + index;`);
          lines.push(body.code);
          lines.push(`if (${conditionCode(node.condition, iterationInput, body.variables)}) return { active: true, value: { iterations: index + 1, results: ${body.output} } };`);
          lines.push(`previous = ${body.output};`);
          lines.push("}");
          lines.push(`throw new Error(${quote(`${node.name}: maximum iteration count (${node.maxIterations}) reached without satisfying the stop condition.`)});`);
        } else {
          // ponytail: full input per item; add explicit projections if large collections inflate prompts.
          const source = node.collection.source === "input" ? input : `(await ${variables.get(node.collection.source)}).value`;
          lines.push(`const items = field(${source}, ${quote(node.collection.field)});`);
          lines.push(`if (!Array.isArray(items)) throw new Error(${quote(`${node.name}: collection must be an array.`)});`);
          lines.push(`const results${annotation(": JsonValue[]")} = [];`);
          lines.push("for (let index = 0; index < items.length; index++) {");
          lines.push("ctx.signal.throwIfAborted();");
          lines.push(`const ${iterationInput} = { ...${input}, upstream: incoming, ${quote(node.itemName)}: json(items[index]), index };`);
          lines.push(`const ${iterationPath} = ${label} + "/" + index;`);
          lines.push(body.code);
          lines.push(`results.push(${body.output});`);
          lines.push("}");
          lines.push("return { active: true, value: { items: results } };");
        }
      }
      lines.push("})();");
    }
    const settled = `settled${counter++}`;
    const output = `outputs${counter++}`;
    lines.push(`const ${settled} = await Promise.all([${graph.nodes.map((node) => variables.get(node.id)).join(", ")}]);`);
    lines.push(`const ${output}${annotation(": { [key: string]: JsonValue }")} = {};`);
    graph.nodes.forEach((node, index) => {
      lines.push(`if (${settled}[${index}].active) ${output}[${quote(node.id)}] = ${settled}[${index}].value;`);
    });
    return { code: lines.join("\n"), output, variables };
  }
  const graph = compileGraph(workflow.graph, "input", quote(workflow.id));
  const meta = {
    name: slug(workflow.name), description: workflow.description || workflow.name,
    phases: [{ title: "Run workflow" }], argsSchema: { type: "object" },
  };
  return `// Generated by Blueprint. Edit blueprint.json in Blueprint to regenerate.
import { defineWorkflow, joinSession${typed ? ", type JsonValue" : ""} } from "@github/copilot-sdk/extension";
${helpers(typed)}
const workflow = defineWorkflow({
  meta: ${JSON.stringify(meta, null, 2)},
  run: async (ctx) => {
    ctx.phase("Run workflow");
    const input = record(ctx.args);
${graph.code.split("\n").map((line) => `    ${line}`).join("\n")}
    return ${graph.output};
  },
});
await joinSession({ workflows: [workflow] });
`;
}

export function exportWorkflow(document: Workflow): ExportFile[] {
  const errors = validateWorkflow(document);
  if (errors.length) throw new Error(errors.join("\n"));
  const workflow = parseWorkflow(JSON.stringify(document));
  const directory = `.github/extensions/${slug(workflow.name)}`;
  const files: ExportFile[] = [
    { path: `${directory}/blueprint.json`, content: `${JSON.stringify(workflow, null, 2)}\n` },
    { path: `${directory}/extension.mjs`, content: sourceCode(workflow, false) },
    { path: `${directory}/workflow.ts`, content: sourceCode(workflow, true) },
  ];
  for (const node of nodesIn(workflow.graph)) {
    if (node.type !== "agent") continue;
    const name = agentName(workflow, node);
    const frontmatter = [
      `name: ${quote(name)}`,
      `description: ${quote(`Blueprint agent: ${node.name}`)}`,
      ...(node.model ? [`model: ${quote(node.model)}`] : []),
      `tools: ${quote(node.tools)}`,
      ...(Object.keys(node.mcpServers).length ? [`mcp-servers: ${quote(node.mcpServers)}`] : []),
    ].join("\n");
    files.push({ path: `.github/agents/${name}.agent.md`, content: `---\n${frontmatter}\n---\n\n${node.prompt}\n` });
  }
  return files;
}
