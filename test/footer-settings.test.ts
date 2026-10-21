import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { showInteractive } from "../src/ui/unified.js";
import { markReloadRequired } from "../src/utils/reload-state.js";
import { setShowFooterStatus } from "../src/utils/settings.js";
import { updateExtmgrStatus } from "../src/utils/status.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

initTheme();

for (const action of ["off", "cancel", "invalid", "on"] as const) {
  void test(`/extensions menu toggles footer status: ${action}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-extmgr-footer-toggle-"));
    const previousCache = process.env.PI_EXTMGR_CACHE_DIR;
    process.env.PI_EXTMGR_CACHE_DIR = root;
    const restoreCatalog = mockPackageCatalog({
      packages: [{ source: "npm:demo", name: "demo", scope: "global" }],
    });
    const file = join(root, "preferences.json");
    const original =
      action === "invalid"
        ? "{invalid"
        : JSON.stringify({
            futureField: 1,
            ...(action === "on" ? { showFooterStatus: false } : {}),
          });
    const schedule = JSON.stringify({ enabled: false, intervalMs: 0, displayText: "off" });
    try {
      await writeFile(file, original);
      await writeFile(join(root, "auto-update.json"), schedule);
      await markReloadRequired("An unrelated reload is pending.");
      const harness = createMockHarness({ hasUI: true });
      const { ctx, pi, statuses, widgets } = harness;
      await updateExtmgrStatus(ctx, pi);
      let choicesSeen: string[] = [];
      (
        ctx.ui as unknown as {
          select: (title: string, choices: string[]) => Promise<string | undefined>;
        }
      ).select = async (_title, choices) => {
        choicesSeen = choices;
        return action === "cancel"
          ? undefined
          : choices.find((item) => item.startsWith("Show footer status:"));
      };
      let visits = 0;
      let interactionError: unknown;
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
        captureCustomComponent(
          factory,
          ctx.ui.theme,
          (lines) => lines.some((line) => line.includes("i install")),
          async (component, _lines, completion) => {
            visits += 1;
            component.handleInput?.(visits === 1 ? "m" : "\u001b");
            return await completion;
          }
        ).catch((error: unknown) => {
          interactionError = error;
          throw error;
        });
      await showInteractive(ctx, pi);
      assert.equal(interactionError, undefined);
      assert.ok(
        choicesSeen.includes(`Show footer status: ${action === "on" ? "off" : "on"} (toggle)`)
      );
      assert.equal(harness.reloadCount(), 0);
      assert.equal(await readFile(join(root, "auto-update.json"), "utf8"), schedule);
      assert.ok(widgets.get("extmgr-attention")?.some((line) => line.includes("reload pending")));
      if (action === "off" || action === "on") {
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
          futureField: 1,
          showFooterStatus: action === "on",
        });
        const next = createMockHarness({ hasUI: true });
        await updateExtmgrStatus(next.ctx, next.pi);
        if (action === "off") {
          assert.equal(statuses.get("extmgr"), undefined);
          assert.equal(next.statuses.get("extmgr"), undefined);
        } else {
          assert.match(statuses.get("extmgr") ?? "", /1 pkg/);
          assert.match(next.statuses.get("extmgr") ?? "", /1 pkg/);
        }
      } else {
        assert.equal(await readFile(file, "utf8"), original);
        if (action === "invalid") {
          assert.ok(
            harness.notifications.some(
              (item) =>
                item.level === "error" && item.message.includes("Cannot change footer status")
            )
          );
        }
      }
    } finally {
      restoreCatalog();
      if (previousCache === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
      else process.env.PI_EXTMGR_CACHE_DIR = previousCache;
      await rm(root, { recursive: true, force: true });
    }
  });
}

void test("a saved opt-out supersedes an in-flight preference read", {
  timeout: 5000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-extmgr-footer-read-race-"));
  const previousCache = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_EXTMGR_CACHE_DIR = root;
  const restoreCatalog = mockPackageCatalog({ packages: [] });
  const file = join(root, "preferences.json");
  let markCaptured = (): void => undefined;
  let releaseRead = (): void => undefined;
  const captured = new Promise<void>((resolve) => {
    markCaptured = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readOriginal = fs.readFile;
  let pause = true;
  let pending: Promise<void> | undefined;
  const intercepted = t.mock.method(
    fs,
    "readFile",
    async (
      path: Parameters<typeof readOriginal>[0],
      options: Parameters<typeof readOriginal>[1]
    ) => {
      const contents = await readOriginal(path, options);
      if (path === file && pause) {
        pause = false;
        markCaptured();
        await release;
      }
      return contents;
    }
  );
  syncBuiltinESMExports();
  try {
    await writeFile(file, JSON.stringify({ showFooterStatus: true }));
    const { pi, ctx, statuses } = createMockHarness({ hasUI: true });
    pending = updateExtmgrStatus(ctx, pi);
    await captured;
    await setShowFooterStatus(false);
    ctx.ui.setStatus("extmgr", undefined);
    releaseRead();
    await pending;
    assert.equal(statuses.get("extmgr"), undefined);
    assert.deepEqual(JSON.parse(await readOriginal(file, "utf8")), { showFooterStatus: false });
  } finally {
    releaseRead();
    await pending;
    intercepted.mock.restore();
    syncBuiltinESMExports();
    restoreCatalog();
    if (previousCache === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previousCache;
    await rm(root, { recursive: true, force: true });
  }
});
