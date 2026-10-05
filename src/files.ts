import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { lstat, readTextFile } from "@tauri-apps/plugin-fs";
import { parseWorkflow, serializeDraft, slug, type Workflow } from "./workflow.ts";
import type { ExportFile } from "./export.ts";

export type SaveResult = { saved: boolean; recovered: string | null };

export async function openWorkflow(): Promise<Workflow | null> {
  const path = await open({
    title: "Open Blueprint workflow", multiple: false,
    filters: [{ name: "Blueprint document", extensions: ["json"] }],
  });
  if (path === null) return null;
  if ((await lstat(path)).size > 5 * 1024 * 1024) throw new Error("Blueprint documents must be smaller than 5 MB.");
  return parseWorkflow(await readTextFile(path));
}

export async function chooseFolder(): Promise<string | null> {
  if (!isTauri()) throw new Error("Native folder selection requires the desktop app. Run npm run tauri dev.");
  return open({ title: "Choose a repository or export folder", directory: true, multiple: false, recursive: true });
}

export async function recoverSaves(): Promise<string | null> {
  return isTauri() ? invoke<string | null>("recover_saves") : null;
}

export async function chooseDraftFile(name: string): Promise<string | null> {
  if (!isTauri()) throw new Error("Native file selection requires the desktop app. Run npm run tauri dev.");
  return save({
    title: "Save Blueprint draft",
    defaultPath: `${slug(name) || "workflow"}.blueprint.json`,
    filters: [{ name: "Blueprint document", extensions: ["json"] }],
  });
}

export async function saveDraft(path: string, workflow: Workflow): Promise<SaveResult> {
  if (!isTauri()) throw new Error("Saving requires the desktop app. Run npm run tauri dev.");
  const content = serializeDraft(workflow);
  parseWorkflow(content);
  return invoke<SaveResult>("save_draft", { path, content });
}

export async function saveExport(root: string, files: ExportFile[]): Promise<SaveResult> {
  if (!isTauri()) throw new Error("Saving requires the desktop app. Run npm run tauri dev.");
  return invoke<SaveResult>("save_export", { root, files });
}
