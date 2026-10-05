import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkHygiene, checkLinks, checkVersions } from "./check-repository.mjs";

test("public metadata cannot drift between versioned manifests", () => {
  const pkg = { version: "0.1.0", license: "MIT", private: true };
  const lock = { version: "0.1.0", packages: { "": pkg } };
  checkVersions(pkg, lock, "0.1.0", "0.1.0");
  assert.throws(() => checkVersions(pkg, lock, "0.2.0", "0.1.0"), /Version mismatch/);
});

test("repository hygiene rejects generated files and signing material", () => {
  checkHygiene("src/copilot.ts", 'const reference = "${TOKEN}";');
  checkHygiene(".env.example", "TOKEN=");
  for (const path of ["src-tauri/target/release/blueprint", ".env", ".copilot/state.json", "cert.p12"]) {
    assert.throws(() => checkHygiene(path, ""), /must not be published/);
  }
});

test("documentation checks find broken relative paths and anchors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blueprint-docs-"));
  try {
    await writeFile(join(directory, "guide.md"), "# Guide\n\n## Release gates\n");
    await checkLinks("[Guide](guide.md#release-gates)", "README.md", directory);
    await assert.rejects(checkLinks("[Missing](absent.md)", "README.md", directory), /missing local/);
    await assert.rejects(checkLinks("[Missing](guide.md#unknown)", "README.md", directory), /missing heading/);
    await assert.rejects(checkLinks("[Outside](../private.md)", "README.md", directory), /leaves the repository/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
