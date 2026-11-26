import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogTitleGroup } from "@opencode/ui/dialog"
import { useDialog } from "@opencode/ui/context/dialog"
import { Session } from "@opencode/schema/session"
import { createEffect, createMemo, createSignal, For, on, onCleanup } from "solid-js"
import type { ComposerAdapter, ComposerSession } from "./adapter"
import type { ComposerSubmission } from "./machine"
import {
  createRoutingState,
  routingView,
  transitionRouting,
  type RoutingDestination,
  type RoutingDraft,
  type RoutingEvent,
} from "./routing-machine"
import { retryFingerprint } from "./retry"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData, useServer } from "@/runtime/server/current"
import { useTabs } from "@/shell/tabs/tabs"

export function createComposerRouting(adapter: ComposerAdapter) {
  const sdk = useServerSDK()
  const server = useServer()
  const data = useData()
  const tabs = useTabs()
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createSignal(createRoutingState())

  const dispatch = (event: RoutingEvent) => {
    const next = transitionRouting(state(), event)
    setState(next)

    return next
  }

  const draft = createMemo<RoutingDraft | undefined>(() => {
    const placement = adapter.routing?.()

    const text = adapter.state
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")

    if (!placement || !text.trim() || text.trimStart().startsWith("/") || adapter.state.mode.current() !== "normal")
      return

    return {
      ...placement,
      text,
      key: JSON.stringify([
        server.key,
        sdk.http.url,
        sdk.connection.attempt(),
        placement,
        adapter.state.current(),
        adapter.state.context.items(),
      ]),
    }
  })

  const view = createMemo(() => routingView(state()))

  const retryDestination = createMemo(() => {
    const retry = adapter.state.retry.current()
    const model = adapter.controls().model.selection.current()

    if (!retry?.route || !model || adapter.state.mode.current() !== "normal") return

    const fingerprint = retryFingerprint({
      mode: "normal",
      delivery: "steer",
      selection: {
        agent: adapter.controls().agents.current,
        model: { providerID: model.provider.id, modelID: model.id },
        variant: adapter.controls().model.selection.variant.current(),
      },
      prompt: adapter.state.current(),
      context: adapter.state.context.items(),
    })

    return fingerprint === retry.fingerprint ? retry.route : undefined
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const requests = new Map<number, AbortController>()

  const lookup = async (current: RoutingDraft, attempt: number) => {
    const controller = new AbortController()
    requests.set(attempt, controller)

    const result = await sdk.api.experimental.session
      .route(current, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .finally(() => requests.delete(attempt))

    dispatch({ type: "resolved", attempt, result })
  }

  createEffect(
    on(draft, (current) => {
      clearTimeout(timer)
      requests.forEach((request) => request.abort())
      const next = dispatch({ type: "changed", draft: current })

      if (!current) return
      timer = setTimeout(() => {
        void lookup(current, next.attempt).catch(() => dispatch({ type: "failed", attempt: next.attempt }))
      }, 300)
    }),
  )
  onCleanup(() => {
    clearTimeout(timer)
    requests.forEach((request) => request.abort())
    dispatch({ type: "dispose" })
  })

  const title = () => {
    const retry = retryDestination()
    const destination = retry ? { type: "session" as const, sessionID: retry.sessionID } : view().destination

    if (!destination) return language.t("prompt.routing.choose")

    if (destination.type === "new") return language.t("prompt.routing.new")

    if (destination.sessionID === draft()?.currentSessionID) return language.t("prompt.routing.current")

    return (
      data.session.get(destination.sessionID)?.title ??
      view().result?.candidates.find((candidate) => candidate.sessionID === destination.sessionID)?.title ??
      language.t("prompt.routing.choose")
    )
  }

  const choose = () => {
    if (retryDestination()) return
    const current = state()
    const placement = draft()

    if (!("draft" in current) || !placement || current.draft.key !== placement.key) return

    const options = [
      ...(placement.currentSessionID
        ? [
            {
              title: language.t("prompt.routing.current"),
              choice: { type: "session" as const, sessionID: placement.currentSessionID },
            },
          ]
        : []),
      ...(view().result?.candidates ?? [])
        .filter((candidate) => candidate.sessionID !== placement.currentSessionID)
        .map((candidate) => ({
          title: candidate.title,
          choice: { type: "session" as const, sessionID: candidate.sessionID },
        })),
      { title: language.t("prompt.routing.new"), choice: { type: "new" as const } },
    ]

    void dialog.show(() => (
      <Dialog>
        <DialogTitleGroup title={language.t("prompt.routing.choose")} />
        <DialogBody>
          <For each={options}>
            {(option) => (
              <Button
                variant="ghost"
                onClick={() => {
                  dispatch({ type: "choose", attempt: current.attempt, choice: option.choice })
                  dialog.close()
                }}
              >
                {option.title}
              </Button>
            )}
          </For>
        </DialogBody>
      </Dialog>
    ))
  }

  const sessionFor = async (sessionID: string): Promise<ComposerSession> => {
    const info =
      data.session.get(sessionID) ?? (await sdk.api.session.get({ sessionID }, { signal: AbortSignal.timeout(10_000) }))

    data.session.remember(info)

    return {
      id: sessionID,
      directory: info.location.directory,
      handoff: server.ctx.handoff.forSession(sessionID),
      api: sdk.api.session,
      file: sdk.api.file,
      data,
      current: () => data.session.get(sessionID),
      admitted: (messageID) =>
        data.session.input.has(sessionID, messageID) || !!data.session.message.get(sessionID, messageID),
    }
  }

  const open = (sessionID: string) => () => {
    tabs.select(tabs.addSessionTab({ server: server.key, sessionId: sessionID }))
  }

  const materialize = async (value: ComposerSubmission, destination: RoutingDestination) => {
    if (destination.type === "new" && adapter.kind === "new-session") return "new" as const
    const retry = adapter.state.retry.current()
    const pinned = retry?.id === value.id ? retry.route : undefined

    const route = pinned ?? {
      sessionID: destination.type === "session" ? destination.sessionID : Session.ID.create(),
      directory: adapter.routing?.()?.directory ?? "",
      create: destination.type === "new",
    }

    adapter.state.retry.set({ id: value.id, fingerprint: retryFingerprint(value), route })

    if (route.create)
      await sdk.api.session.create(
        {
          id: route.sessionID,
          location: { directory: route.directory },
          agent: value.selection.agent,
          model: {
            id: value.selection.model.modelID,
            providerID: value.selection.model.providerID,
            variant: value.selection.variant,
          },
        },
        { signal: AbortSignal.timeout(15_000) },
      )

    const session =
      adapter.kind === "active-session" && route.sessionID === adapter.session().id
        ? adapter.session()
        : await sessionFor(route.sessionID)

    return {
      session:
        route.sessionID === adapter.routing?.()?.currentSessionID
          ? session
          : { ...session, onPromptAdmitted: open(route.sessionID) },
    }
  }

  return {
    title,
    choose,
    locked: () => !!retryDestination(),
    visible: () => {
      const result = view().result

      return (
        !!draft() &&
        (view().manual ||
          (!!result &&
            (result.candidates.length > 0 ||
              result.decision.type === "uncertain" ||
              (result.decision.type === "new" && !!draft()?.currentSessionID))))
      )
    },
    async resolve(value: ComposerSubmission) {
      const current = draft()

      if (!current) return "new" as const

      // A captured send may outlive an edit, location switch, or reconnect while images resolve.
      if (value.text !== current.text) return
      const retry = adapter.state.retry.current()
      const pinned = retry?.id === value.id ? retry.route : undefined

      if (!pinned && !view().destination && !view().result) {
        clearTimeout(timer)
        requests.forEach((request) => request.abort())
        dispatch({ type: "changed", draft: current })
        const next = dispatch({ type: "resolve" })

        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the composer's notifier owns formatting opaque transport failures
        const settled = await lookup(current, next.attempt).catch((error: unknown) => {
          if (state().attempt !== next.attempt || current.key !== draft()?.key) return false
          dispatch({ type: "failed", attempt: next.attempt })
          throw error
        })

        if (settled === false || state().attempt !== next.attempt) return
      }

      const latest = state()

      if (!("draft" in latest) || latest.draft.key !== current.key || current.key !== draft()?.key) return
      const destination = pinned ? { type: "session" as const, sessionID: pinned.sessionID } : view().destination

      if (!destination) {
        choose()

        return
      }

      const resolved = await materialize(value, destination)

      if (state().type === "disposed" || current.key !== draft()?.key) return

      return resolved
    },
  }
}
