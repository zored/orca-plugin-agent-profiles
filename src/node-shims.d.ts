// Les typings d'Orca n'embarquent pas les types Node : on ne déclare que les membres réellement utilisés.
declare module 'node:fs' {
  export const constants: { X_OK: number }
  export function readdirSync(path: string): string[]
  export function existsSync(path: string): boolean
  export function mkdtempSync(prefix: string): string
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function accessSync(path: string, mode?: number): void
  export function writeFileSync(path: string, data: string, options?: { mode?: number }): void
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
}

declare module 'node:os' {
  export function tmpdir(): string
  export function homedir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export const posix: { join(...parts: string[]): string }
  export const win32: { join(...parts: string[]): string }
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean })
    exec(sql: string): void
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined
      run(...params: unknown[]): unknown
    }
    close(): void
  }
}

declare module 'node:child_process' {
  export type ChildProcess = {
    stdout: { on(event: 'data', listener: (chunk: { toString(): string }) => void): void } | null
    stderr: { on(event: 'data', listener: (chunk: { toString(): string }) => void): void } | null
    on(event: 'close', listener: (code: number | null) => void): void
    on(event: 'error', listener: (error: Error) => void): void
    kill(signal?: string): boolean
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: { stdio: readonly ('ignore' | 'pipe')[] }
  ): ChildProcess
}

declare const process: { env: Record<string, string | undefined>; platform: string }
