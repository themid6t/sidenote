# Installs `sidenote` on Windows. The only requirement is Claude Code.
#   irm https://raw.githubusercontent.com/themid6t/sidenote/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = if ($env:SIDENOTE_REPO) { $env:SIDENOTE_REPO } else { 'themid6t/sidenote' }
$dest = if ($env:SIDENOTE_BIN) { $env:SIDENOTE_BIN } else { Join-Path $env:LOCALAPPDATA 'sidenote\bin' }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$url = "https://github.com/$repo/releases/latest/download/sidenote-windows-x64.exe"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile (Join-Path $dest 'sidenote.exe') -UseBasicParsing
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($path -split ';') -notcontains $dest) {
  [Environment]::SetEnvironmentVariable('Path', "$dest;$path", 'User')
  Write-Host "Added $dest to your PATH (open a new terminal to use it)."
}
Write-Host "Installed $dest\sidenote.exe"
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host 'Next: install Claude Code (https://claude.com/claude-code) and run `claude` once to sign in.' }
Write-Host 'Try: sidenote 1706.03762'
