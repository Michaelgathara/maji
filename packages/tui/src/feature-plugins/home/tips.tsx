import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { Tips } from "./tips-view"
import { useBindings } from "../../keymap"

const id = "internal:home-tips"

function View(props: { api: TuiPluginApi; hidden: boolean; connected: boolean }) {
  useBindings(() => ({
    commands: props.connected
      ? [
          {
            name: "tips.toggle",
            title: props.hidden ? "Show tips" : "Hide tips",
            category: "System",
            namespace: "palette",
            run() {
              props.api.kv.set("tips_hidden", !props.api.kv.get("tips_hidden", true))
              props.api.ui.dialog.clear()
            },
          },
        ]
      : [],
    bindings: props.api.tuiConfig.keybinds.get("tips.toggle"),
  }))

  return (
    <Show when={!props.connected || !props.hidden}>
      <box width="100%" maxWidth={75} alignItems="center" paddingTop={3} flexShrink={1}>
        <Tips api={props.api} connected={props.connected} />
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_bottom() {
        const hidden = createMemo(() => api.kv.get("tips_hidden", true))
        const connected = createMemo(() =>
          api.state.provider.some(
            (item) => item.id !== "opencode" || Object.values(item.models).some((model) => model.cost?.input !== 0),
          ),
        )
        return <View api={api} hidden={hidden()} connected={connected()} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
