<#
.SYNOPSIS
  Один запуск проекта rd: проверка окружения, установка зависимостей и запуск
  signaling-сервера вместе с веб-клиентом.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File start.ps1
  powershell -ExecutionPolicy Bypass -File start.ps1 -SkipInstall -NoBrowser
#>
[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$NoBrowser,
  [int]$ServerPort = 8787,
  [int]$WebPort = 5173
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Fail($text)  { Write-Host $text -ForegroundColor Red }

# ─── Проверка Node.js ──────────────────────────────────────────────────────────
Write-Step 'Проверка Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Write-Fail 'Node.js не найден.'
  Write-Host '  Установите Node.js 20.11 или новее: https://nodejs.org/'
  Write-Host '  Либо portable-сборку: https://nodejs.org/dist/latest-v22.x/'
  exit 1
}
$nodeVersion = (& node --version).TrimStart('v')
$major = [int]($nodeVersion.Split('.')[0])
Write-Host "  node $nodeVersion"
if ($major -lt 20) {
  Write-Fail "Нужен Node.js 20.11 или новее, найден $nodeVersion."
  exit 1
}

# ─── Зависимости ───────────────────────────────────────────────────────────────
if (-not $SkipInstall) {
  Write-Step 'Установка зависимостей (npm install)'
  if ($null -eq (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Fail 'npm не найден: он идёт в составе Node.js.'
    exit 1
  }
  & npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Fail 'npm install завершился с ошибкой.'
    exit $LASTEXITCODE
  }
}

# ─── Проверка и тесты ───────────────────────────────────────────────────────────
Write-Step 'Проверка типов и тестов'
& npx --no-install tsc -p tsconfig.json --noEmit
if ($LASTEXITCODE -ne 0) { Write-Fail 'Ошибки типов.'; exit $LASTEXITCODE }
& npx --no-install vitest run --reporter=dot
if ($LASTEXITCODE -ne 0) { Write-Fail 'Тесты не прошли.'; exit $LASTEXITCODE }
Write-Host '  типы и тесты в порядке' -ForegroundColor Green

# ─── Запуск ────────────────────────────────────────────────────────────────────
Write-Step 'Запуск signaling-сервера и веб-клиента'
$env:PORT = "$ServerPort"
$env:VITE_SIGNALING_URL = "ws://localhost:$ServerPort/ws"

$srv = Start-Process -FilePath 'node' -ArgumentList 'packages/signaling/dist/main.js' -PassThru -NoNewWindow `
  -ErrorAction SilentlyContinue
if ($null -eq $srv) {
  # Собранного сервера ещё нет: запускаем через tsx из dev-зависимостей.
  $srv = Start-Process -FilePath 'npx.cmd' -ArgumentList 'tsx', 'packages/signaling/src/main.ts' -PassThru -NoNewWindow
}
$web = Start-Process -FilePath 'npx.cmd' -ArgumentList 'vite', '--port', "$WebPort" -WorkingDirectory (Join-Path $root 'packages/web') -PassThru -NoNewWindow

Start-Sleep -Seconds 4
Write-Host "  signaling: http://localhost:$ServerPort/healthz"
Write-Host "  клиент:   http://localhost:$WebPort" -ForegroundColor Green
if (-not $NoBrowser) { Start-Process "http://localhost:$WebPort" }

Write-Host "`nОстановить: Ctrl+C" -ForegroundColor Yellow
try {
  while (-not $srv.HasExited -or -not $web.HasExited) { Start-Sleep -Seconds 1 }
} finally {
  foreach ($proc in @($srv, $web)) {
    if ($null -ne $proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  }
}
