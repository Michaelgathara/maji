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
          description: memory?.summary ?? session.directory,
          details: [memory?.taskType, memory?.canonicalTopic, memory?.currentStatus, memory?.outcome].filter(
            (item): item is string => !!item,
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
      toast.show({ message: "Choose a model and agent before sending the prompt again.", variant: "warning" })
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
        message: `Sent a copy to ${Locale.truncate(session?.title ?? sessionID, 36)}`,
        variant: "success",
        duration: 2500,
      })
      dialog.clear()
      route.navigate({ type: "session", sessionID })
    } catch (error) {
      toast.show({
        title: "Failed to send prompt copy",
        message: errorMessage(error),
        variant: "error",
      })
    }
  }

  const latest = record()
  return (
    <DialogSelect
      title="Send last prompt again"
      placeholder="Choose another task"
      options={options()}
      current={latest?.sessionID}
      emptyView={<text>No other tasks yet.</text>}
      footer={
        latest ? (
          <box flexDirection="column">
            <text>This sends a copy. The original task is not cancelled.</text>
            <text>{Locale.truncate(latest.prompt, 90)}</text>
            <text>
              {latest.kind === "created" ? "Originally created" : "Originally routed"} to{" "}
              {Locale.truncate(latest.title, 36)} via {latest.reason}
            </text>
          </box>
        ) : (
          <text>No routed prompt has been recorded yet.</text>
        )
      }
      onSelect={(option) => {
        void submit(option.value)
      }}
    />
  )
}
