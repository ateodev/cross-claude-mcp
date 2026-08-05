<#
  install-service.ps1  -- run ELEVATED (admin).
  Registers cross-claude-mcp as a Windows service via NSSM and starts +
  health-checks it. Idempotent.

  Every path and address is a parameter: nothing here is specific to a given
  host. -AllowFrom restricts inbound access to the listening port; pass the
  address of the reverse proxy or gateway that fronts the bus, or omit it to
  leave the firewall untouched (loopback clients need no rule).

  Example:
    .\install-service.ps1 -Node C:\path\node.exe -Nssm C:\path\nssm.exe -AllowFrom 10.0.0.1
#>
[CmdletBinding()]
param(
  [string] $AppDir    = $PSScriptRoot,
  [string] $Node      = 'node.exe',
  [string] $Nssm      = 'nssm.exe',
  [string] $AllowFrom = '',
  [string] $ResultLog = ''
)
$ErrorActionPreference = 'Stop'
$svc      = 'cross-claude-mcp'
$appDir   = $AppDir
$node     = $Node
$nssm     = $Nssm
$logDir   = Join-Path $appDir 'logs'
$svcLog   = Join-Path $logDir 'service.log'
$result   = if ($ResultLog) { $ResultLog } else { Join-Path $logDir 'service-install-result.txt' }

"=== cross-claude-mcp service install $(Get-Date -Format o) ===" | Tee-Object -FilePath $result

# --- preconditions ---
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
foreach ($f in @($node,$nssm)) {
  if (-not (Get-Command $f -ErrorAction SilentlyContinue)) { "MISSING: $f" | Tee-Object -FilePath $result -Append; exit 1 }
}
if (-not (Test-Path (Join-Path $appDir 'server.mjs'))) {
  "MISSING: $(Join-Path $appDir 'server.mjs')" | Tee-Object -FilePath $result -Append; exit 1
}

# --- load env from service-config.env (PORT, MCP_API_KEY, SERVER_URL, ...) ---
$envPairs = @()
Get-Content (Join-Path $appDir 'service-config.env') | Where-Object { $_ -match '^[A-Z][A-Z0-9_]*=' } | ForEach-Object { $envPairs += $_.Trim() }
$port = ($envPairs | Where-Object { $_ -like 'PORT=*' }) -replace '^PORT=',''
"Env keys: $(( $envPairs | ForEach-Object { ($_ -split '=',2)[0] }) -join ', ')  (PORT=$port)" | Tee-Object -FilePath $result -Append

# --- remove any prior service (idempotent) ---
$existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
if ($existing) {
  "Removing existing service..." | Tee-Object -FilePath $result -Append
  if ($existing.Status -ne 'Stopped') { & $nssm stop $svc | Out-Null; Start-Sleep 2 }
  & $nssm remove $svc confirm | Out-Null
  Start-Sleep 2
}

# --- install + configure ---
& $nssm install $svc $node server.mjs | Out-Null
& $nssm set $svc AppDirectory $appDir | Out-Null
& $nssm set $svc AppEnvironmentExtra @envPairs | Out-Null
& $nssm set $svc AppStdout $svcLog | Out-Null
& $nssm set $svc AppStderr $svcLog | Out-Null
& $nssm set $svc AppStdoutCreationDisposition 4 | Out-Null
& $nssm set $svc AppStderrCreationDisposition 4 | Out-Null
& $nssm set $svc AppRotateFiles 1 | Out-Null
& $nssm set $svc AppRotateBytes 10485760 | Out-Null
& $nssm set $svc Start SERVICE_AUTO_START | Out-Null
& $nssm set $svc AppExit Default Restart | Out-Null
& $nssm set $svc AppRestartDelay 3000 | Out-Null
& $nssm set $svc DisplayName 'Cross-Claude MCP message bus' | Out-Null
& $nssm set $svc Description "Cross-instance Claude comms (HTTP MCP + REST) on port $port" | Out-Null
"Service installed (LocalSystem, auto-start, restart-on-crash)." | Tee-Object -FilePath $result -Append

# --- firewall: restrict the port to one source, if one was given ---
$ruleName = 'cross-claude-mcp inbound'
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
if ($AllowFrom) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $port -RemoteAddress $AllowFrom -Profile Any | Out-Null
  "Firewall: inbound TCP $port allowed from $AllowFrom only." | Tee-Object -FilePath $result -Append
} else {
  "Firewall: no rule created (-AllowFrom not given); remote clients need one." | Tee-Object -FilePath $result -Append
}

# --- start + health check ---
& $nssm start $svc | Out-Null
$ok = $false
for ($i=0; $i -lt 25; $i++) {
  try { $h = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2; $ok = $true; break } catch { Start-Sleep -Milliseconds 400 }
}
if ($ok) {
  "HEALTH OK: status=$($h.status) v$($h.version)" | Tee-Object -FilePath $result -Append
  "SERVICE STATUS: $((Get-Service $svc).Status)" | Tee-Object -FilePath $result -Append
  "DONE." | Tee-Object -FilePath $result -Append
} else {
  "HEALTH FAILED - check $svcLog" | Tee-Object -FilePath $result -Append
  Get-Content $svcLog -Tail 20 -ErrorAction SilentlyContinue | Tee-Object -FilePath $result -Append
  exit 1
}
