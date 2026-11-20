import { Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { useServer } from "@/runtime/server/current"

export function MessageDelivery(props: { sessionID: string; messageID: string }) {
  const outbox = useServer().ctx.data.outbox
  const entry = () => outbox.entries[props.messageID]

  return (
    <Show when={entry()}>
      {(value) => (
        <div class="mx-auto flex w-full max-w-session items-center gap-2 px-4 pb-2 text-12 text-text-weak">
          <span>
            {value().status === "sending"
              ? "Saving message…"
              : value().status === "reconnecting"
                ? "Saved · reconnecting"
                : "Saved · delivery needs attention"}
          </span>
          <Show when={value().status === "failed"}>
            <Button
              type="button"
              variant="ghost-faint"
              size="small"
              onClick={() => void outbox.retry(props.sessionID, props.messageID)}
            >
              Retry
            </Button>
          </Show>
        </div>
      )}
    </Show>
  )
}
