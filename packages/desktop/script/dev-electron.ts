import { $ } from "bun"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export async function prepareDevElectron() {
  const electron = dirname(fileURLToPath(import.meta.resolve("electron/package.json")))
  const icon = Bun.file(join(import.meta.dirname, "../icons/dev/icon.icns"))

  const hash = new Bun.CryptoHasher("sha256")
    .update(electron)
    .update(process.arch)
    .update(await Bun.file(join(electron, "package.json")).text())
    .update(await icon.arrayBuffer())
    .update(await Bun.file(import.meta.filename).text())
    .digest("hex")
    .slice(0, 16)

  // File-provider-backed checkouts can restore Finder metadata immediately after cleanup.
  const root = join(tmpdir(), "opencode-dev-electron", hash)
  const bundle = join(root, "OpenCode Dev.app")
  // Electron uses the executable's name to distinguish development from packaged apps.
  const executable = join(bundle, "Contents/MacOS/Electron")

  if (await Bun.file(join(root, "ready")).exists()) return executable

  // macOS reads the Dock and app-switcher identity from the bundle, even after app.setName().
  await $`mkdir -p ${root}`
  await $`ditto ${join(electron, "dist/Electron.app")} ${bundle}`
  const plist = join(bundle, "Contents/Info.plist")

  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    await $`plutil -replace ${key} -string ${"OpenCode Dev"} ${plist}`
  }

  await $`plutil -replace CFBundleIdentifier -string ai.opencode.desktop.dev ${plist}`
  await $`plutil -insert NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac -bool true ${plist}`
  await Bun.write(join(bundle, "Contents/Resources/electron.icns"), icon)
  // Copied Finder metadata and resource forks are rejected by codesign.
  await $`xattr -cr ${bundle}`
  // Changing the bundle resources invalidates Electron's signature.
  await $`codesign --force --deep --sign - ${bundle}`
  await Bun.write(join(root, "ready"), "")

  return executable
}
