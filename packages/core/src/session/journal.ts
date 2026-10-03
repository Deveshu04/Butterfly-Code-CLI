import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { JOURNAL_VERSION, JournalHeader, now, SessionEvent } from "./events"

export interface ReplayedJournal {
  header: JournalHeader
  events: SessionEvent[]
}

export class SessionJournal {
  private constructor(
    readonly path: string,
    readonly header: JournalHeader,
  ) {}

  private static pending = new Map<string, JournalHeader>()

  static create(dir: string, sessionId: string = crypto.randomUUID()): SessionJournal {
    const header: JournalHeader = {
      v: JOURNAL_VERSION,
      kind: "butterfly-session",
      sessionId,
      createdAt: now(),
    }
    const path = join(dir, `${sessionId}.jsonl`)
    SessionJournal.pending.set(path, header)
    return new SessionJournal(path, header)
  }

  /** True once the journal exists on disk (i.e. it has at least one event). */
  get persisted(): boolean {
    return !SessionJournal.pending.has(this.path)
  }

  static open(path: string): SessionJournal {
    const header = SessionJournal.readHeader(path)
    return new SessionJournal(path, header)
  }

  append(event: SessionEvent): void {
    const validated = SessionEvent.parse(event)
    const header = SessionJournal.pending.get(this.path)
    if (header) {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(header)}\n${JSON.stringify(validated)}\n`)
      SessionJournal.pending.delete(this.path)
      return
    }
    appendFileSync(this.path, `${JSON.stringify(validated)}\n`)
  }

  static replay(path: string): ReplayedJournal {
    const pendingHeader = SessionJournal.pending.get(path)
    if (pendingHeader && !existsSync(path)) return { header: pendingHeader, events: [] }
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
    const header = SessionJournal.parseHeader(lines[0] ?? "")
    const events = lines.slice(1).map((line, i) => {
      const lineNumber = i + 2
      let json: unknown
      try {
        json = JSON.parse(line)
      } catch {
        throw new Error(`Corrupt journal event at line ${lineNumber}: not valid JSON`)
      }
      const parsed = SessionEvent.safeParse(json)
      if (!parsed.success) {
        throw new Error(`Invalid journal event at line ${lineNumber}: ${parsed.error.message}`)
      }
      return parsed.data
    })
    return { header, events }
  }

  private static readHeader(path: string): JournalHeader {
    const pendingHeader = SessionJournal.pending.get(path)
    if (pendingHeader && !existsSync(path)) return pendingHeader
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0] ?? ""
    return SessionJournal.parseHeader(firstLine)
  }

  private static parseHeader(line: string): JournalHeader {
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      throw new Error("Invalid journal header: first line is not valid JSON")
    }
    const parsed = JournalHeader.safeParse(json)
    if (!parsed.success) {
      throw new Error(`Invalid journal header: ${parsed.error.message}`)
    }
    return parsed.data
  }
}
