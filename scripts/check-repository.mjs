import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow, validateWorkflow } from "../src/workflow.ts";
import { exportWorkflow } from "../src/export.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const omitted = new Set([".git", "node_modules", "dist", "release-artifacts", ".playwright-mcp", ".copilot", ".superpowers"]);
const omittedPaths = new Set(["src-tauri/target", "src-tauri/gen", "licenses/generated"]);

async function filesIn(directory = "") {
  const paths = [];
  for (const item of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${item.name}` : item.name;
    if (omitted.has(item.name) || omittedPaths.has(path)) continue;
    if (item.isDirectory()) paths.push(...await filesIn(path));
    else if (item.isFile()) paths.push(path);
  }
  return paths;
}

export function checkVersions(pkg, lock, cargoVersion, appVersion) {
  if (![lock.version, lock.packages?.[""]?.version, cargoVersion, appVersion].every((version) => version === pkg.version)) {
    throw new Error("Version mismatch: update package.json, package-lock.json, Cargo.toml and tauri.conf.json together.");
  }
  if (pkg.license !== "MIT" || lock.packages?.[""]?.license !== "MIT" || pkg.private !== true) {
    throw new Error("Keep the MIT source license and desktop-only npm publication guard in package metadata.");
  }
}

function anchors(markdown) {
  const result = new Set();
  const seen = new Map();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1].trim().toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-");
    const count = seen.get(base) || 0;
    result.add(count ? `${base}-${count}` : base);
    seen.set(base, count + 1);
  }
  return result;
}

export async function checkLinks(markdown, file, directory = root) {
  const prose = markdown.replace(/```[\s\S]*?```/g, "");
  const targets = [
    ...[...prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]),
    ...[...prose.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]),
  ];
  for (const target of targets) {
    if (/^(?:[a-z][a-z+.-]*:|\/\/)/i.test(target)) continue;
    const [path, fragment] = target.split("#");
    const full = path ? resolve(directory, dirname(file), decodeURIComponent(path)) : resolve(directory, file);
    if (relative(directory, full).startsWith(`..${sep}`) || relative(directory, full) === "..") {
      throw new Error(`${file}: link leaves the repository: ${target}`);
    }
    await stat(full).catch(() => { throw new Error(`${file}: missing local link target: ${target}`); });
    if (fragment && full.endsWith(".md") && !anchors(await readFile(full, "utf8")).has(decodeURIComponent(fragment))) {
      throw new Error(`${file}: missing heading: ${target}`);
    }
  }
}

export function checkHygiene(path, text) {
  if (/^(?:node_modules|dist|release-artifacts|licenses\/generated|src-tauri\/(?:target|gen)|\.copilot|\.superpowers|\.playwright-mcp)\//.test(path) ||
      /(?:^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith(".env.example") ||
      /\.(?:pem|key|p8|p12|pfx|mobileprovision)$/.test(path)) {
    throw new Error(`Private/generated file must not be published: ${path}`);
  }
  if (/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    throw new Error(`Possible credential material in ${path}; remove it and rotate any exposed credential.`);
  }
  if (/\/(?:home|Users)\/[A-Za-z0-9_.-]+\//.test(text)) {
    throw new Error(`Machine-specific home path in ${path}; use portable instructions or synthetic data.`);
  }
}

async function checkRepository() {
  const json = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
  const [pkg, lock, app, cargo] = await Promise.all([
    json("package.json"), json("package-lock.json"), json("src-tauri/tauri.conf.json"),
    readFile(resolve(root, "src-tauri/Cargo.toml"), "utf8"),
  ]);
  const cargoPackage = cargo.split("[package]")[1]?.split(/\n\[/)[0] || "";
  checkVersions(pkg, lock, /^version = "([^"]+)"$/m.exec(cargoPackage)?.[1], app.version);
  const repository = pkg.repository?.url?.replace(/\.git$/, "");
  if (repository !== app.bundle.homepage || !cargoPackage.includes(`repository = "${repository}"`) ||
      !cargoPackage.includes('license = "MIT"') || !cargoPackage.includes("publish = false")) {
    throw new Error("Repository/license/publication metadata must agree across npm, Cargo and Tauri.");
  }
  const gitDirectory = await stat(resolve(root, ".git")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let paths;
  if (gitDirectory) {
    paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).split("\0").filter(Boolean);
  } else {
    paths = await filesIn();
    console.log("No Git index available; checking the source tree with generated directories excluded.");
  }
  let markdown = 0;
  for (const path of new Set(paths)) {
    const full = resolve(root, path);
    const info = await stat(full).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info?.isFile()) continue;
    const isText = /\.(?:md|txt|json|lock|example|[cm]?[jt]sx?|rs|toml|ya?ml|hbs|svg)$/.test(path) || path === "LICENSE";
    const text = isText ? await readFile(full, "utf8") : "";
    checkHygiene(path, text);
    if (path.endsWith(".md")) { await checkLinks(text, path); markdown++; }
  }
  const examples = (await readdir(resolve(root, "examples"))).filter((path) => path.endsWith(".json"));
  if (!examples.length) throw new Error("Keep at least one runnable, synthetic example.");
  for (const example of examples) {
    const workflow = parseWorkflow(await readFile(resolve(root, "examples", example), "utf8"));
    const errors = validateWorkflow(workflow);
    if (errors.length) throw new Error(`${example}: ${errors.join("\n")}`);
    exportWorkflow(workflow);
  }
  console.log(`Repository metadata, source hygiene, ${markdown} Markdown files and ${examples.length} example(s) checked.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkRepository();
}
