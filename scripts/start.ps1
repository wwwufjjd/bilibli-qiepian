$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $root

if (-not (Test-Path (Join-Path $root "node_modules"))) {
  npm install
}

npm run dev
