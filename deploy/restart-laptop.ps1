$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

# stop instance lama
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dist[/\\]index\.js|dist\.index\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1

# rotasi log > 5 MB
if ((Test-Path bot.log) -and ((Get-Item bot.log).Length -gt 5MB)) {
  Move-Item bot.log "bot-$((Get-Date -Format 'yyyyMMdd-HHmmss')).log" -Force
}

Start-Process cmd.exe -ArgumentList "/c node dist\index.js >> bot.log 2>&1 & echo [exited %errorlevel% at %time%] >> bot.log" -WorkingDirectory $root -WindowStyle Hidden
Write-Output "ORACLE restarted (detached). Log: $root\bot.log"
