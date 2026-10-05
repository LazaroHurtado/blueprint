import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";
import ts from "typescript";
import { defineWorkflow, type WorkflowAgentOptions, type WorkflowContext, type WorkflowMeta } from "@github/copilot-sdk/extension";
import { exportWorkflow } from "./export.ts";
import { allowedServerTools, mcpSchema, newId, newNode, outputFields, parseWorkflow, planGraph, validateWorkflow, type AgentNode, type DecisionNode, type Graph, type Json, type LoopNode, type Workflow } from "./workflow.ts";

function agent(id: string, output: "text" | "json" = "text"): AgentNode {
  return {
    id, name: id, position: { x: 0, y: 0 }, type: "agent", prompt: `You are ${id}.`,
    task: "Use the provided input.", tools: ["read"], mcpServers: {}, output,
    fields: output === "json" ? [{ name: "passed", type: "boolean" }] : [],
  };
}
function document(graph: Graph): Workflow {
  return { version: 1, id: "test-workflow", name: "Test workflow", description: "A runnable check", graph };
}
function decision(id: string): DecisionNode {
  return {
    id, name: id, type: "decision", position: { x: 0, y: 0 },
    condition: { source: "input", field: id, operator: "equals", value: true },
  };
}
type Context = Pick<WorkflowContext, "args" | "signal" | "phase" | "agent">;
type Definition = { meta: WorkflowMeta; run: (context: Context) => Promise<Json> };
async function load(workflow: Workflow) {
  const source = exportWorkflow(workflow).find((file) => file.path.endsWith("/extension.mjs"))!.content;
  const registered: { definition?: Definition } = {};
  const sdk = new SyntheticModule(["defineWorkflow", "joinSession"], function () {
    this.setExport("defineWorkflow", (definition: Definition) => {
      registered.definition = definition;
      return defineWorkflow(definition);
    });
    this.setExport("joinSession", async () => undefined);
  });
  const module = new SourceTextModule(source);
  await module.link((specifier) => {
    assert.equal(specifier, "@github/copilot-sdk/extension");
    return sdk;
  });
  await module.evaluate();
  assert.ok(registered.definition);
  return registered.definition;
}
async function run(workflow: Workflow, args: Json, respond: (prompt: string, options: WorkflowAgentOptions) => unknown | Promise<unknown>, signal = new AbortController().signal) {
  const calls: { prompt: string; options: WorkflowAgentOptions }[] = [];
  const definition = await load(workflow);
  const result = await definition.run({
    args, signal, phase: () => undefined,
    agent: async (prompt, options = {}) => { calls.push({ prompt, options }); return respond(prompt, options); },
  });
  return { result, calls };
}
function repeat(maxIterations = 3): LoopNode {
  return {
    id: "repeat", name: "Repair", type: "loop", position: { x: 0, y: 0 }, mode: "repeat",
    condition: { source: "validate", field: "passed", operator: "equals", value: true }, maxIterations,
    collection: { source: "input", field: "files" }, itemName: "currentFile",
    body: { nodes: [agent("validate", "json")], edges: [] },
  };
}
function branching(): Workflow {
  return document({
    nodes: [
      agent("review", "json"),
      { id: "decision", name: "Decision", type: "decision", position: { x: 0, y: 0 }, condition: { source: "review", field: "passed", operator: "equals", value: true } },
      agent("fix"), agent("summary"),
    ],
    edges: [
      { id: "r-d", source: "review", target: "decision" },
      { id: "d-f", source: "decision", target: "fix", branch: "true" },
      { id: "d-s", source: "decision", target: "summary", branch: "false" },
      { id: "f-s", source: "fix", target: "summary" },
    ],
  });
}

