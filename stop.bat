@echo off
REM ===========================================================================
REM Stop script for AI写作 (Windows).
REM Stops matching backend/frontend processes and the backend port.
REM ===========================================================================
setlocal
cd /d "%~dp0"
set "SP_ROOT=%CD%"

echo Stopping AI写作 services...

REM Best-effort cleanup for named service windows.
taskkill /FI "WINDOWTITLE eq AI写作 - backend*" /T /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq AI写作 - frontend*" /T /F >nul 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $root=$env:SP_ROOT; $dirs=@((Join-Path $root 'backend'),(Join-Path $root 'frontend')); $stopped=New-Object 'System.Collections.Generic.List[int]'; $procs=@(Get-CimInstance Win32_Process); foreach($proc in $procs){ if($proc.ProcessId -eq $PID -or -not $proc.CommandLine){ continue }; $cmd=$proc.CommandLine; $match=$false; foreach($dir in $dirs){ if($cmd.IndexOf($dir,[StringComparison]::OrdinalIgnoreCase) -ge 0){ $match=$true; break } }; if($match){ Stop-Process -Id $proc.ProcessId -Force; [void]$stopped.Add([int]$proc.ProcessId) } }; try { $conns=@(Get-NetTCPConnection -LocalPort 8787 -State Listen); foreach($conn in $conns){ $portPid=[int]$conn.OwningProcess; if($portPid -and $portPid -ne $PID){ Stop-Process -Id $portPid -Force; [void]$stopped.Add($portPid) } } } catch {}; $unique=New-Object 'System.Collections.Generic.List[int]'; foreach($id in $stopped){ if(-not $unique.Contains([int]$id)){ [void]$unique.Add([int]$id) } }; if($unique.Count -gt 0){ 'Stopped PIDs: ' + ($unique -join ', ') } else { 'No matching AI写作 service processes were running.' }"

echo Done.
endlocal
