@echo off
rem Uso: setup.bat [all^|ort^|yolo^|gender^|icons]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause
