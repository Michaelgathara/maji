import { createMemo, For, Show } from "solid-js"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { Locale } from "../util/locale"
import { Spinner } from "./spinner"

// Other root sessions that are running or waiting for the user, needs-input
// first. The one-box UX depends on these staying visible from any session.
export function createElsewhere(sessionID: () => string | undefined, limit = 5) {
  const sync = useSync()
  return createMemo(() =>
    sync.data.session
      .filter((session) => !session.parentID && !session.time.archived && session.id !== sessionID())
      .map((session) => {
        const pending =
          (sync.data.permission[session.id]?.length ?? 0) + (sync.data.question[session.id]?.length ?? 0)
        const status = sync.data.session_status[session.id]
        return {
          session,
          pending,
          busy: !!status && status.type !== "idle",
        }
      })
      .filter((item) => item.pending > 0 || item.busy)
      .toSorted(
        (a, b) =>
          (b.pending > 0 ? 1 : 0) - (a.pending > 0 ? 1 : 0) || b.session.time.updated - a.session.time.updated,
      )
      .slice(0, limit),
  )
}

// Single-line summary of active sessions for layouts without the sidebar.
export function ElsewhereStrip(props: { sessionID: string }) {
  const route = useRoute()
  const { theme } = useTheme()
  const items = createElsewhere(() => props.sessionID, 3)

  return (
    <Show when={items().length > 0}>
      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} flexShrink={0}>
        <For each={items()}>
          {(item) => (
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={() => route.navigate({ type: "session", sessionID: item.session.id })}
            >
              <Show when={item.pending === 0 && item.busy}>
                <Spinner color={theme.success} />
              </Show>
              <text fg={item.pending > 0 ? theme.warning : theme.textMuted}>
                {Locale.truncate(item.session.title || "Untitled session", 20)}
                {item.pending > 0 ? " input" : ""}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
