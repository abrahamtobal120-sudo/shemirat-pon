@echo off
rem Uso: run.bat [canal]   (por defecto canal-1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
pause
