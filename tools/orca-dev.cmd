@echo off
REM Entry point for the Orca dev launcher.
REM
REM Runs the PowerShell script under the machine's existing execution policy. It
REM deliberately does not pass -ExecutionPolicy Bypass: that is an EDR signal in
REM Orca's posture docs (docs/reference/windows-edr-posture.md). If policy blocks
REM local scripts, allow this one file once, or run the .ps1 from an already-open
REM PowerShell window instead of relaxing the policy machine-wide.
setlocal
powershell -NoProfile -File "%~dp0orca-dev.ps1" %*
exit /b %ERRORLEVEL%
