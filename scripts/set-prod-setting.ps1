<#
.SYNOPSIS
  Carga o cambia un setting de /admin (tabla system_settings) en PROD, sin pasar por la UI.

.DESCRIPTION
  Upsert por `railway run` contra el Postgres de producción, con el mismo patrón que
  deploy-prod.ps1: la URL de la base la expande cmd adentro de railway y nunca pasa por
  esta sesión. El caché de settings del backend es de 5 minutos: el bot lo ve a lo sumo
  5 min después.

.EXAMPLE
  .\scripts\set-prod-setting.ps1 SUPPORT_CONTACT soporte@miagro.app
  .\scripts\set-prod-setting.ps1 SUPPORT_CONTACT "+54 9 11 1234-5678 (WhatsApp)"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)] [string]$Key,
    [Parameter(Mandatory = $true, Position = 1)] [string]$Value
)

$ErrorActionPreference = 'Stop'
$PSQL = Join-Path $env:USERPROFILE 'tools\pgsql18\bin\psql.exe'
if (-not (Test-Path $PSQL)) { Write-Host "ERROR: no encuentro $PSQL" -ForegroundColor Red; exit 1 }
if (-not (Get-Command railway -ErrorAction SilentlyContinue)) { Write-Host 'ERROR: no encuentro el CLI de railway.' -ForegroundColor Red; exit 1 }
if ($Key -notmatch '^[A-Z0-9_]{1,100}$') { Write-Host "ERROR: clave inválida «$Key»" -ForegroundColor Red; exit 1 }
if ($Value -match "['`"]") { Write-Host 'ERROR: el valor no puede llevar comillas.' -ForegroundColor Red; exit 1 }

Set-Location (Split-Path -Parent $PSScriptRoot)
$sql = "INSERT INTO system_settings (key, value, updated_at) VALUES ('$Key', '$Value', NOW()) " +
       "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(); " +
       "SELECT key, value, updated_at FROM system_settings WHERE key = '$Key';"

Write-Host "==> $Key = $Value (prod)" -ForegroundColor Cyan
railway run --service Postgres --environment production -- cmd /c "`"$PSQL`" -At -c `"$sql`" --dbname=%DATABASE_PUBLIC_URL%"
if ($LASTEXITCODE -ne 0) { Write-Host 'ERROR: el upsert falló.' -ForegroundColor Red; exit 1 }
Write-Host 'OK (el bot lo toma en hasta 5 min por el caché de settings).' -ForegroundColor Green
