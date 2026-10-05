import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashes, noticeInputs, noticeManifest, noticeOutputs, root } from "./check-notices.mjs";

process.chdir(root);
const version = execFileSync("cargo", ["about", "--version"], { encoding: "utf8" }).trim();
if (version !== "cargo-about 0.9.2") throw new Error("Install cargo-about 0.9.2 with --locked --features cli.");
const metadata = JSON.parse(execFileSync("cargo", [
  "metadata", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--format-version", "1",
], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
const sdk = metadata.packages.find((item) => item.name === "github-copilot-sdk");
if (sdk?.version !== "1.0.16") throw new Error("Review runtime notices when upgrading the Copilot SDK.");
const runtime = await readFile(new URL("cli-version-in-process.txt", pathToFileURL(sdk.manifest_path)), "utf8");
if (!/^version=1\.0\.90$/m.test(runtime)) throw new Error("The bundled Copilot runtime changed; review its license and update the notice generator.");

await mkdir("licenses/generated", { recursive: true });
const packages = JSON.parse(execFileSync("npm", ["query", ".prod", "--json"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const sections = ["Blueprint frontend dependency notices\nGenerated from installed production dependencies. Some type-only dependencies may also appear.\n"];
for (const item of packages.filter((item) => item.location).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  if (lock.packages[item.location]?.version !== item.version) throw new Error(`Run npm ci: ${item.name} does not match package-lock.json.`);
  const path = resolve(root, item.location);
  const files = (await readdir(path)).filter((name) => /^(licen[sc]e|copying|notice|copyright)(?:$|[-_.])/i.test(name)).sort();
  if (!files.length) throw new Error(`Missing license/attribution files for ${item.name}@${item.version}. Review the package before redistribution.`);
  sections.push(`\n${"=".repeat(79)}\n${item.name} ${item.version}\nDeclared license: ${item.license || "See package notices"}\nSource: https://www.npmjs.com/package/${item.name}/v/${item.version}\n`);
  for (const file of files) sections.push(`\n--- ${file} ---\n${await readFile(resolve(path, file), "utf8")}`);
  if (files.every((file) => file.endsWith(".spdx"))) {
    if (!["@tauri-apps/plugin-dialog", "@tauri-apps/plugin-fs"].includes(item.name) ||
        !["MIT OR Apache-2.0", "Apache-2.0 OR MIT"].includes(item.license)) {
      throw new Error(`Review missing full license text for ${item.name}.`);
    }
    sections.push(`\nMIT text accompanying the retained Tauri SPDX attribution:\n${await readFile("licenses/tauri-MIT.txt", "utf8")}`);
  }
}
await writeFile(noticeOutputs[0], sections.join("\n"));
execFileSync("cargo", [
  "about", "generate", "--locked", "--fail", "--manifest-path", "src-tauri/Cargo.toml",
  "--config", "about.toml", "scripts/licenses.hbs", "--output-file", noticeOutputs[1],
], { stdio: "inherit" });
const attribution = [];
for (const item of metadata.packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  const directory = dirname(item.manifest_path);
  const notices = (await readdir(directory, { withFileTypes: true }))
    .filter((file) => file.isFile() && /^(?:notice|copyright)(?:$|[-_.])/i.test(file.name));
  for (const file of notices.sort((a, b) => a.name.localeCompare(b.name))) {
    attribution.push(`\n${"=".repeat(79)}\n${item.name} ${item.version} / ${file.name}\n${await readFile(resolve(directory, file.name), "utf8")}`);
  }
}
if (attribution.length) {
  const text = await readFile(noticeOutputs[1], "utf8");
  await writeFile(noticeOutputs[1], `${text}\nAdditional upstream attribution files (may include build-only or non-target crates):\n${attribution.join("\n")}\n`);
}
await writeFile(noticeManifest, `${JSON.stringify({
  version: 1, generator: version, copilotSdk: sdk.version, copilotRuntime: "1.0.90",
  inputs: await hashes(noticeInputs), outputs: await hashes(noticeOutputs),
}, null, 2)}\n`);
console.log("Generated frontend/native notices and a dependency-bound manifest.");
