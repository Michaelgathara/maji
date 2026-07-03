import { createMemo, For, Show } from "solid-js"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { Spinner } from "../../component/spinner"

export function HomeAttentionRail() {
  const route = useRoute()
  const sync = useSync()
  const { theme } = useTheme()

  const sessions = createMemo(() => new Map(sync.data.session.map((session) => [session.id, session])))
  const needsInput = createMemo(() =>
    Object.entries(sync.data.permission)
      .flatMap(([sessionID, permissions]) =>
        permissions.map(() => ({
          sessionID,
          kind: "Permission",
          tone: theme.warning,
        })),
      )
      .concat(
        Object.entries(sync.data.question).flatMap(([sessionID, questions]) =>
          questions.map(() => ({
            sessionID,
            kind: "Question",
            tone: theme.accent,
          })),
        ),
      )
      .filter((item) => sessions().has(item.sessionID))
      .slice(0, 6),
  )
  const previousSessions = createMemo(() =>
    sync.data.session
      .filter((session) => !session.parentID && !session.time.archived)
      .toSorted((a, b) => {
        const aInput = hasInput(a.id) ? 1 : 0
        const bInput = hasInput(b.id) ? 1 : 0
        const aWorking = isWorking(a.id) ? 1 : 0
        const bWorking = isWorking(b.id) ? 1 : 0
        return bInput - aInput || bWorking - aWorking || b.time.updated - a.time.updated
      })
      .slice(0, 9),
  )

  function open(sessionID: string) {
    route.navigate({ type: "session", sessionID })
  }

  function hasInput(sessionID: string) {
    return (sync.data.permission[sessionID]?.length ?? 0) + (sync.data.question[sessionID]?.length ?? 0) > 0
  }

  function isWorking(sessionID: string) {
    const status = sync.data.session_status[sessionID]
    return !!status && status.type !== "idle"
  }

  function sessionStatus(sessionID: string): {
    label: string
    color: ReturnType<typeof useTheme>["theme"]["text"]
    busy: boolean
  } {
    if (hasInput(sessionID)) return { label: "input", color: theme.warning, busy: false }
    if (isWorking(sessionID)) return { label: "working", color: theme.success, busy: true }
    return { label: "idle", color: theme.textMuted, busy: false }
  }

  return (
    <box
      width={40}
      flexShrink={0}
      height="100%"
      backgroundColor={theme.backgroundPanel}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
    >
      <text fg={theme.text}>
        <b>Attention</b>
      </text>
      <Show when={needsInput().length > 0} fallback={<text fg={theme.textMuted}>Nothing needs input.</text>}>
        <box gap={1}>
          <For each={needsInput()}>
            {(item) => (
              <RailItem
                title={sessions().get(item.sessionID)?.title ?? item.sessionID}
                label={item.kind}
                color={item.tone}
                onClick={() => open(item.sessionID)}
              />
            )}
          </For>
        </box>
      </Show>

      <box paddingTop={1} gap={1} flexGrow={1} minHeight={0}>
        <text fg={theme.text}>
          <b>Sessions</b>
        </text>
        <Show when={previousSessions().length > 0} fallback={<text fg={theme.textMuted}>No sessions yet.</text>}>
          <For each={previousSessions()}>
            {(session) => {
              const status = createMemo(() => sessionStatus(session.id))
              return (
                <SessionItem
                  title={session.title}
                  subtitle={relativeTime(session.time.updated)}
                  status={status().label}
                  statusColor={status().color}
                  busy={status().busy}
                  onClick={() => open(session.id)}
                />
              )
            }}
          </For>
        </Show>
      </box>
    </box>
  )
}

function RailItem(props: {
  title: string
  label: string
  color?: ReturnType<typeof useTheme>["theme"]["text"]
  onClick: () => void
}) {
  const { theme } = useTheme()
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundElement}
      onMouseUp={props.onClick}
      flexDirection="column"
    >
      <text fg={theme.text}>{Locale.truncate(props.title || "Untitled session", 30)}</text>
      <text fg={props.color ?? theme.textMuted}>{props.label}</text>
    </box>
  )
}

function SessionItem(props: {
  title: string
  subtitle: string
  status: string
  statusColor: ReturnType<typeof useTheme>["theme"]["text"]
  busy: boolean
  onClick: () => void
}) {
  const { theme } = useTheme()
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      backgroundColor={theme.backgroundElement}
      onMouseUp={props.onClick}
      flexDirection="column"
      gap={0}
    >
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme.text}>{Locale.truncate(props.title || "Untitled session", 24)}</text>
        <box flexDirection="row" gap={1}>
          <Show when={props.busy}>
            <Spinner color={props.statusColor} />
          </Show>
          <StatusPill label={props.status} color={props.statusColor} />
        </box>
      </box>
      <text fg={theme.textMuted}>{props.subtitle}</text>
    </box>
  )
}

function StatusPill(props: { label: string; color: ReturnType<typeof useTheme>["theme"]["text"] }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundPanel}>
      <text fg={props.color}>{props.label}</text>
    </box>
  )
}

function relativeTime(value: number) {
  const age = Math.max(0, Date.now() - value)
  if (age < 60_000) return "now"
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 24 * 60 * 60_000) return `${Math.floor(age / (60 * 60_000))}h ago`
  return `${Math.floor(age / (24 * 60 * 60_000))}d ago`
}
