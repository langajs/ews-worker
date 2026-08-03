@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

set "EWS_TEMP_ROOT=%TEMP%\ews-node-install-%RANDOM%-%RANDOM%"
set "EWS_PAYLOAD_PS1=%EWS_TEMP_ROOT%.ps1"

echo.
echo EWS n8n node installer
echo Installing or starting Docker Desktop if needed and preparing deployment...
echo.

goto :extract_payload

__EWS_POWERSHELL_PAYLOAD__

:extract_payload
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$c=[IO.File]::ReadAllText('%~f0');$s=$c.IndexOf('__EWS_PS1_BEGIN__')+18;$e=$c.IndexOf('__EWS_PS1_END__');if($s -lt 0 -or $e -le $s){Write-Error 'Embedded payload markers are missing';exit 1};[IO.File]::WriteAllText('%EWS_PAYLOAD_PS1%',$c.Substring($s,$e-$s).Trim(),(New-Object Text.UTF8Encoding($false)))"
if errorlevel 1 goto :payload_failed
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%EWS_PAYLOAD_PS1%"
set "EWS_EXIT_CODE=%ERRORLEVEL%"
del /q "%EWS_PAYLOAD_PS1%" >nul 2>&1

if not "%EWS_EXIT_CODE%"=="0" goto :deployment_failed
echo.
echo Deployment completed. Delete this CMD file because it contains plaintext secrets.
goto :finish

:payload_failed
set "EWS_EXIT_CODE=1"
del /q "%EWS_PAYLOAD_PS1%" >nul 2>&1
echo Failed to prepare the embedded installer payload.
goto :finish

:deployment_failed
echo.
echo Deployment failed with exit code %EWS_EXIT_CODE%. Review the error above and run this file again.

:finish
if not defined EWS_NO_PAUSE pause
endlocal & exit /b %EWS_EXIT_CODE%
