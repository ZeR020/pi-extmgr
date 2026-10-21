import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { applyPackageExtensionStateChanges } from "../src/packages/extensions.js";

for (const { target, enabled } of [
  { target: "enabled", enabled: ["a.ts"] },
  { target: "disabled", enabled: [] },
] as const) {
  void test(`an explicit empty extension filter stays selective when a.ts is ${target}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-empty-selection-"));
    const source = join(cwd, "package");
    try {
      await mkdir(source);
      await mkdir(join(cwd, ".pi"));
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({ pi: { extensions: ["a.ts", "b.ts"] } })
      );
      await writeFile(join(source, "a.ts"), "export default () => {};\n");
      await writeFile(join(source, "b.ts"), "export default () => {};\n");
      await writeFile(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ packages: [{ source, extensions: [] }] })
      );

      const result = await applyPackageExtensionStateChanges(
        source,
        "project",
        [{ extensionPath: "a.ts", target }],
        cwd,
        true
      );
      assert.deepEqual(result, { ok: true });
      const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
      const manager = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager });
      const resources = await manager.resolve(async () => "skip");
      assert.deepEqual(
        resources.extensions
          .filter((entry) => entry.enabled)
          .map((entry) => basename(entry.path))
          .sort(),
        enabled
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
