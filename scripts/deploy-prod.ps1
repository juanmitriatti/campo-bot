<#
.SYNOPSIS
  Deploy a prod con backup previo: pg_dump de la base de Railway -> railway up -> espera que el SHA nuevo este vivo.

.DESCRIPTION
  El plan Hobby de Railway no tiene backups (son solo de Pro), asi que antes de cada deploy
  -que puede traer migraciones, y corren solas al arrancar- se baja un dump de prod a dumps\.
  Si el dump falla, NO se deploya.

  - Dump: pg_dump 18 (prod corre PostgreSQL 18) en formato custom, via `railway run`
    para no escribir la URL de la base en ningun lado. Se valida con `pg_restore --list`.
  - Rotacion: se conservan los ultimos $Keep dumps prod_*.dump.
  - Deploy: escribe .deploy-sha con el HEAD (lo lee /api/health), `railway up --detach`
    y espera hasta 10 min a que /api/health devuelva ese SHA.

.EXAMPLE
  .\scripts\deploy-prod.ps1               # backup + deploy
  .\scripts\deploy-prod.ps1 -BackupOnly   # solo el dump
  .\scripts\deploy-prod.ps1 -AllowDirty   # deploya aunque haya cambios sin commitear
#>
[CmdletBinding()]
param(
    [switch]$BackupOnly,
    [switch]$AllowDirty,
    [int]$Keep = 10
)

$ErrorActionPreference = 'Stop'

$TOOLS      = Join-Path $env:USERPROFILE 'tools'
$PG_DUMP    = Join-Path $TOOLS 'pgsql18\bin\pg_dump.exe'
$PG_RESTORE = Join-Path $TOOLS 'pgsql18\bin\pg_restore.exe'
$REPO       = Split-Path -Parent $PSScriptRoot
$DUMPS      = Join-Path $REPO 'dumps'
$HEALTH_URL = 'https://miagro.app/api/health'

$env:Path = (Join-Path $TOOLS 'nodejs') + ';' + $env:Path
Set-Location $REPO

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

foreach ($bin in @($PG_DUMP, $PG_RESTORE)) {
    if (-not (Test-Path $bin)) { Fail "No encuentro $bin (hace falta el toolchain pgsql18)." }
}
if (-not (Get-Command railway -ErrorAction SilentlyContinue)) { Fail 'No encuentro el CLI de railway.' }

$sha = (git rev-parse --short HEAD).Trim()
if (-not $BackupOnly -and -not $AllowDirty) {
    $dirty = git status --porcelain --untracked-files=no
    if ($dirty) { Fail "Hay cambios sin commitear (usa -AllowDirty si es a proposito):`n$dirty" }
}

# --- 1. Backup -------------------------------------------------------------
Step 'Backup de la base de prod'
New-Item -ItemType Directory -Force $DUMPS | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$file  = Join-Path $DUMPS "prod_${stamp}_pre-$sha.dump"

# La URL la expande cmd adentro de `railway run`: nunca pasa por esta sesion.
railway run --service Postgres --environment production -- cmd /c "`"$PG_DUMP`" -Fc --no-owner --no-privileges -f `"$file`" --dbname=%DATABASE_PUBLIC_URL%"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $file)) { Fail 'pg_dump fallo: no deployo.' }

$tables = (& $PG_RESTORE --list $file | Select-String 'TABLE DATA').Count
if ($LASTEXITCODE -ne 0 -or $tables -lt 10) { Fail "El dump no se puede leer o vino casi vacio ($tables tablas): no deployo." }
$sizeMB = [math]::Round((Get-Item $file).Length / 1MB, 1)
Write-Host "OK  $file  ($sizeMB MB, $tables tablas con datos)" -ForegroundColor Green

Get-ChildItem $DUMPS -Filter 'prod_*.dump' | Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $Keep | ForEach-Object { Write-Host "Borro dump viejo $($_.Name)"; Remove-Item $_.FullName }

if ($BackupOnly) { exit 0 }

# --- 2. Deploy -------------------------------------------------------------
Step "Deploy de $sha"
Set-Content -Path (Join-Path $REPO '.deploy-sha') -Value $sha -NoNewline -Encoding ascii
try {
    railway up --service campo-bot --environment production --detach
    if ($LASTEXITCODE -ne 0) { Fail 'railway up fallo.' }
} finally {
    Remove-Item (Join-Path $REPO '.deploy-sha') -ErrorAction SilentlyContinue
}

# --- 3. Esperar el SHA nuevo ----------------------------------------------
Step "Esperando que $HEALTH_URL devuelva $sha (hasta 10 min)"
$deadline = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $deadline) {
    try {
        $live = (Invoke-RestMethod $HEALTH_URL -TimeoutSec 10).sha
        if ($live -eq $sha) { Write-Host "OK  $sha esta vivo." -ForegroundColor Green; exit 0 }
        Write-Host "  todavia $live..."
    } catch { Write-Host '  sin respuesta todavia...' }
    Start-Sleep -Seconds 15
}
Fail "A los 10 min prod no devuelve $sha. Revisar con: railway logs --build / railway logs --deployment. Backup: $file"