test("export generates all files, escapes code, and round-trips the document", async () => {
  const node = agent("review");
  node.name = 'Review "quoted"';
  node.task = '"); throw new Error("injection"); //';
  node.mcpServers = { custom: { type: "local", command: "npx", args: ["-y", "example-server"], env: { TOKEN: "${TOKEN}" }, tools: ["*"] } };
  const workflow = document({ nodes: [node], edges: [] });
  const files = exportWorkflow(workflow);
  assert.equal(files.length, 4);
  assert.deepEqual(parseWorkflow(files.find((file) => file.path.endsWith("blueprint.json"))!.content), workflow);
  assert.match(files.find((file) => file.path.endsWith(".agent.md"))!.content, /mcp-servers:.*\$\{TOKEN\}/);
  const { result, calls } = await run(workflow, { task: "Inspect this" }, () => "done");
  assert.deepEqual(result, { review: "done" });
  assert.ok(calls[0].prompt.includes(node.task));
});

test("optional models persist and reach agent calls and profiles, including loop bodies", async () => {
  const first = agent("first");
  first.model = "model-a";
  const loop = repeat();
  const nested = loop.body.nodes[0];
  assert.ok(nested.type === "agent");
  nested.model = "model-b";
  const workflow = document({ nodes: [first, loop], edges: [] });
  const files = exportWorkflow(workflow);
  assert.deepEqual(parseWorkflow(files.find((file) => file.path.endsWith("blueprint.json"))!.content), workflow);
  assert.match(files.find((file) => file.path.endsWith("-first.agent.md"))!.content, /^model: "model-a"$/m);
  assert.match(files.find((file) => file.path.endsWith("-validate.agent.md"))!.content, /^model: "model-b"$/m);
  const { calls } = await run(workflow, {}, (_, options) => options.label?.endsWith("/first") ? "done" : { passed: true });
  assert.equal(calls.find((call) => call.options.label?.endsWith("/first"))?.options.model, "model-a");
  assert.equal(calls.find((call) => call.options.label?.endsWith("/validate"))?.options.model, "model-b");
});

test("old documents and cleared model overrides keep the configured Copilot defaults", async () => {
  const node = agent("default");
  const workflow = document({ nodes: [node], edges: [] });
  assert.deepEqual(parseWorkflow(JSON.stringify(workflow)), workflow);
  node.model = "model-a";
  delete node.model;
  const files = exportWorkflow(workflow);
  assert.doesNotMatch(files.find((file) => file.path.endsWith(".agent.md"))!.content, /^model:/m);
  assert.doesNotMatch(files.find((file) => file.path.endsWith("blueprint.json"))!.content, /"model":/);
  const { calls } = await run(workflow, {}, () => "done");
  assert.equal(Object.hasOwn(calls[0].options, "model"), false);
  node.model = "   ";
  assert.ok(validateWorkflow(workflow).some((error) => error.includes("model ID")));
  assert.throws(() => parseWorkflow(JSON.stringify(workflow)), /model ID/);
});

test("decisions skip the unchosen path and joins retain false-valued data", async () => {
  const { result, calls } = await run(branching(), {}, (_, options) => options.label?.endsWith("/review") ? { passed: false } : "summary");
  assert.deepEqual(result, { review: { passed: false }, decision: false, summary: "summary" });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].prompt.includes('"passed":false'));
  assert.ok(!calls.some((call) => call.options.label?.endsWith("/fix")));
});

test("decisions carry source data through the selected path", async () => {
  const { result, calls } = await run(branching(), {}, (_, options) => options.label?.endsWith("/review") ? { passed: true } : "done");
  assert.deepEqual(result, { review: { passed: true }, decision: true, fix: "done", summary: "done" });
  assert.ok(calls.find((call) => call.options.label?.endsWith("/fix"))?.prompt.includes('"passed":true'));
});

test("an unconditional dependency must not bypass a decision gate", async () => {
  const workflow = branching();
  workflow.graph.nodes.push(agent("shared"));
  workflow.graph.edges.push({ id: "shared-fix", source: "shared", target: "fix" });
  const { calls } = await run(workflow, {}, (_, options) => (
    options.label?.endsWith("/review") ? { passed: false } : "done"
  ));
  assert.equal(calls.some((call) => call.options.label?.endsWith("/fix")), false);
});

