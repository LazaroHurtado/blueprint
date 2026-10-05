import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkNotices, hashes, noticeInputs, noticeManifest, noticeOutputs } from "./check-notices.mjs";

test("packaging rejects missing, stale, or altered dependency notices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blueprint-notices-"));
  try {
    await assert.rejects(checkNotices(directory), /ENOENT/);
    for (const path of [...noticeInputs, ...noticeOutputs]) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), path);
    }
    const manifest = {
      version: 1, generator: "cargo-about 0.9.2", copilotSdk: "1.0.16", copilotRuntime: "1.0.90",
      inputs: await hashes(noticeInputs, directory), outputs: await hashes(noticeOutputs, directory),
    };
    await writeFile(join(directory, noticeManifest), JSON.stringify(manifest));
    await checkNotices(directory);
    await writeFile(join(directory, "package-lock.json"), "changed dependency");
    await assert.rejects(checkNotices(directory), /stale or modified/);
    await writeFile(join(directory, "package-lock.json"), "package-lock.json");
    await writeFile(join(directory, noticeOutputs[0]), "incomplete notices");
    await assert.rejects(checkNotices(directory), /stale or modified/);
    await writeFile(join(directory, noticeOutputs[0]), noticeOutputs[0]);
    await writeFile(join(directory, "licenses/generated/private.key"), "must not be packaged");
    await assert.rejects(checkNotices(directory), /Unexpected licensing resource/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
