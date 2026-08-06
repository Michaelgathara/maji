import { createMemo, onMount } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { Locale } from "../util/locale"
import { errorMessage } from "../util/error"

export function DialogRouteCorrection() {
  const dialog = useDialog()
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()

  onMount(() => {
    void local.session.refreshRouting()
  })

  const record = createMemo(() => local.session.lastRoute())
  const sessions = createMemo(() => new Map(sync.data.session.map((session) => [session.id, session])))
  const currentTarget = createMemo(() => {
    const item = record()
    return item?.correctedTo ?? item?.sessionID
  })
  const options = createMemo(() =>
    sync.data.session
      .filter((session) => !session.parentID && !session.time.archived)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .map((session) => {
        const memory = local.session.routing(session.id)
        return {
          title: session.title,
          value: session.id,
          category: session.id === record()?.sessionID ? "Original task" : undefined,
          disabled: session.id === currentTarget(),
          description: Locale.truncate(
            memory?.outcome ?? memory?.canonicalTopic ?? memory?.taskType ?? session.directory,
            48,
          ),
        }
      }),
  )

  const submit = async (sessionID: string) => {
    const item = record()
    if (!item) return
    const model = local.model.current()
    const agent = local.agent.current()
    if (!model || !agent) {
      toast.show({ message: "Choose a model and agent first.", variant: "warning" })
      return
    }
    try {
      await sdk.client.session.prompt(
        {
          sessionID,
          ...model,
          agent: agent.name,
          model,
          variant: local.model.variant.current(),
          parts: [
            {
              type: "text",
              text: item.prompt,
            },
          ],
        },
        { throwOnError: true },
      )
      const session = sessions().get(sessionID)
      local.session.correctRoute(item.id, sessionID)
      local.session.recordRoute({
        prompt: item.prompt,
        sessionID,
        title: session?.title ?? sessionID,
        reason: `corrected from ${item.title}`,
        kind: "corrected",
      })
      toast.show({
        message: `Also sent to ${Locale.truncate(session?.title ?? sessionID, 36)}`,
        variant: "success",
        duration: 2500,
      })
      dialog.clear()
      route.navigate({ type: "session", sessionID })
    } catch (error) {
      toast.show({
        title: "Could not send prompt",
        message: errorMessage(error),
        variant: "error",
      })
    }
  }

  const latest = record()
  return (
    <DialogSelect
      title="Send last prompt elsewhere"
      placeholder="Choose a task"
      options={options()}
      current={latest?.sessionID}
      emptyView={<text>No other tasks yet.</text>}
      footer={
        latest ? (
          <box flexDirection="column">
            <text>The original task stays unchanged.</text>
            <text>{Locale.truncate(latest.prompt, 90)}</text>
            <text>First sent to {Locale.truncate(latest.title, 36)}</text>
          </box>
        ) : (
          <text>No automatic task choice has been made yet.</text>
        )
      }
      onSelect={(option) => {
        void submit(option.value)
      }}
    />
  )
}
