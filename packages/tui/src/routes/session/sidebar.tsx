import { useProject } from "../../context/project"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { usePluginRuntime } from "../../plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"
import { Spinner } from "../../component/spinner"
import { Locale } from "../../util/locale"
import { createElsewhere } from "../../component/elsewhere"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <pluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </pluginRuntime.Slot>
            <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <OtherSessions sessionID={props.sessionID} />

        <box flexShrink={0} gap={1} paddingTop={1}>
          <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </pluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}

// Other sessions that are running or waiting for the user, so switching
// away from a working session never loses sight of it.
function OtherSessions(props: { sessionID: string }) {
  const route = useRoute()
  const { theme } = useTheme()
  const items = createElsewhere(() => props.sessionID)

  return (
    <Show when={items().length > 0}>
      <box flexShrink={0} gap={1} paddingTop={1}>
        <text fg={theme.text}>
          <b>Other work</b>
        </text>
        <For each={items()}>
          {(item) => (
            <box
              flexDirection="row"
              justifyContent="space-between"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.backgroundElement}
              onMouseUp={() => route.navigate({ type: "session", sessionID: item.session.id })}
            >
              <text fg={theme.text}>{Locale.truncate(item.session.title || "Untitled task", 24)}</text>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <Show when={item.pending === 0 && item.busy}>
                  <Spinner color={theme.success} />
                </Show>
                <text fg={item.pending > 0 ? theme.warning : theme.success}>
                  {item.pending > 0 ? "needs you" : "working"}
                </text>
              </box>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
