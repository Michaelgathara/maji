import { registerCustomTheme } from "@pierre/diffs"
import { MajiTheme } from "./marked-theme"

let registered = false

export function registerMajiTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("Maji", () => Promise.resolve(MajiTheme))
}

export const registerOpenCodeTheme = registerMajiTheme
