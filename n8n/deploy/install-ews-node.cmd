@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

set "EWS_NODE_NAME_B64=__EWS_NODE_NAME_B64__"
set "EWS_DOMAIN_B64=__EWS_DOMAIN_B64__"
set "EWS_OWNER_EMAIL_B64=__EWS_OWNER_EMAIL_B64__"
set "EWS_OWNER_PASSWORD_B64=__EWS_OWNER_PASSWORD_B64__"
set "EWS_GRSAI_KEY_B64=__EWS_GRSAI_KEY_B64__"
set "EWS_DEEPSEEK_KEY_B64=__EWS_DEEPSEEK_KEY_B64__"
set "EWS_BACKUP_KEY_B64=__EWS_BACKUP_KEY_B64__"
set "EWS_IMAGE_SERVICE_URL_B64=__EWS_IMAGE_SERVICE_URL_B64__"
set "EWS_CALLBACK_SECRET_B64=__EWS_CALLBACK_SECRET_B64__"
set "EWS_TICKET_ORIGIN_B64=__EWS_TICKET_ORIGIN_B64__"
set "EWS_PORT=__EWS_PORT__"

set "EWS_TEMP_ROOT=%TEMP%\ews-node-install-%RANDOM%-%RANDOM%"
set "EWS_PAYLOAD_B64=%EWS_TEMP_ROOT%.b64"
set "EWS_PAYLOAD_PS1=%EWS_TEMP_ROOT%.ps1"

echo.
echo EWS n8n node installer
echo Installing or starting Docker Desktop if needed and preparing deployment...
echo.

__EWS_POWERSHELL_PAYLOAD_LINES__

certutil.exe -f -decode "%EWS_PAYLOAD_B64%" "%EWS_PAYLOAD_PS1%" >nul 2>&1
if errorlevel 1 goto :decode_failed

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%EWS_PAYLOAD_PS1%"
set "EWS_EXIT_CODE=%ERRORLEVEL%"
del /q "%EWS_PAYLOAD_B64%" "%EWS_PAYLOAD_PS1%" >nul 2>&1

if not "%EWS_EXIT_CODE%"=="0" goto :deployment_failed
echo.
echo Deployment completed. Delete this CMD file because it contains encoded secrets.
goto :finish

:decode_failed
set "EWS_EXIT_CODE=1"
del /q "%EWS_PAYLOAD_B64%" "%EWS_PAYLOAD_PS1%" >nul 2>&1
echo Failed to prepare the embedded installer payload.
goto :finish

:deployment_failed
echo.
echo Deployment failed with exit code %EWS_EXIT_CODE%. Review the error above and run this file again.

:finish
if not defined EWS_NO_PAUSE pause
endlocal & exit /b %EWS_EXIT_CODE%
