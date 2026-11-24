import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Profile } from './store'

const CHAT_TIMEOUT_MS = 60_000
const EXTRA_DIRS = ['/usr/local/bin', '/opt/homebrew/bin']

export type ChatRunner = (command: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>

export type ChatLauncher = (profile: Profile, workspaceId: string) => Promise<void>

export function opensAsChat(profile: Profile): boolean {
  return profile.providerId === null && profile.extraArgs.length === 0
}

export function worktreeSelector(workspaceId: string): string {
  if (/^(identity|folder|id):/.test(workspaceId)) return workspaceId
  if (workspaceId.includes('::')) return `id:${workspaceId}`
  throw new Error(`Unknown Orca workspace id format: ${workspaceId}`)
}

export function chatArgs(profile: Profile, workspaceId: string): string[] {
  const args = ['agent', 'launch', '--agent', profile.agentId, '--surface', 'chat', '--focus', '--json', '--worktree', worktreeSelector(workspaceId)]
  if (profile.model !== null) {
    args.push('--model', profile.model)
    if (profile.effort !== null) args.push('--effort', profile.effort)
  }
  return args
}

export function findOrca(pathEnv: string = process.env.PATH ?? ''): string {
  const dirs = [...pathEnv.split(':').filter((d) => d !== ''), ...EXTRA_DIRS]
  const found = dirs.map((d) => join(d, 'orca')).find((p) => existsSync(p))
  if (!found) throw new Error(`orca CLI not found in PATH or ${EXTRA_DIRS.join(', ')}`)
  return found
}

export const runProcess: ChatRunner = (command, args) =>
  new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`orca agent launch timed out after ${CHAT_TIMEOUT_MS / 1000}s`))
    }, CHAT_TIMEOUT_MS)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })

export async function launchChat(profile: Profile, workspaceId: string, run: ChatRunner = runProcess): Promise<void> {
  const { code, stdout, stderr } = await run(findOrca(), chatArgs(profile, workspaceId))
  if (code !== 0) throw new Error((stderr || stdout).trim() || `orca agent launch exited with ${code}`)
  const kind = (JSON.parse(stdout) as { result?: { outcome?: { kind?: string } } }).result?.outcome?.kind
  if (kind !== 'structured') throw new Error(`Orca opened ${kind ?? 'nothing'} instead of a chat`)
}
