/**
 * Log capture.
 *
 * Three consumers, one buffer: the plugin's own messages, the child process's
 * stdout/stderr, and the settings UI. Keeping them in one ring buffer means the
 * log pane shows cause and effect in order — a crash line followed by the
 * supervisor's reaction — instead of two interleaved streams.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOG_BUFFER_LINES } from './constants.js';
const MAX_LINE_LENGTH = 4000;
/** Bound a single line so a runaway process cannot pin memory. */
function clamp(text) {
    const flat = text.replace(/\r/g, '');
    return flat.length > MAX_LINE_LENGTH ? `${flat.slice(0, MAX_LINE_LENGTH)}…[截断]` : flat;
}
export class LogBuffer {
    lines = [];
    listeners = new Set();
    logFile = null;
    /** Mirror every line into a file once the install layout exists. */
    attachFile(file) {
        this.logFile = file;
        try {
            mkdirSync(dirname(file), { recursive: true });
        }
        catch {
            this.logFile = null;
        }
    }
    push(level, source, text) {
        const line = { ts: Date.now(), level, source, text: clamp(text) };
        this.lines.push(line);
        if (this.lines.length > LOG_BUFFER_LINES)
            this.lines.splice(0, this.lines.length - LOG_BUFFER_LINES);
        if (this.logFile !== null) {
            try {
                appendFileSync(this.logFile, `${new Date(line.ts).toISOString()} [${source}] ${level}: ${line.text}\n`);
            }
            catch {
                this.logFile = null;
            }
        }
        for (const listener of this.listeners) {
            try {
                listener(line);
            }
            catch {
                /* a broken listener must not break logging */
            }
        }
    }
    info(text, source = 'plugin') {
        this.push('info', source, text);
    }
    warn(text, source = 'plugin') {
        this.push('warn', source, text);
    }
    error(text, source = 'plugin') {
        this.push('error', source, text);
    }
    /** Most recent lines, oldest first. `limit` is clamped to the buffer size. */
    tail(limit) {
        if (limit >= this.lines.length)
            return [...this.lines];
        return this.lines.slice(this.lines.length - limit);
    }
    /** Lines strictly newer than `sinceTs`, for incremental UI polling. */
    since(sinceTs, limit) {
        const fresh = this.lines.filter((line) => line.ts > sinceTs);
        return fresh.length > limit ? fresh.slice(fresh.length - limit) : fresh;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    clear() {
        this.lines.length = 0;
    }
}
//# sourceMappingURL=log.js.map