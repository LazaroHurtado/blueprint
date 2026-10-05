import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
const sourceNotices = [
  "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/README.md", "licenses/copilot-cli-1.0.90.txt",
  "licenses/copilot-sdk-MIT.txt", "licenses/tauri-MIT.txt",
  "licenses/copilot-runtime-adm-zip-MIT.txt", "licenses/copilot-runtime-webview-MIT.txt",
];
export const noticeInputs = [
  "package-lock.json", "src-tauri/Cargo.lock", "src-tauri/Cargo.toml", "rust-toolchain.toml", "about.toml",
  "scripts/licenses.hbs", "scripts/generate-notices.mjs", "scripts/check-notices.mjs",
  ...sourceNotices,
];
export const noticeOutputs = ["licenses/generated/npm.txt", "licenses/generated/rust.txt"];
export const noticeManifest = "licenses/generated/manifest.json";
export const distributionNotices = [...sourceNotices, ...noticeOutputs, noticeManifest];

export async function hashes(paths, directory = root) {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path, createHash("sha256").update(await readFile(resolve(directory, path))).digest("hex"),
  ])));
}

export async function checkNotices(directory = root) {
  const manifest = JSON.parse(await readFile(resolve(directory, noticeManifest), "utf8"));
  if (manifest.version !== 1 || manifest.generator !== "cargo-about 0.9.2" ||
      manifest.copilotSdk !== "1.0.16" || manifest.copilotRuntime !== "1.0.90") {
    throw new Error("Notice manifest does not match the pinned release toolchain.");
  }
  for (const [field, paths] of [["inputs", noticeInputs], ["outputs", noticeOutputs]]) {
    const actual = await hashes(paths, directory);
    if (Object.keys(manifest[field] || {}).length !== paths.length ||
        paths.some((path) => manifest[field]?.[path] !== actual[path])) {
      throw new Error(`Dependency notices are stale or modified (${field}). Run npm run notices.`);
    }
  }
  async function checkDirectory(path) {
    for (const item of await readdir(resolve(directory, path), { withFileTypes: true })) {
      const relative = `${path}/${item.name}`;
      if (item.isDirectory() && relative === "licenses/generated") await checkDirectory(relative);
      else if (!item.isFile() || !distributionNotices.includes(relative)) {
        throw new Error(`Unexpected licensing resource ${relative}; do not bundle local files or symlinks.`);
      }
    }
  }
  await checkDirectory("licenses");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkNotices(); console.log("Distribution notices are current."); }
  catch (error) {
    console.error(`Cannot package Blueprint: ${error.message}\nRun npm run notices before building an installer.`);
    process.exitCode = 1;
  }
}
