// Release targets: npm package suffix, Node's platform/arch, archive format.
export interface Target {
  id: string
  os: "linux" | "darwin" | "win32"
  cpu: "x64" | "arm64"
  exe: string
  archive: "tar.gz" | "zip"
}

export const TARGETS: Target[] = [
  { id: "linux-x64", os: "linux", cpu: "x64", exe: "butterfly", archive: "tar.gz" },
  { id: "linux-arm64", os: "linux", cpu: "arm64", exe: "butterfly", archive: "tar.gz" },
  { id: "darwin-x64", os: "darwin", cpu: "x64", exe: "butterfly", archive: "tar.gz" },
  { id: "darwin-arm64", os: "darwin", cpu: "arm64", exe: "butterfly", archive: "tar.gz" },
  { id: "windows-x64", os: "win32", cpu: "x64", exe: "butterfly.exe", archive: "zip" },
]

export function currentTarget(): Target {
  const found = TARGETS.find((t) => t.os === process.platform && t.cpu === process.arch)
  if (!found) throw new Error(`no release target for ${process.platform}-${process.arch}`)
  return found
}

export const REPO = "Deveshu04/Butterfly-Code-CLI"
export const NPM_NAME = "butterfly-code"