test("ordinary dependencies are all required and failures do not become skipped branches", async () => {
  const workflow = document({
    nodes: [agent("first"), agent("second"), agent("report")],
    edges: [{ id: "a", source: "first", target: "report" }, { id: "b", source: "second", target: "report" }],
  });
  assert.deepEqual(planGraph(workflow.graph).at(-1)?.activation, { all: [0, 1] });
  const { calls } = await run(workflow, {}, () => "done");
  const report = calls.find((call) => call.options.label?.endsWith("/report"));
  assert.ok(report?.prompt.includes('"name":"first"'));
  assert.ok(report?.prompt.includes('"name":"second"'));
  let reportRan = false;
  await assert.rejects(run(workflow, {}, (_, options) => {
    if (options.label?.endsWith("/report")) reportRan = true;
    return options.label?.endsWith("/second") ? null : "done";
  }), /agent failed/);
  assert.equal(reportRan, false);
});

test("shared prerequisites cannot bypass inherited gates or alternative joins", async () => {
  const workflow = branching();
  workflow.graph.nodes.push(agent("shared"), agent("followup"));
  workflow.graph.edges = workflow.graph.edges.filter((edge) => edge.id !== "f-s");
  workflow.graph.edges.push(
    { id: "shared-fix", source: "shared", target: "fix" },
    { id: "fix-followup", source: "fix", target: "followup" },
    { id: "shared-followup", source: "shared", target: "followup" },
    { id: "followup-summary", source: "followup", target: "summary" },
    { id: "shared-summary", source: "shared", target: "summary" },
  );
  for (const passed of [false, true]) {
    const { calls } = await run(workflow, {}, (_, options) => options.label?.endsWith("/review") ? { passed } : "done");
    for (const name of ["fix", "followup"]) {
      assert.equal(calls.some((call) => call.options.label?.endsWith(`/${name}`)), passed);
    }
    assert.equal(calls.filter((call) => call.options.label?.endsWith("/summary")).length, 1);
  }
});

test("multiple tasks on a chosen branch remain required before a complementary merge", async () => {
  const workflow = document({
    nodes: [decision("gate"), agent("yes-a"), agent("yes-b"), agent("no"), agent("summary")],
    edges: [
      { id: "a", source: "gate", target: "yes-a", branch: "true" },
      { id: "b", source: "gate", target: "yes-b", branch: "true" },
      { id: "c", source: "gate", target: "no", branch: "false" },
      { id: "d", source: "yes-a", target: "summary" },
      { id: "e", source: "yes-b", target: "summary" },
      { id: "f", source: "no", target: "summary" },
    ],
  });
  assert.deepEqual(planGraph(workflow.graph).at(-1)?.activation, {
    all: [{ any: [{ all: [0, 1] }, { all: [2] }] }],
  });
  for (const gate of [false, true]) {
    const { calls } = await run(workflow, { gate }, () => "done");
    const summary = calls.find((call) => call.options.label?.endsWith("/summary"));
    assert.ok(summary);
    assert.equal(summary.prompt.includes('"name":"yes-a"'), gate);
    assert.equal(summary.prompt.includes('"name":"yes-b"'), gate);
    assert.equal(summary.prompt.includes('"name":"no"'), !gate);
  }
});

function nestedBranches(): Workflow {
  return document({
    nodes: [
      decision("outer"), decision("inner"), agent("shared"),
      agent("inner-yes"), agent("inner-no"), agent("inner-merge"), agent("summary"),
    ],
    edges: [
      { id: "a", source: "outer", target: "inner", branch: "true" },
      { id: "b", source: "outer", target: "summary", branch: "false" },
      { id: "c", source: "inner", target: "inner-yes", branch: "true" },
      { id: "d", source: "inner", target: "inner-no", branch: "false" },
      { id: "e", source: "shared", target: "inner-yes" },
      { id: "f", source: "inner-yes", target: "inner-merge" },
      { id: "g", source: "inner-no", target: "inner-merge" },
      { id: "h", source: "inner-merge", target: "summary" },
    ],
  });
}

