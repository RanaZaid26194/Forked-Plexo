#!/usr/bin/env node
// Builds the Chrome and Firefox companion extensions and packages each variant into dist/ with
// manifest.json at the archive root so GitHub Releases carry ready-to-load extension zips.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const version = pkg.version

/** Recursively collects files under `dir`, returning sorted `{ name, fullPath }` with POSIX separators. */
function collectFiles(dir, base = dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
  const files = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, base))
    } else if (entry.isFile()) {
      files.push({
        name: relative(base, fullPath).replace(/\\/g, '/'),
        fullPath
      })
    }
  }
  return files
}

/** Creates a deterministic deflate-compressed ZIP archive with UTF-8 POSIX entry names. */
function createZip(sourceDir, outFile) {
  const files = collectFiles(sourceDir)
  const localParts = []
  const centralParts = []
  let offset = 0

  // Fixed MS-DOS timestamp (2026-01-01 00:00:00) for reproducible builds across runners.
  const dosTime = 0x0000
  const dosDate = 0x5c21
  const utf8Flag = 0x0800
  const deflateMethod = 8

  for (const { name, fullPath } of files) {
    const raw = readFileSync(fullPath)
    const compressed = deflateRawSync(raw)
    const checksum = crc32(raw) >>> 0
    const nameBuf = Buffer.from(name, 'utf-8')

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(utf8Flag, 6)
    localHeader.writeUInt16LE(deflateMethod, 8)
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(raw.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, nameBuf, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE((3 << 8) | 20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(utf8Flag, 8)
    centralHeader.writeUInt16LE(deflateMethod, 10)
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(raw.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    centralParts.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + compressed.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  writeFileSync(outFile, Buffer.concat([...localParts, centralDir, eocd]))
}

execFileSync(process.execPath, [join(root, 'extension', 'build.mjs')], { stdio: 'inherit' })

const distDir = join(root, 'dist')
mkdirSync(distDir, { recursive: true })

for (const browser of ['chrome', 'firefox']) {
  const sourceDir = join(root, 'extension', 'dist', browser)
  const outZip = join(distDir, `plexo-extension-${version}-${browser}.zip`)
  rmSync(outZip, { force: true })
  createZip(sourceDir, outZip)
  console.log(`Packaged ${outZip}`)
}
