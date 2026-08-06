import { createMemo, For, Show } from "solid-js"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { Spinner } from "../../component/spinner"
import { useLocal } from "../../context/local"
import { useCommandShortcut } from "../../keymap"
import { compareWorkActivity, workDescription, workStatus, workStatusLabel, type WorkStatus } from "./activity"

export function HomeAttentionRail() {
  const route = useRoute()
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()

  const sessions = createMemo(() => new Map(sync.data.session.map((session) => [session.id, session])))
  const needsInput = createMemo(() => {
    const sessionIDs = new Set([...Object.keys(sync.data.permission), ...Object.keys(sync.data.question)])
    return [...sessionIDs]
      .flatMap((sessionID) => {
        const session = sessions().get(sessionID)
        if (!session) return []
        const permissions = sync.data.permission[sessionID]?.length ?? 0
        const questions = sync.data.question[sessionID]?.length ?? 0
        const count = permissions + questions
        if (count === 0) return []
        return [
          {
            sessionID,
            title: session.title,
            label:
              questions > 0
                ? questions === 1
                  ? "Answer question"
                  : `Answer ${questions} questions`
                : permissions === 1
                  ? "Review permission"
                  : `Review ${permissions} permissions`,
            tone: questions > 0 ? theme.accent : theme.warning,
            updated: session.time.updated,
          },
        ]
      })
      .toSorted((a, b) => b.updated - a.updated)
      .slice(0, 6)
  })
  const work = createMemo(() =>
    sync.data.session
      .filter((session) => !session.parentID && !session.time.archived)
      .map((session) => {
        const memory = local.session.routing(session.id)
        const status = workStatus({
          pending: inputCount(session.id),
          busy: isWorking(session.id),
          statusHint: memory?.statusHint,
        })
        return {
          session,
          status,
          description: workDescription({ ...memory, status }),
          updated: session.time.updated,
        }
      })
      .toSorted(compareWorkActivity),
  )
  const working = createMemo(() =>
    work()
      .filter((item) => item.status === "working")
      .slice(0, 4),
  )
  const recent = createMemo(() =>
    work()
      .filter((item) => item.status !== "needs-you" && item.status !== "working")
      .slice(0, 7),
  )

  function open(sessionID: string) {
    route.navigate({ type: "session", sessionID })
  }

  function inputCount(sessionID: string) {
    return (sync.data.permission[sessionID]?.length ?? 0) + (sync.data.question[sessionID]?.length ?? 0)
  }

  function isWorking(sessionID: string) {
    const status = sync.data.session_status[sessionID]
    return !!status && status.type !== "idle"
  }

  function statusColor(status: WorkStatus) {
    if (status === "needs-you") return theme.warning
    if (status === "working") return theme.success
    if (status === "done") return theme.accent
    return theme.textMuted
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
        <b>Needs you</b>
      </text>
      <Show when={needsInput().length > 0} fallback={<text fg={theme.textMuted}>Nothing needs you.</text>}>
        <box gap={1}>
          <For each={needsInput()}>
            {(item) => (
              <RailItem title={item.title} label={item.label} color={item.tone} onClick={() => open(item.sessionID)} />
            )}
          </For>
        </box>
      </Show>

      <Show when={working().length > 0}>
        <box paddingTop={1} gap={1}>
          <text fg={theme.text}>
            <b>Working</b>
          </text>
          <For each={working()}>
            {(item) => (
              <SessionItem
                title={item.session.title}
                subtitle={item.description ?? relativeTime(item.updated)}
                status={workStatusLabel(item.status)}
                statusColor={statusColor(item.status)}
                busy={true}
                onClick={() => open(item.session.id)}
              />
            )}
          </For>
        </box>
      </Show>

      <box paddingTop={1} gap={1} flexGrow={1} minHeight={0}>
        <text fg={theme.text}>
          <b>Recent tasks</b>
        </text>
        <Show when={recent().length > 0} fallback={<text fg={theme.textMuted}>No tasks yet.</text>}>
          <For each={recent()}>
            {(item) => (
              <SessionItem
                title={item.session.title}
                subtitle={item.description ?? relativeTime(item.updated)}
                status={workStatusLabel(item.status)}
                statusColor={statusColor(item.status)}
                busy={false}
                onClick={() => open(item.session.id)}
              />
            )}
          </For>
        </Show>
      </box>
    </box>
  )
}

export function HomeActivityStrip() {
  const route = useRoute()
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()
  const shortcut = useCommandShortcut("session.attention.jump")

  const activity = createMemo(() => {
    const sessions = sync.data.session.filter((session) => !session.parentID && !session.time.archived)
    const needsYou = sessions.filter(
      (session) => (sync.data.permission[session.id]?.length ?? 0) + (sync.data.question[session.id]?.length ?? 0) > 0,
    )
    const working = sessions.filter((session) => {
      if (needsYou.some((item) => item.id === session.id)) return false
      const status = sync.data.session_status[session.id]
      return !!status && status.type !== "idle"
    })
    const done = sessions.filter((session) => {
      if (Date.now() - session.time.updated >= 24 * 60 * 60_000) return false
      if (needsYou.some((item) => item.id === session.id)) return false
      if (working.some((item) => item.id === session.id)) return false
      return local.session.routing(session.id)?.statusHint === "done"
    })
    return { needsYou, working, done }
  })
  const target = createMemo(() => activity().needsYou[0] ?? activity().working[0] ?? activity().done[0])
  const summary = createMemo(() =>
    [
      { count: activity().needsYou.length, label: `${activity().needsYou.length} needs you`, color: theme.warning },
      { count: activity().working.length, label: `${activity().working.length} working`, color: theme.success },
      { count: activity().done.length, label: `${activity().done.length} done today`, color: theme.textMuted },
    ].filter((item) => item.count > 0),
  )

  return (
    <Show when={target()}>
      <box
        flexDirection="row"
        gap={1}
        paddingTop={1}
        onMouseUp={() => {
          const session = target()
          if (session) route.navigate({ type: "session", sessionID: session.id })
        }}
      >
        <For each={summary()}>
          {(item, index) => (
            <>
              <Show when={index() > 0}>
                <text fg={theme.textMuted}>·</text>
              </Show>
              <text fg={item.color}>{item.label}</text>
            </>
          )}
        </For>
        <Show when={shortcut() && (activity().needsYou.length > 0 || activity().working.length > 0)}>
          <text fg={theme.textMuted}>· {shortcut()} open</text>
        </Show>
      </box>
    </Show>
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
      <text fg={theme.text}>{Locale.truncate(props.title || "Untitled task", 30)}</text>
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
        <text fg={theme.text}>{Locale.truncate(props.title || "Untitled task", 22)}</text>
        <box flexDirection="row" gap={1}>
          <Show when={props.busy}>
            <Spinner color={props.statusColor} />
          </Show>
          <StatusPill label={props.status} color={props.statusColor} />
        </box>
      </box>
      <text fg={theme.textMuted}>{Locale.truncate(props.subtitle, 34)}</text>
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
