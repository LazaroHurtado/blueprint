import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { newNode, newWorkflow, parseWorkflow } from "./workflow.ts";
import { exportWorkflow } from "./export.ts";

let native = true;
let response: unknown;
const calls: { command: string; arguments: unknown }[] = [];
mock.module("@tauri-apps/api/core", { namedExports: {
  isTauri: () => native,
  invoke: async (command: string, args: unknown) => {
    calls.push({ command, arguments: args });
    if (response instanceof Error) throw response;
    return response;
  },
} });
let picked: string | null | Error = null;
const folderDialogs: unknown[] = [];
let fileText = "";
mock.module("@tauri-apps/plugin-dialog", { namedExports: {
  open: async (options: unknown) => {
    folderDialogs.push(options);
    if (picked instanceof Error) throw picked;
    return picked;
  },
  save: async () => {
    if (picked instanceof Error) throw picked;
    return picked;
  },
} });
mock.module("@tauri-apps/plugin-fs", { namedExports: {
  lstat: async () => ({ size: Buffer.byteLength(fileText) }),
  readTextFile: async () => fileText,
} });
const { chooseDraftFile, chooseFolder, createWorkflow, openWorkflow, recoverSaves, saveDraft, saveExport } = await import("./files.ts");

test("new desktop workflows require a folder and export their .github files there", async () => {
  const commands = calls.length;
  picked = null;
  assert.equal(await createWorkflow(), null);
  picked = new Error("Folder picker failed");
  await assert.rejects(createWorkflow(), /Folder picker failed/);
  picked = "/chosen/project";
  const document = await createWorkflow();
  assert.ok(document);
  assert.equal(document.folder, picked);
  assert.deepEqual(folderDialogs.at(-1), {
    title: "Choose the folder that will contain the workflow's .github files",
    directory: true, multiple: false, recursive: true,
  });
  assert.equal(document.workflow.graph.nodes.length, 0);
  assert.equal(calls.length, commands);
  const agent = newNode("agent", { x: 0, y: 0 });
  assert.ok(agent.type === "agent");
  agent.prompt = "Review the supplied task.";
  document.workflow.graph.nodes.push(agent);
  const files = exportWorkflow(document.workflow);
  assert.ok(files.some((file) => file.path.startsWith(".github/extensions/") && file.path.endsWith("/extension.mjs")));
  assert.ok(files.every((file) => file.path.startsWith(".github/")));
  response = { saved: true, recovered: null };
  await saveExport(document.folder, files);
  assert.deepEqual(calls.at(-1), { command: "save_export", arguments: { root: picked, files } });
});

test("browser preview still creates workflows without a native folder picker or writes", async () => {
  native = false;
  const dialogs = folderDialogs.length;
  const commands = calls.length;
  try {
    const document = await createWorkflow();
    assert.ok(document);
    assert.equal(document.folder, "");
    assert.equal(document.workflow.graph.nodes.length, 0);
    assert.equal(folderDialogs.length, dialogs);
    assert.equal(calls.length, commands);
  } finally { native = true; }
});

test("exports use the native transaction command and preserve cancellation/recovery results", async () => {
  const files = [{ path: ".github/agents/one.agent.md", content: "new one" }];
  response = { saved: true, recovered: "Restored a prior save." };
  assert.deepEqual(await saveExport("/chosen/root", files), response);
  assert.deepEqual(calls.at(-1), { command: "save_export", arguments: { root: "/chosen/root", files } });
  response = { saved: false, recovered: null };
  assert.deepEqual(await saveExport("/chosen/root", files), response);
  response = new Error("Recovery conflict");
  await assert.rejects(saveExport("/chosen/root", files), /Recovery conflict/);
});

test("startup recovery surfaces native errors and is not invoked in a browser preview", async () => {
  response = "Previous export restored.";
  assert.equal(await recoverSaves(), response);
  assert.equal(calls.at(-1)?.command, "recover_saves");
  response = new Error("Journal is unreadable");
  await assert.rejects(recoverSaves(), /Journal is unreadable/);
  native = false;
  const count = calls.length;
  assert.equal(await recoverSaves(), null);
  assert.equal(calls.length, count);
  await assert.rejects(saveExport("/root", []), /desktop app/);
  await assert.rejects(chooseFolder(), /desktop app/);
  native = true;
});

test("native open accepts documents and handles cancellation and malformed input", async () => {
  picked = null;
  assert.equal(await openWorkflow(), null);
  picked = "/chosen/blueprint.json";
  const workflow = newWorkflow();
  fileText = JSON.stringify(workflow);
  assert.deepEqual(await openWorkflow(), workflow);
  fileText = "{}";
  await assert.rejects(openWorkflow(), /version/);
});

test("draft saving uses one native JSON target without executable exports", async () => {
  picked = "/chosen/my.blueprint.json";
  assert.equal(await chooseDraftFile("My workflow"), picked);
  const document = newWorkflow();
  document.graph.nodes.push(newNode("agent", { x: 0, y: 0 }));
  response = { saved: true, recovered: null };
  assert.deepEqual(await saveDraft(picked, document), response);
  const call = calls.at(-1);
  assert.equal(call?.command, "save_draft");
  assert.ok(call?.arguments && typeof call.arguments === "object" && "content" in call.arguments);
  assert.equal(typeof call.arguments.content, "string");
  assert.deepEqual(parseWorkflow(String(call.arguments.content)), document);
  native = false;
  await assert.rejects(saveDraft(picked, document), /desktop app/);
  await assert.rejects(chooseDraftFile("My workflow"), /desktop app/);
  native = true;
});