test("properly nested decisions preserve gates and merge once for every choice", async () => {
  for (const outer of [false, true]) for (const inner of [false, true]) {
    const workflow = nestedBranches();
    assert.deepEqual(validateWorkflow(workflow), []);
    const { calls } = await run(workflow, { outer, inner }, () => "done");
    const ran = (name: string) => calls.some((call) => call.options.label?.endsWith(`/${name}`));
    assert.equal(ran("inner-yes"), outer && inner);
    assert.equal(ran("inner-no"), outer && !inner);
    assert.equal(ran("inner-merge"), outer);
    assert.equal(calls.filter((call) => call.options.label?.endsWith("/summary")).length, 1);
  }
});

test("unrelated conditional inputs and unfinished inner merges fail export with actionable errors", () => {
  const unrelated = document({
    nodes: [decision("a"), decision("b"), agent("publish"), agent("skip-a"), agent("skip-b")],
    edges: [
      { id: "a-t", source: "a", target: "publish", branch: "true" },
      { id: "b-t", source: "b", target: "publish", branch: "true" },
      { id: "a-f", source: "a", target: "skip-a", branch: "false" },
      { id: "b-f", source: "b", target: "skip-b", branch: "false" },
    ],
  });
  assert.throws(() => exportWorkflow(unrelated), /publish: inputs from unrelated decisions "a" and "b"/);
  const unfinished = nestedBranches();
  unfinished.graph.edges = unfinished.graph.edges.filter((edge) => edge.id !== "h");
  unfinished.graph.edges.push({ id: "shortcut", source: "inner-yes", target: "summary" });
  assert.throws(() => exportWorkflow(unfinished), /complete both branches of "inner" before merging "outer"/);
});

test("branch planning stays within each loop body", async () => {
  const each: LoopNode = {
    ...repeat(), id: "each", mode: "each", body: nestedBranches().graph,
  };
  const { calls } = await run(document({ nodes: [each], edges: [] }), {
    files: ["a", "b"], outer: true, inner: false,
  }, () => "done");
  assert.equal(calls.filter((call) => call.options.label?.endsWith("/summary")).length, 2);
  assert.equal(calls.some((call) => call.options.label?.endsWith("/inner-yes")), false);
});
test("unfinished numeric conditions cannot silently serialize as null", () => {
  const workflow = branching();
  const decision = workflow.graph.nodes.find((node) => node.type === "decision");
  assert.ok(decision);
  decision.condition = { source: "input", field: "score", operator: "equals", value: Number.NaN };
  assert.ok(validateWorkflow(workflow).some((error) => error.includes("finite number")));
  assert.throws(() => exportWorkflow(workflow), /finite number/);
});

test("a root decision activates a branch even without upstream payload", async () => {
  const workflow = branching();
  workflow.graph.nodes = workflow.graph.nodes.filter((node) => node.id !== "review");
  const decision = workflow.graph.nodes.find((node) => node.type === "decision");
  assert.ok(decision?.type === "decision");
  decision.condition = { source: "input", field: "approved", operator: "equals", value: false };
  workflow.graph.edges = workflow.graph.edges.filter((edge) => edge.id !== "r-d");
  const { result } = await run(workflow, { approved: false }, () => "done");
  assert.deepEqual(result, { decision: true, fix: "done", summary: "done" });
});

test("repeat loops use unique, replay-stable labels and previous results", async () => {
  const workflow = document({ nodes: [repeat()], edges: [] });
  let count = 0;
  const first = await run(workflow, {}, () => ({ passed: ++count === 2 }));
  assert.deepEqual(first.result, { repeat: { iterations: 2, results: { validate: { passed: true } } } });
  assert.notEqual(first.calls[0].options.label, first.calls[1].options.label);
  assert.ok(first.calls[1].prompt.includes('"previous":{"validate":{"passed":false}}'));
  count = 0;
  const replay = await run(workflow, {}, () => ({ passed: ++count === 2 }));
  assert.deepEqual(first.calls.map((call) => call.options.label), replay.calls.map((call) => call.options.label));
});

