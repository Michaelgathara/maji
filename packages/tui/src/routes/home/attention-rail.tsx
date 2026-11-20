import type { RGBA } from "@opentui/core"
import { createMemo, createResource, For, Show, type JSX } from "solid-js"
import { Spinner } from "../../component/spinner"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { compareWorkActivity, workDescription, workStatus, workStatusLabel, type WorkStatus } from "./activity"

export function HomeAttentionRail() {
  const data = useData()
  const client = useClient()
  const route = useRoute()
  const theme = useTheme()
  const roots = createMemo(() =>
    data.session
      .list()
      .filter((session) => !session.parentID && session.time.archived === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated),
  )
  const [cards] = createResource(
    () =>
      roots()
        .map((session) => `${session.id}:${session.time.updated}`)
        .join(","),
    () => client.api.experimental.session.routing.cards().catch(() => []),
  )
  const memories = createMemo(() => new Map((cards() ?? []).map((entry) => [entry.sessionID, entry.card])))

  const work = createMemo(() =>
    roots()
      .map((session) => {
        const memory = memories().get(session.id)
        const pending = inputCount(data, session.id)
        const status = workStatus({
          pending: pending || memory?.statusHint === "needs-input" ? Math.max(1, pending) : 0,
          busy: data.session.status(session.id) === "running",
          statusHint: memory?.statusHint,
        })
        return {
          session,
          pending,
          status,
          description: workDescription({ ...memory, status }),
          updated: session.time.updated,
        }
      })
      .toSorted(compareWorkActivity),
  )
  const needsInput = createMemo(() =>
    work()
      .filter((item) => item.status === "needs-you")
      .slice(0, 5),
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

  const open = (sessionID: string) => route.navigate({ type: "session", sessionID })
  const color = (status: WorkStatus) => {
    if (status === "needs-you") return theme.text.feedback.warning.base
    if (status === "working") return theme.text.feedback.success.base
    if (status === "done") return theme.text.action.primary.base
    return theme.text.muted
  }

  return (
    <box
      width={38}
      flexShrink={0}
      height="100%"
      backgroundColor={theme.background.raised.base}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
    >
      <RailSection title="Needs you" empty="Nothing needs you." items={needsInput()}>
        {(item) => (
          <TaskItem
            title={item.session.title ?? "Untitled task"}
            subtitle={item.pending > 0 ? inputLabel(item.pending) : (item.description ?? "Needs your input")}
            status="needs you"
            color={color(item.status)}
            onClick={() => open(item.session.id)}
          />
        )}
      </RailSection>
      <Show when={working().length > 0}>
        <RailSection title="Working" items={working()}>
          {(item) => (
            <TaskItem
              title={item.session.title ?? "Untitled task"}
              subtitle={item.description ?? relativeTime(item.updated)}
              status={workStatusLabel(item.status)}
              color={color(item.status)}
              busy
              onClick={() => open(item.session.id)}
            />
          )}
        </RailSection>
      </Show>
      <RailSection title="Recent tasks" empty="No tasks yet." items={recent()} grow>
        {(item) => (
          <TaskItem
            title={item.session.title ?? "Untitled task"}
            subtitle={item.description ?? relativeTime(item.updated)}
            status={workStatusLabel(item.status)}
            color={color(item.status)}
            onClick={() => open(item.session.id)}
          />
        )}
      </RailSection>
    </box>
  )
}

export function HomeActivityStrip() {
  const data = useData()
  const route = useRoute()
  const theme = useTheme()
  const activity = createMemo(() => {
    const roots = data.session.list().filter((session) => !session.parentID && session.time.archived === undefined)
    const needsYou = roots.filter((session) => inputCount(data, session.id) > 0)
    const working = roots.filter(
      (session) => !needsYou.some((item) => item.id === session.id) && data.session.status(session.id) === "running",
    )
    return { needsYou, working }
  })
  const target = createMemo(() => activity().needsYou[0] ?? activity().working[0])

  return (
    <Show when={target()}>
      {(session) => (
        <box
          flexDirection="row"
          gap={1}
          paddingTop={1}
          onMouseUp={() => route.navigate({ type: "session", sessionID: session().id })}
        >
          <Show when={activity().needsYou.length > 0}>
            <text fg={theme.text.feedback.warning.base}>{activity().needsYou.length} needs you</text>
          </Show>
          <Show when={activity().needsYou.length > 0 && activity().working.length > 0}>
            <text fg={theme.text.muted}>·</text>
          </Show>
          <Show when={activity().working.length > 0}>
            <text fg={theme.text.feedback.success.base}>{activity().working.length} working</text>
          </Show>
        </box>
      )}
    </Show>
  )
}

function RailSection<T>(props: {
  title: string
  empty?: string
  items: readonly T[]
  grow?: boolean
  children: (item: T) => JSX.Element
}) {
  const theme = useTheme()
  return (
    <box gap={1} flexGrow={props.grow ? 1 : 0} minHeight={0}>
      <text fg={theme.text.base}>
        <b>{props.title}</b>
      </text>
      <Show when={props.items.length > 0} fallback={<text fg={theme.text.muted}>{props.empty}</text>}>
        <For each={props.items}>{props.children}</For>
      </Show>
    </box>
  )
}

function TaskItem(props: {
  title: string
  subtitle: string
  status: string
  color: RGBA
  busy?: boolean
  onClick: () => void
}) {
  const theme = useTheme()
  return (
    <box paddingLeft={1} paddingRight={1} onMouseUp={props.onClick} gap={0}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme.text.base}>{Locale.truncate(props.title, 21)}</text>
        <box flexDirection="row" gap={1}>
          <Show when={props.busy}>
            <Spinner color={props.color} />
          </Show>
          <text fg={props.color}>{props.status}</text>
        </box>
      </box>
      <text fg={theme.text.muted}>{Locale.truncate(props.subtitle, 32)}</text>
    </box>
  )
}

function inputCount(data: ReturnType<typeof useData>, sessionID: string) {
  return (data.session.permission.list(sessionID)?.length ?? 0) + (data.session.form.list(sessionID)?.length ?? 0)
}

function inputLabel(count: number) {
  return count === 1 ? "One request waiting" : `${count} requests waiting`
}

function relativeTime(value: number) {
  const age = Math.max(0, Date.now() - value)
  if (age < 60_000) return "now"
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 24 * 60 * 60_000) return `${Math.floor(age / (60 * 60_000))}h ago`
  return `${Math.floor(age / (24 * 60 * 60_000))}d ago`
}
