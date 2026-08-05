import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  buildSkeleton,
  buildSystem,
  catalogCacheStatus,
  doctor,
  GraphDb,
  listSessions,
  loadConfig,
  loadMemory,
  ModelsCatalog,
  memoryPaths,
  renderDoctorReport,
  skillsIndex,
} from "@butterfly/core"

export async function runDoctorCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      cwd: { type: "string" },
      home: { type: "string" },
      json: { type: "boolean", default: false },
    },
  })
  const cwd = resolve(values.cwd ?? process.cwd())
  const home = values.home ?? homedir()

  const config = (() => {
    try {
      return loadConfig({ cwd, home })
    } catch {
      return {}
    }
  })()

  const modelRef = config.model
  const memory = loadMemory(memoryPaths(cwd, home))
  const skillDirs = [
    join(cwd, ".butterfly", "skills"),
    join(home, ".config", "butterfly", "skills"),
  ]
  const skillsIndexText = skillsIndex(skillDirs)
  const system = modelRef
    ? buildSystem(modelRef, {
        cwd,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
        projectMemory: memory.project,
        userMemory: memory.user,
        skillsIndex: skillsIndexText,
      })
    : ""

  const graphDbPath = join(cwd, ".butterfly", "graph.db")
  const graphAvailable = existsSync(graphDbPath)
  let graphSkeletonText = ""
  if (graphAvailable) {
    try {
      graphSkeletonText = buildSkeleton(GraphDb.open(graphDbPath))
    } catch {
      // present but unreadable — treat like unavailable, don't crash
    }
  }

  // Cache-only: never fetches, never writes models-cache.json.
  const catalogCachePath = join(home, ".config", "butterfly", "models-cache.json")
  const catalog = await ModelsCatalog.load({
    cachePath: catalogCachePath,
    cacheOnly: true,
  }).catch(() => ModelsCatalog.empty())
  const catalogStatus = catalogCacheStatus(catalogCachePath)

  // Never connect — just report what's configured.
  const mcpConfiguredNames = Object.keys(config.mcp ?? {})

  const sessions = listSessions(join(cwd, ".butterfly", "sessions"), 1)
  const journalPath = sessions[0]?.path

  const report = doctor({
    cwd,
    home,
    system,
    memoryText: memory.project + memory.user,
    skillsIndexText,
    graphSkeletonText,
    graphAvailable,
    ...(journalPath ? { journalPath } : {}),
    catalog,
    catalogStatus,
    mcpConfiguredNames,
  })

  if (values.json) {
    console.log(JSON.stringify(report))
  } else {
    console.log(renderDoctorReport(report))
  }
  return report.configLint.length > 0 ? 1 : 0
}