test("exhausted caps, missing fields, null agents, and invalid output types fail explicitly", async () => {
  await assert.rejects(run(document({ nodes: [repeat(2)], edges: [] }), {}, () => ({ passed: false })), /maximum iteration count/);
  await assert.rejects(run(branching(), {}, () => null), /agent failed/);
  await assert.rejects(run(branching(), {}, () => ({ passed: "true" })), /invalid output field/);
  const workflow = document({
    nodes: [{ id: "choice", name: "Choice", type: "decision", position: { x: 0, y: 0 }, condition: { source: "input", field: "missing", operator: "equals", value: true } }, agent("yes"), agent("no")],
    edges: [{ id: "yes-edge", source: "choice", target: "yes", branch: "true" }, { id: "no-edge", source: "choice", target: "no", branch: "false" }],
  });
  await assert.rejects(run(workflow, {}, () => "done"), /Required field is missing/);
});

test("for-each processes items sequentially, preserves order, and supports nested repeat bodies", async () => {
  const each: LoopNode = { ...repeat(), id: "each", name: "Each", mode: "each", body: { nodes: [agent("inspect")], edges: [] } };
  const { result, calls } = await run(document({ nodes: [each], edges: [] }), { files: ["a", "b"] }, (prompt) => prompt.includes('"currentFile":"a"') ? "first" : "second");
  assert.deepEqual(result, { each: { items: [{ inspect: "first" }, { inspect: "second" }] } });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].options.label?.includes("/each/0/inspect"));
  assert.ok(calls[1].options.label?.includes("/each/1/inspect"));
  each.body = { nodes: [repeat()], edges: [] };
  const nested = await run(document({ nodes: [each], edges: [] }), { files: ["a"] }, () => ({ passed: true }));
  assert.deepEqual(nested.result, { each: { items: [{ repeat: { iterations: 1, results: { validate: { passed: true } } } }] } });
  await assert.rejects(run(document({ nodes: [each], edges: [] }), { files: "not an array" }, () => ({ passed: true })), /collection must be an array/);
});

test("zero and empty arrays are valid values, not failure-shaped defaults", async () => {
  const node = agent("numbers", "json");
  node.fields = [{ name: "count", type: "number" }, { name: "items", type: "array" }];
  const response = { count: 0, items: [] };
  const { result } = await run(document({ nodes: [node], edges: [] }), {}, () => response);
  assert.deepEqual(result, { numbers: response });
});

test("array outputs feed loops and readable loop fields match generated data paths", async () => {
  const producer = agent("producer", "json");
  producer.fields = [{ name: "files", type: "array" }];
  const each: LoopNode = {
    ...repeat(), id: "each", mode: "each", collection: { source: "producer", field: "files" },
    body: { nodes: [agent("inspect")], edges: [] },
  };
  const workflow = document({ nodes: [producer, each], edges: [{ id: "producer-each", source: "producer", target: "each" }] });
  const { result } = await run(workflow, {}, (_, options) => options.label?.endsWith("/producer") ? { files: ["one"] } : "done");
  assert.deepEqual(result, { producer: { files: ["one"] }, each: { items: [{ inspect: "done" }] } });
  assert.ok(outputFields(each).some((field) => field.name === "items.length" && field.type === "number"));
  assert.ok(outputFields(repeat()).some((field) => field.name === "results.validate.passed" && field.label === "validate · passed"));
  assert.ok(outputFields(producer).some((field) => field.name === "files.length"));
});

test("cancellation stops a run before agents execute", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(run(document({ nodes: [agent("review")], edges: [] }), {}, () => { called = true; return "done"; }, controller.signal), /abort/i);
  assert.equal(called, false);
});

