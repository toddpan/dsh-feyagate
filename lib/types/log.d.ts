/**
 * Log capture.
 *
 * Three consumers, one buffer: the plugin's own messages, the child process's
 * stdout/stderr, and the settings UI. Keeping them in one ring buffer means the
 * log pane shows cause and effect in order — a crash line followed by the
 * supervisor's reaction — instead of two interleaved streams.
 */
import type { LogLine } from './types.js';
export type LogLevel = LogLine['level'];
export type LogSource = LogLine['source'];
export declare class LogBuffer {
    private readonly lines;
    private readonly listeners;
    private logFile;
    /** Mirror every line into a file once the install layout exists. */
    attachFile(file: string): void;
    push(level: LogLevel, source: LogSource, text: string): void;
    info(text: string, source?: LogSource): void;
    warn(text: string, source?: LogSource): void;
    error(text: string, source?: LogSource): void;
    /** Most recent lines, oldest first. `limit` is clamped to the buffer size. */
    tail(limit: number): LogLine[];
    /** Lines strictly newer than `sinceTs`, for incremental UI polling. */
    since(sinceTs: number, limit: number): LogLine[];
    subscribe(listener: (line: LogLine) => void): () => void;
    clear(): void;
}
