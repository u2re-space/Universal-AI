@echo off
setlocal
set "NODE_EXE="
for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE (
  echo ai: node.exe not found on PATH 1>&2
  exit /b 9009
)
endlocal & "%NODE_EXE%" "%~dp0ai.js" %*
exit /b %ERRORLEVEL%
