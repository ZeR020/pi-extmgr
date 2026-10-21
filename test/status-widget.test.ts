import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { restorePiTitle, setWorkspaceTitle } from "../src/ui/workspace/title.js";
import { clearReloadRequired, markReloadRequired } from "../src/utils/reload-state.js";
import { updateExtmgrStatus } from "../src/utils/status.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

initTheme();

async function withIsolatedState<T>(run: () => Promise<T>): Promise<T> {
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-extmgr-status-widget-"));
  const previousCache = process.env.PI_EXTMGR_CACHE_DIR;
  process.env.PI_EXTMGR_CACHE_DIR = cacheDir;
  try {
    return await run();
  } finally {
    if (previousCache === undefined) delete process.env.PI_EXTMGR_CACHE_DIR;
    else process.env.PI_EXTMGR_CACHE_DIR = previousCache;
    await rm(cacheDir, { recursive: true, force: true });
  }
}

void test("attention widget appears while a reload is pending and clears afterwards", async () => {
  await withIsolatedState(async () => {
    const restoreCatalog = mockPackageCatalog({ packages: [] });
    try {
      const { pi, ctx, widgets } = createMockHarness({ hasUI: true });

      await markReloadRequired("Something changed.");
      await updateExtmgrStatus(ctx, pi);

      const shown = widgets.get("extmgr-attention");
      assert.ok(shown, "expected the attention widget while a reload is pending");
      assert.ok(shown.some((line) => line.includes("reload pending")));
      assert.ok(shown.some((line) => line.includes("/extensions")));

      await clearReloadRequired();
      await updateExtmgrStatus(ctx, pi);

      assert.equal(
        widgets.get("extmgr-attention"),
        undefined,
        "expected the widget to clear once nothing needs attention"
      );
    } finally {
      restoreCatalog();
    }
  });
});

void test("attention widget drops stale update prompts after packages were updated externally", async () => {
  await withIsolatedState(async () => {
    const restoreCatalog = mockPackageCatalog({
      packages: [{ source: "npm:demo", name: "demo", scope: "global" }],
      updates: [],
    });
    try {
      const { pi, ctx, entries, statuses, widgets } = createMockHarness({ hasUI: true });
      entries.push({
        type: "custom",
        customType: "extmgr-auto-update",
        data: {
          enabled: true,
          intervalMs: 60 * 60 * 1000,
          displayText: "1 hour",
          updatesAvailable: ["npm:demo"],
        },
      });

      await updateExtmgrStatus(ctx, pi);

      assert.equal(widgets.get("extmgr-attention"), undefined);
      assert.doesNotMatch(statuses.get("extmgr") ?? "", /1 update/);
    } finally {
      restoreCatalog();
    }
  });
});

void test("hiding footer status clears the existing line without hiding reload alerts", async () => {
  await withIsolatedState(async () => {
    const restoreCatalog = mockPackageCatalog({
      packages: [{ source: "npm:demo", name: "demo", scope: "global" }],
    });
    try {
      const { pi, ctx, statuses, widgets } = createMockHarness({ hasUI: true });
      await updateExtmgrStatus(ctx, pi);
      assert.match(statuses.get("extmgr") ?? "", /1 pkg/);
      await markReloadRequired("A reload is still needed.");
      const cacheDir = process.env.PI_EXTMGR_CACHE_DIR;
      assert.ok(cacheDir);
      await writeFile(
        join(cacheDir, "preferences.json"),
        JSON.stringify({ showFooterStatus: false })
      );

      await updateExtmgrStatus(ctx, pi);

      assert.equal(statuses.get("extmgr"), undefined);
      assert.ok(widgets.get("extmgr-attention")?.some((line) => line.includes("reload pending")));
      const nextSession = createMockHarness({ hasUI: true });
      await updateExtmgrStatus(nextSession.ctx, nextSession.pi);
      assert.equal(nextSession.statuses.get("extmgr"), undefined);
    } finally {
      restoreCatalog();
    }
  });
});

void test("a pending status refresh cannot restore an opted-out footer", async () => {
  await withIsolatedState(async () => {
    let release = (): void => undefined;
    let started = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checking = new Promise<void>((resolve) => {
      started = resolve;
    });
    const restoreCatalog = mockPackageCatalog({
      packages: [{ source: "npm:demo", name: "demo", scope: "global" }],
      checkForAvailableUpdatesImpl: async () => {
        started();
        await blocked;
        return [];
      },
    });
    try {
      const { pi, ctx, entries, statuses } = createMockHarness({ hasUI: true });
      entries.push({
        type: "custom",
        customType: "extmgr-auto-update",
        data: {
          enabled: true,
          intervalMs: 3600000,
          displayText: "1 hour",
          updatesAvailable: ["npm:demo"],
        },
      });
      const pending = updateExtmgrStatus(ctx, pi);
      await checking;
      const cacheDir = process.env.PI_EXTMGR_CACHE_DIR;
      assert.ok(cacheDir);
      await writeFile(
        join(cacheDir, "preferences.json"),
        JSON.stringify({ showFooterStatus: false })
      );
      statuses.set("extmgr", undefined);
      release();
      await pending;
      assert.equal(statuses.get("extmgr"), undefined);
    } finally {
      release();
      restoreCatalog();
    }
  });
});

void test("workspace titles are set per screen and restored to pi's format", () => {
  const { ctx, titles } = createMockHarness({ hasUI: true, cwd: "/workspace/demo-project" });

  setWorkspaceTitle(ctx, "installed");
  setWorkspaceTitle(ctx, "health");
  restorePiTitle(ctx);

  assert.deepEqual(titles, ["π - extmgr Installed", "π - extmgr Health", "π - demo-project"]);
});

void test("title updates are skipped outside the TUI", () => {
  const { ctx, titles } = createMockHarness({ hasUI: false });

  setWorkspaceTitle(ctx, "installed");
  restorePiTitle(ctx);

  assert.deepEqual(titles, []);
});
