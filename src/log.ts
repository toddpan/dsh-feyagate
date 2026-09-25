/**
 * Log capture.
 *
 * Three consumers, one buffer: the plugin's own messages, the child process's
 * stdout/stderr, and the settings UI. Keeping them in one ring buffer means the
 * log pane shows cause and effect in order — a crash line followed by the
 * supervisor's reaction — instead of two interleaved streams.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { LOG_BUFFER_LINES } from './constants.js'
import type { LogLine } from './types.js'

export type LogLevel = LogLine['level']
export type LogSource = LogLine['source']

const MAX_LINE_LENGTH = 4000

/** Bound a single line so a runaway process cannot pin memory. */
function clamp(text: string): string {
  const flat = text.replace(/\r/g, '')
  return flat.length > MAX_LINE_LENGTH ? `${flat.slice(0, MAX_LINE_LENGTH)}…[截断]` : flat
}

export class LogBuffer {
  private readonly lines: LogLine[] = []
  private readonly listeners = new Set<(line: LogLine) => void>()
  private logFile: string | null = null

  /** Mirror every line into a file once the install layout exists. */
  attachFile(file: string): void {
    this.logFile = file
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch {
      this.logFile = null
    }
  }

  push(level: LogLevel, source: LogSource, text: string): void {
    const line: LogLine = { ts: Date.now(), level, source, text: clamp(text) }
    this.lines.push(line)
    if (this.lines.length > LOG_BUFFER_LINES) this.lines.splice(0, this.lines.length - LOG_BUFFER_LINES)
    if (this.logFile !== null) {
      try {
        appendFileSync(this.logFile, `${new Date(line.ts).toISOString()} [${source}] ${level}: ${line.text}\n`)
      } catch {
        this.logFile = null
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(line)
      } catch {
        /* a broken listener must not break logging */
      }
    }
  }

  info(text: string, source: LogSource = 'plugin'): void {
    this.push('info', source, text)
  }

  warn(text: string, source: LogSource = 'plugin'): void {
    this.push('warn', source, text)
  }

  error(text: string, source: LogSource = 'plugin'): void {
    this.push('error', source, text)
  }

  /** Most recent lines, oldest first. `limit` is clamped to the buffer size. */
  tail(limit: number): LogLine[] {
    if (limit >= this.lines.length) return [...this.lines]
    return this.lines.slice(this.lines.length - limit)
  }

  /** Lines strictly newer than `sinceTs`, for incremental UI polling. */
  since(sinceTs: number, limit: number): LogLine[] {
    const fresh = this.lines.filter((line) => line.ts > sinceTs)
    return fresh.length > limit ? fresh.slice(fresh.length - limit) : fresh
  }

  subscribe(listener: (line: LogLine) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  clear(): void {
    this.lines.length = 0
  }
}
