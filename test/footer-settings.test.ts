import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { showInteractive } from "../src/ui/unified.js";
import { markReloadRequired } from "../src/utils/reload-state.js";
import { updateExtmgrStatus } from "../src/utils/status.js";
import { captureCustomComponent } from "./helpers/custom-component.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

initTheme();

for (const action of ["save", "cancel", "invalid", "restore"] as const) {
  void test(`/extensions Settings ${action} preserves the footer preference contract`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-extmgr-footer-settings-"));
    const previousCache = process.env.PI_EXTMGR_CACHE_DIR;
    process.env.PI_EXTMGR_CACHE_DIR = root;
    const restoreCatalog = mockPackageCatalog({
      packages: [{ source: "npm:demo", name: "demo", scope: "global" }],
    });
    const preferencesFile = join(root, "preferences.json");
    const original =
      action === "invalid"
        ? "{invalid"
        : JSON.stringify({
            futureField: { keep: 1 },
            ...(action === "restore" ? { showFooterStatus: false } : {}),
          });
    const schedule = JSON.stringify({ enabled: false, intervalMs: 0, displayText: "off" });
    try {
      await writeFile(preferencesFile, original);
      await writeFile(join(root, "auto-update.json"), schedule);
      await markReloadRequired("An unrelated reload is pending.");
      const harness = createMockHarness({ hasUI: true });
      const { ctx, pi, statuses, widgets } = harness;
      await updateExtmgrStatus(ctx, pi);
      let managerVisits = 0;
      let settingsVisits = 0;
      (
        ctx.ui as unknown as { select: (title: string, choices: string[]) => Promise<string> }
      ).select = async (title, choices) => {
        assert.equal(title, "Extmgr workspace");
        assert.ok(choices.includes("Settings"), "manager menu must offer Settings");
        return "Settings";
      };
      (ctx.ui as { custom: (factory: unknown) => Promise<unknown> }).custom = async (factory) =>
        captureCustomComponent(
          factory,
          ctx.ui.theme,
          (lines) =>
            lines.some((line) => line.includes("i install") || line.includes("Extmgr settings")),
          async (component, lines, completion) => {
            if (lines.some((line) => line.includes("Extmgr settings"))) {
              settingsVisits += 1;
              assert.ok(
                lines.some(
                  (line) =>
                    line.includes("Show footer status") &&
                    line.includes(action === "restore" ? "off" : "on")
                )
              );
              component.handleInput?.(" ");
              assert.ok(
                component
                  .render(120)
                  .some(
                    (line) =>
                      line.includes("Show footer status") &&
                      line.includes(action === "restore" ? "on" : "off")
                  )
              );
              assert.equal(
                await readFile(preferencesFile, "utf8"),
                original,
                "Space only stages the preference"
              );
              component.handleInput?.(action === "cancel" ? "\u001b" : "\r");
            } else {
              managerVisits += 1;
              assert.ok(managerVisits <= 2, "manager should resume after closing Settings");
              component.handleInput?.(managerVisits === 1 ? "m" : "\u001b");
            }
            return await completion;
          }
        );

      await showInteractive(ctx, pi);

      assert.equal(settingsVisits, 1);
      assert.equal(harness.reloadCount(), 0);
      assert.equal(await readFile(join(root, "auto-update.json"), "utf8"), schedule);
      assert.ok(widgets.get("extmgr-attention")?.some((line) => line.includes("reload pending")));
      if (action === "save" || action === "restore") {
        const saved: unknown = JSON.parse(await readFile(preferencesFile, "utf8"));
        assert.deepEqual(saved, {
          futureField: { keep: 1 },
          showFooterStatus: action === "restore",
        });
        if (action === "save") assert.equal(statuses.get("extmgr"), undefined);
        else assert.match(statuses.get("extmgr") ?? "", /1 pkg/);
        const nextSession = createMockHarness({ hasUI: true });
        await updateExtmgrStatus(nextSession.ctx, nextSession.pi);
        if (action === "save") assert.equal(nextSession.statuses.get("extmgr"), undefined);
        else assert.match(nextSession.statuses.get("extmgr") ?? "", /1 pkg/);
      } else {
        assert.equal(await readFile(preferencesFile, "utf8"), original);
        assert.match(statuses.get("extmgr") ?? "", /1 pkg/);
        if (action === "invalid") {
          assert.ok(harness.notifications.some((item) => item.level === "error"));
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
