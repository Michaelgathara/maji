import { type ContextItem, type Prompt, type usePrompt } from "@/context/prompt"

type PromptTarget = ReturnType<ReturnType<typeof usePrompt>["capture"]>

export function createPromptSubmissionState(input: {
  target: PromptTarget
  prompt: Prompt
  context: (ContextItem & { key: string })[]
}) {
  const initial = input.target
  const baseline = { initial: input.prompt, target: input.prompt }
  let target = input.target
  let cleared: Prompt | undefined

  return {
    prompt: JSON.parse(JSON.stringify(input.prompt)) as Prompt,
    context: JSON.parse(JSON.stringify(input.context)) as typeof input.context,
    target: () => target,
    clear() {
      if (target.current() !== baseline.target) return false
      if (initial !== target && initial.current() === baseline.initial) initial.reset()
      target.reset()
      cleared = target.current()
      return true
    },
    retarget(next: PromptTarget) {
      input.context.forEach(next.context.add)
      target = next
      baseline.target = next.current()
    },
    current: (value: PromptTarget) => target === value,
    restore() {
      if (cleared === undefined || target.current() !== cleared) return
      return { target, prompt: input.prompt, context: input.context }
    },
  }
}
