import { execFileSync } from 'node:child_process'
import path from 'node:path'

const extractCommand = Buffer.from(`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($env:SUNYU_ZIP_ARCHIVE, $env:SUNYU_ZIP_DESTINATION)
`, 'utf16le').toString('base64')

export function extractWindowsZip(archive, destination) {
  // Windows tar.exe can round-trip argv through the active ANSI code page.
  // Keep paths in Unicode environment variables and never interpolate shell code.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', extractCommand], {
    env: { ...process.env, SUNYU_ZIP_ARCHIVE: path.resolve(archive), SUNYU_ZIP_DESTINATION: path.resolve(destination) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000,
  })
}
