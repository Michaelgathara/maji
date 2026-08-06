import { createMemo } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { explainRouteReason, routeTargetKey, routeTargetTitle, type RouteTarget } from "./prompt/routing-presentation"

export function DialogRouteTarget(props: {
  targets: RouteTarget[]
  current: RouteTarget
  onSelect: (target: RouteTarget) => void
}) {
  const dialog = useDialog()
  const current = createMemo(() => routeTargetKey(props.current))
  const options = createMemo(() =>
    props.targets
      .toSorted((a, b) => Number(routeTargetKey(b) === current()) - Number(routeTargetKey(a) === current()))
      .map((target) => ({
        title: routeTargetTitle(target),
        value: routeTargetKey(target),
        category: routeTargetKey(target) === current() ? "Selected" : undefined,
        description:
          target.type === "session"
            ? explainRouteReason(target.reason)
            : target.type === "new"
              ? "Start fresh"
              : "Keep working here",
      })),
  )

  return (
    <DialogSelect
      title="Choose a task"
      placeholder="Search tasks"
      options={options()}
      current={current()}
      footer={<text>Enter selects · esc keeps the current choice</text>}
      onSelect={(option) => {
        const target = props.targets.find((item) => routeTargetKey(item) === option.value)
        if (!target) return
        props.onSelect(target)
        dialog.clear()
      }}
    />
  )
}
