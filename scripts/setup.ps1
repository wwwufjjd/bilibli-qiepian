param(
  [switch]$SkipNpm,
  [switch]$WithQwen,
  [ValidateSet("0.6B", "1.7B")]
  [string]$QwenModelSize = "0.6B",
  [switch]$WithBiliup
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $root

function Require-Command($name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Missing command: $name"
  }
  return $cmd.Source
}

function Ensure-Dir($path) {
  New-Item -ItemType Directory -Force -Path $path | Out-Null
}

function Download-File($url, $target, [int64]$minBytes = 1) {
  Ensure-Dir (Split-Path -Parent $target)
  if ((Test-Path $target) -and ((Get-Item $target).Length -ge $minBytes)) {
    Write-Host "[skip] $target"
    return
  }
  Write-Host "[download] $url"
  & curl.exe -L --retry 3 --retry-delay 2 -o $target $url
  if (-not (Test-Path $target) -or ((Get-Item $target).Length -lt $minBytes)) {
    throw "Downloaded file is incomplete: $target"
  }
}

function Patch-QwenExporter($releaseRoot) {
  $exporter = Join-Path $releaseRoot "qwen_asr_gguf\inference\exporters.py"
  if (-not (Test-Path $exporter)) {
    return
  }
  $text = Get-Content $exporter -Raw -Encoding UTF8
  $text = $text.Replace('print(f"✅ 已生成字幕文件: {path}")', 'print(f"已生成字幕文件: {path}")')
  $text = $text.Replace('print(f"✅ 已导出时间戳: {path}")', 'print(f"已导出时间戳: {path}")')
  $text = $text.Replace('print(f"✅ 已保存文本文件: {path}")', 'print(f"已保存文本文件: {path}")')
  Set-Content $exporter $text -Encoding UTF8
}

function Ensure-HardlinkOrCopy($source, $target) {
  if (-not (Test-Path $source) -or (Test-Path $target)) {
    return
  }
  try {
    New-Item -ItemType HardLink -Path $target -Target $source | Out-Null
  } catch {
    Copy-Item -Path $source -Destination $target -Force
  }
}

Require-Command "node" | Out-Null
Require-Command "npm" | Out-Null
Require-Command "curl.exe" | Out-Null
Require-Command "ffmpeg" | Out-Null

if (-not $SkipNpm) {
  Write-Host "[npm] install"
  npm install
}

$workbench = Join-Path $root ".workbench"
$downloads = Join-Path $workbench "downloads"
$tools = Join-Path $workbench "tools"
$models = Join-Path $workbench "models"
foreach ($dir in @($workbench, $downloads, $tools, $models)) {
  Ensure-Dir $dir
}

if ($WithBiliup) {
  $python = Get-Command py -ErrorAction SilentlyContinue
  if (-not $python) {
    $python = Get-Command python -ErrorAction SilentlyContinue
  }
  if (-not $python) {
    throw "Missing Python. Install Python 3 first."
  }
  $venv = Join-Path $tools "biliup-venv"
  $venvPython = Join-Path $venv "Scripts\python.exe"
  if (-not (Test-Path $venvPython)) {
    if ($python.Name -eq "py.exe") {
      & $python.Source -3 -m venv $venv
    } else {
      & $python.Source -m venv $venv
    }
  }
  & $venvPython -m pip install --upgrade pip
  & $venvPython -m pip install biliup==1.2.1
}

if ($WithQwen) {
  $releaseZipName = "Qwen3-ASR-Transcribe-20260223.zip"
  $releaseUrl = "https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/v0.1/$releaseZipName"
  $releaseZip = Join-Path $downloads $releaseZipName
  $releaseDir = Join-Path $tools "qwen3-asr-release"
  $releaseRoot = Join-Path $releaseDir "Qwen3-ASR-Transcribe"
  Download-File $releaseUrl $releaseZip 90000000
  Ensure-Dir $releaseDir
  Expand-Archive -Force -LiteralPath $releaseZip -DestinationPath $releaseDir
  Patch-QwenExporter $releaseRoot

  $modelRoot = Join-Path $models "qwen3-asr-gguf"
  $modelDir = Join-Path $modelRoot $QwenModelSize
  Ensure-Dir $modelDir
  if ($QwenModelSize -eq "1.7B") {
    $asrName = "Qwen3-ASR-1.7B-gguf.zip"
    $asrMin = 900000000
  } else {
    $asrName = "Qwen3-ASR-0.6B-gguf.zip"
    $asrMin = 500000000
  }
  $asrUrl = "https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/$asrName"
  $alignName = "Qwen3-ForceAligner-0.6B-gguf.zip"
  $alignUrl = "https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/$alignName"
  $asrZip = Join-Path $downloads $asrName
  $alignZip = Join-Path $downloads $alignName
  Download-File $asrUrl $asrZip $asrMin
  Download-File $alignUrl $alignZip 450000000
  Expand-Archive -Force -LiteralPath $asrZip -DestinationPath $modelDir
  Expand-Archive -Force -LiteralPath $alignZip -DestinationPath $modelDir
  Ensure-HardlinkOrCopy (Join-Path $modelDir "qwen3_asr_llm.q4_k.gguf") (Join-Path $modelDir "qwen3_asr_llm.q5_k.gguf")
  Ensure-HardlinkOrCopy (Join-Path $modelDir "qwen3_aligner_llm.q4_k.gguf") (Join-Path $modelDir "qwen3_aligner_llm.q5_k.gguf")
}

Write-Host "Setup complete."
