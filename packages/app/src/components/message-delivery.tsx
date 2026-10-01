import { Show } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"

export function MessageDelivery(props: { sessionID: string; messageID: string }) {
  const sync = useServerSync()
  const language = useLanguage()
  const entry = () => {
    const value = sync().outbox.entries[props.messageID]
    return value?.request.sessionID === props.sessionID ? value : undefined
  }
  return (
    <Show when={entry()}>
      {(entry) => (
        <div
          data-component="message-delivery"
          class="flex items-center gap-2 pt-1 text-12-regular text-text-weak"
          role="status"
        >
          <span>{language.t(`prompt.delivery.${entry().status}`)}</span>
          <Show when={entry().status === "failed" || entry().status === "paused"}>
            <button
              type="button"
              class="underline underline-offset-2 hover:text-text-strong focus-visible:outline focus-visible:outline-2"
              onClick={() =>
                void sync()
                  .outbox.retry(props.sessionID, props.messageID)
                  .catch((error: unknown) => console.error("Prompt retry failed", error))
              }
            >
              {language.t("prompt.delivery.retry")}
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}
