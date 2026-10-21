import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { runCustomUI, tryOperation } from "../utils/mode.js";
import { getShowFooterStatus, setShowFooterStatus } from "../utils/preferences.js";
import { updateExtmgrStatus } from "../utils/status.js";

type SettingsResult = { save: true; visible: boolean } | { save: false };

export async function showManagerSettings(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  await tryOperation(
    ctx,
    async () => {
      const initial = await getShowFooterStatus(() => {
        ctx.ui.notify(
          "Extmgr preferences cannot be read. Keeping footer status on; invalid preferences will not be overwritten.",
          "warning"
        );
      });
      const result = await runCustomUI(ctx, "Extmgr settings", () =>
        ctx.ui.custom<SettingsResult>((tui, theme, keybindings, done) => {
          let visible = initial;
          const container = new Container();
          container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold("Extmgr settings")), 2, 0));
          container.addChild(new Spacer(1));
          const list = new SettingsList(
            [
              {
                id: "showFooterStatus",
                label: "Show footer status",
                description:
                  "Show extmgr's package/schedule line in Pi's footer. Update and reload alerts are unaffected.",
                currentValue: initial ? "on" : "off",
                values: ["on", "off"],
              },
            ],
            3,
            getSettingsListTheme(),
            (_id, value) => {
              visible = value === "on";
              tui.requestRender();
            },
            () => done({ save: false })
          );
          container.addChild(list);
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme.fg("dim", "Space toggle · Enter save · Esc discard"), 2, 0)
          );
          container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
          return {
            render: (width) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput(data) {
              if (keybindings.matches(data, "tui.select.cancel")) {
                done({ save: false });
              } else if (keybindings.matches(data, "tui.select.confirm")) {
                done({ save: true, visible });
              } else {
                list.handleInput(data);
              }
            },
          };
        })
      );
      if (!result?.save || result.visible === initial) return;
      await setShowFooterStatus(result.visible);
      if (result.visible) await updateExtmgrStatus(ctx, pi);
      else ctx.ui.setStatus("extmgr", undefined);
      ctx.ui.notify("Extmgr settings saved.", "info");
    },
    "Cannot save extmgr settings"
  );
}
