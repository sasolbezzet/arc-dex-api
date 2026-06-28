import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export function readJsonFile(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8') || JSON.stringify(fallback))
  } catch {
    try {
      return JSON.parse(readFileSync(`${path}.bak`, 'utf8'))
    } catch {
      return fallback
    }
  }
}

export function atomicWriteJsonFile(path, value) {
  const directory = dirname(path)
  if (directory && directory !== '.') mkdirSync(directory, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}
