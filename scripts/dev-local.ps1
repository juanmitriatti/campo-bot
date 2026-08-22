<#
.SYNOPSIS
  Levanta (o baja) todo el stack local de campo-bot: PostgreSQL + backend + frontend.

.DESCRIPTION
  Este entorno NO usa Docker: Node y PostgreSQL 16 estan instalados de forma portable
  en $HOME\tools\ y Postgres NO corre como servicio de Windows, asi que hay que
  arrancarlo a mano cuando vas a laburar. Este script hace las tres cosas de una.

.EXAMPLE
  .\scripts\dev-local.ps1            # levanta todo
  .\scripts\dev-local.ps1 -Stop      # baja todo
  .\scripts\dev-local.ps1 -Status    # que hay corriendo
#>
[CmdletBinding()]
param(
    [switch]$Stop,
    [switch]$Status,
    [switch]$NoFrontend
)

$ErrorActionPreference = 'Stop'

# --- Rutas del toolchain portable -------------------------------------------
$TOOLS    = Join-Path $env:USERPROFILE 'tools'
$NODE_DIR = Join-Path $TOOLS 'nodejs'
$PG_BIN   = Join-Path $TOOLS 'pgsql\bin'
$PG_DATA  = Join-Path $TOOLS 'pgdata'
$REPO     = Split-Path -Parent $PSScriptRoot
$PID_FILE = Join-Path $REPO '.dev-local.pids'
$PG_PORT  = 5433
$API_PORT = 3000
$WEB_PORT = 5173

$env:Path = "$NODE_DIR;$env:Path"

function Test-Port([int]$Port) {
    $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !   $msg" -ForegroundColor Yellow }

# --- Preflight ---------------------------------------------------------------
foreach ($p in @($NODE_DIR, $PG_BIN, $PG_DATA)) {
    if (-not (Test-Path $p)) { throw "No existe '$p'. El toolchain portable no esta donde se espera." }
}

# --- Status ------------------------------------------------------------------
if ($Status) {
    Write-Step 'Estado del stack local'
    foreach ($s in @(@{n='PostgreSQL'; p=$PG_PORT}, @{n='Backend   '; p=$API_PORT}, @{n='Frontend  '; p=$WEB_PORT})) {
        if (Test-Port $s.p) { Write-Ok "$($s.n) escuchando en :$($s.p)" }
        else { Write-Warn2 "$($s.n) NO esta corriendo (:$($s.p))" }
    }
    return
}

# --- Stop --------------------------------------------------------------------
if ($Stop) {
    Write-Step 'Bajando backend y frontend'
    if (Test-Path $PID_FILE) {
        foreach ($line in Get-Content $PID_FILE) {
            if ($line -match '^\s*(\d+)\s+(.+)$') {
                $procId = [int]$Matches[1]; $label = $Matches[2]
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($proc) {
                    # matar el arbol: npm.cmd -> node
                    & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null
                    Write-Ok "$label (pid $procId) detenido"
                } else {
                    Write-Warn2 "$label (pid $procId) ya no corria"
                }
            }
        }
        Remove-Item $PID_FILE -Force
    } else {
        Write-Warn2 'No hay .dev-local.pids — nada que bajar por PID'
    }

    Write-Step 'Bajando PostgreSQL'
    & "$PG_BIN\pg_ctl.exe" -D $PG_DATA -m fast stop 2>&1 | Out-Null
    if (Test-Port $PG_PORT) { Write-Warn2 "Postgres sigue escuchando en :$PG_PORT" }
    else { Write-Ok 'PostgreSQL detenido' }
    return
}

# --- Start -------------------------------------------------------------------
Write-Step "PostgreSQL 16 (:$PG_PORT)"
if (Test-Port $PG_PORT) {
    Write-Ok 'ya estaba corriendo'
} else {
    # OJO: nada de `| Out-Null` aca. El proceso `postgres` hereda el pipe de
    # stdout y no lo suelta, asi que el pipeline nunca cierra y el script cuelga.
    # `-s` (silent) evita el ruido sin necesidad de redirigir.
    & "$PG_BIN\pg_ctl.exe" -D $PG_DATA -l "$PG_DATA\server.log" -w -s start
    if (Test-Port $PG_PORT) { Write-Ok 'arrancado' }
    else { throw "Postgres no arranco. Revisa $PG_DATA\server.log" }
}

$pids = @()

Write-Step "Backend (:$API_PORT)"
if (Test-Port $API_PORT) {
    Write-Ok 'ya estaba corriendo'
} else {
    $p = Start-Process -FilePath "$NODE_DIR\npm.cmd" -ArgumentList 'run','dev' `
        -WorkingDirectory $REPO -PassThru `
        -WindowStyle Normal
    $pids += "$($p.Id) backend"
    Write-Host '    esperando boot (tsx compila ~40s la primera vez)...' -NoNewline
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $API_PORT) { break }
        Start-Sleep -Seconds 2
        Write-Host '.' -NoNewline
    }
    Write-Host ''
    if (Test-Port $API_PORT) { Write-Ok 'arrancado' } else { Write-Warn2 'no respondio en 120s — mira su ventana' }
}

if (-not $NoFrontend) {
    Write-Step "Frontend (:$WEB_PORT)"
    if (Test-Port $WEB_PORT) {
        Write-Ok 'ya estaba corriendo'
    } else {
        $p = Start-Process -FilePath "$NODE_DIR\npm.cmd" -ArgumentList 'run','dev' `
            -WorkingDirectory (Join-Path $REPO 'frontend') -PassThru `
            -WindowStyle Normal
        $pids += "$($p.Id) frontend"
        Start-Sleep -Seconds 6
        if (Test-Port $WEB_PORT) { Write-Ok 'arrancado' } else { Write-Warn2 'todavia levantando' }
    }
}

if ($pids.Count -gt 0) { $pids | Set-Content -Path $PID_FILE -Encoding ascii }

Write-Host ''
Write-Step 'Listo'
Write-Host "    API       http://localhost:$API_PORT/api/health"
if (-not $NoFrontend) { Write-Host "    Dashboard http://localhost:$WEB_PORT/app-assets/" }
Write-Host "    Postgres  postgresql://campo@localhost:$PG_PORT/campo_bot"
Write-Host ''
Write-Host "    Bajar todo:  .\scripts\dev-local.ps1 -Stop" -ForegroundColor DarkGray
