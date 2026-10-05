import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { checkNotices, distributionNotices, root } from "./check-notices.mjs";

process.chdir(root);
await checkNotices();
if (!["linux", "darwin"].includes(process.platform) ||
    !["x64", "arm64"].includes(process.arch) ||
    process.platform === "linux" && process.arch !== "x64") {
  throw new Error("Candidate collection supports Ubuntu x86_64 and native macOS arm64/x86_64 builds.");
}
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const output = resolve(root, "release-artifacts");
await mkdir(output);
const name = `${config.productName}-${pkg.version}-${process.platform}-${process.arch}-candidate`;
let artifact;
if (process.platform === "linux") {
  const directory = "src-tauri/target/release/bundle/deb";
  const candidates = (await readdir(directory)).filter((file) => file.endsWith(`_${pkg.version}_amd64.deb`));
  if (candidates.length !== 1) throw new Error("Expected exactly one Debian package for the current version.");
  artifact = `${name}.deb`;
  const source = resolve(directory, candidates[0]);
  const listing = execFileSync("dpkg-deb", ["--contents", source], { encoding: "utf8" });
  for (const required of ["licenses/copilot-cli-1.0.90.txt", "licenses/generated/npm.txt", "licenses/generated/rust.txt", "licenses/generated/manifest.json", "THIRD_PARTY_NOTICES.md"]) {
    if (!listing.includes(required)) throw new Error(`The installer is missing ${required}.`);
  }
  const dependencies = execFileSync("dpkg-deb", ["--field", source, "Depends"], { encoding: "utf8" });
  for (const dependency of ["xdg-utils", "libwebkit2gtk", "libgtk-3"]) {
    if (!dependencies.includes(dependency)) throw new Error(`The installer is missing dependency ${dependency}.`);
  }
  await copyFile(source, resolve(output, artifact));
} else {
  const directory = "src-tauri/target/release/bundle/macos";
  const app = `${config.productName}.app`;
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/copilot-cli-1.0.90.txt", "licenses/generated/manifest.json", "licenses/generated/npm.txt", "licenses/generated/rust.txt"]) {
    await stat(resolve(directory, app, "Contents/Resources", file));
  }
  artifact = `${name}.app.tar.gz`;
  execFileSync("tar", ["-czf", resolve(output, artifact), "-C", directory, app], { stdio: "inherit" });
}
for (const file of distributionNotices) {
  await mkdir(dirname(resolve(output, file)), { recursive: true });
  await copyFile(file, resolve(output, file));
}
let commit = null;
let dirty = true;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  dirty = !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
} catch (error) {
  if (process.env.CI) throw error;
  console.warn("Uncommitted local build: source revision is unknown. This artifact is not approved for publication.");
}
if (process.env.CI && dirty) throw new Error("The candidate source tree changed during the build.");
await writeFile(resolve(output, "BUILD_INFO.json"), `${JSON.stringify({
  project: pkg.name, version: pkg.version, commit, dirty,
  platform: process.platform, architecture: process.arch, candidate: true,
  developerIdSigned: false, notarized: false,
  node: process.version,
  rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
  copilotSdk: "1.0.16", copilotRuntime: "1.0.90",
}, null, 2)}\n`);
async function files(directory = "") {
  const result = [];
  for (const entry of await readdir(resolve(output, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
const sums = [];
for (const path of (await files()).sort()) {
  sums.push(`${createHash("sha256").update(await readFile(resolve(output, path))).digest("hex")}  ${path}`);
}
await writeFile(resolve(output, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
console.log(`Collected ${artifact}, notices, source metadata, and SHA256SUMS.txt.`);