test("MCP settings preserve the intersection of server and agent tool restrictions", () => {
  const server = { type: "local" as const, command: "tool", args: [], env: {}, tools: ["*"] };
  assert.deepEqual(allowedServerTools("custom", server, ["read"]), []);
  assert.deepEqual(allowedServerTools("custom", server, ["read", "custom/lookup"]), ["lookup"]);
  assert.deepEqual(allowedServerTools("custom", { ...server, tools: ["lookup"] }, ["custom/*"]), ["lookup"]);
  assert.deepEqual(allowedServerTools("custom", { ...server, tools: ["lookup"] }, ["custom/write"]), []);
  assert.deepEqual(allowedServerTools("custom", { ...server, tools: [] }, ["*"]), []);
});

test("MCP tool lists normalize only when their draft configuration is parsed", () => {
  const result = mcpSchema.parse({
    docs: { type: "local", command: "server", args: [], env: {}, tools: ["lookup", " write", ""] },
  });
  assert.deepEqual(result.docs.tools, ["lookup", "write"]);
});

test("export rejects agent paths that collide on macOS filesystems", () => {
  const workflow = document({ nodes: [agent("Review"), agent("review")], edges: [] });
  assert.throws(() => exportWorkflow(workflow), /case-insensitive/);
});

test("invalid graphs and unsafe imports are rejected without evaluating source", () => {
  const workflow = branching();
  workflow.graph.edges.push({ id: "cycle", source: "summary", target: "review" });
  assert.ok(validateWorkflow(workflow).some((error) => error.includes("cycles")));
  assert.throws(() => exportWorkflow(workflow), /cycles/);
  assert.throws(() => parseWorkflow('{"version":2}'), /version/);
  assert.throws(() => parseWorkflow(JSON.stringify(document({ nodes: [agent("duplicate"), agent("duplicate")], edges: [] }))), /unique ID/);
  assert.throws(() => parseWorkflow(JSON.stringify(document({ nodes: [agent("__proto__")], edges: [] }))), /Reserved identifier/);
  const invalid = repeat(0);
  assert.ok(validateWorkflow(document({ nodes: [invalid], edges: [] })).some((error) => error.includes("positive")));
  invalid.maxIterations = 1;
  invalid.condition.field = "__proto__.passed";
  assert.throws(() => exportWorkflow(document({ nodes: [invalid], edges: [] })), /valid condition field/);
  const secret = agent("secret");
  secret.mcpServers = { bad: { type: "local", command: "tool", args: [], env: { TOKEN: "literal credential" }, tools: ["*"] } };
  assert.throws(() => exportWorkflow(document({ nodes: [secret], edges: [] })), /reference/);
  assert.equal(newNode("loop", { x: 0, y: 0 }).type, "loop");
  assert.match(newId(), /^[0-9a-f]{32}$/);
  assert.notEqual(newId(), newId());
});

test("generated TypeScript checks against the actual experimental SDK declarations", async () => {
  const workflow = branching();
  const loop = repeat();
  const nested = loop.body.nodes[0];
  assert.ok(nested.type === "agent");
  nested.model = "model-for-typecheck";
  workflow.graph.nodes.push(loop);
  workflow.graph.nodes.push({ ...repeat(), id: "each", mode: "each", body: { nodes: [{ ...repeat(), id: "nested", body: { nodes: [agent("nested-validate", "json")], edges: [] }, condition: { source: "nested-validate", field: "passed", operator: "equals", value: true } }], edges: [] } });
  const directory = await mkdtemp(join(tmpdir(), "blueprint-types-"));
  try {
    const file = join(directory, "workflow.ts");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(file, exportWorkflow(workflow).find((entry) => entry.path.endsWith("/workflow.ts"))!.content);
    const sdkTypes = fileURLToPath(import.meta.resolve("@github/copilot-sdk/extension")).replace(/\.js$/, ".d.ts");
    const program = ts.createProgram([file], {
      strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      paths: { "@github/copilot-sdk/extension": [sdkTypes] },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => directory, getCanonicalFileName: (name) => name, getNewLine: () => "\n",
    }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
