import { readdirSync, statSync, unlinkSync } from 'fs'
import { resolve } from 'path'

const directory = resolve(process.cwd(), 'runtime-backups')
const keep = Math.max(1, Number(process.env.RUNTIME_BACKUPS_KEEP || 10))
const apply = process.argv.includes('--apply')
const groups = new Map()

for (const name of readdirSync(directory, { withFileTypes: true })) {
  if (!name.isFile() || !name.name.endsWith('.bak')) continue
  const match = name.name.match(/^(.*)\.(\d+)\.bak$/)
  if (!match) continue
  const rows = groups.get(match[1]) || []
  rows.push({ name: name.name, time: Number(match[2]) })
  groups.set(match[1], rows)
}

let removed = 0
let bytes = 0
for (const rows of groups.values()) {
  rows.sort((a, b) => b.time - a.time)
  for (const row of rows.slice(keep)) {
    const path = resolve(directory, row.name)
    bytes += statSync(path).size
    removed += 1
    if (apply) unlinkSync(path)
  }
}

console.log(JSON.stringify({ apply, keep, removed, reclaimedBytes: bytes }))
