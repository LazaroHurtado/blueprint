import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { newNode, newWorkflow, parseWorkflow } from "./workflow.ts";

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
let picked: string | null = null;
let fileText = "";
mock.module("@tauri-apps/plugin-dialog", { namedExports: { open: async () => picked, save: async () => picked } });
mock.module("@tauri-apps/plugin-fs", { namedExports: {
  lstat: async () => ({ size: Buffer.byteLength(fileText) }),
  readTextFile: async () => fileText,
} });
const { chooseDraftFile, chooseFolder, openWorkflow, recoverSaves, saveDraft, saveExport } = await import("./files.ts");

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
