@echo off
rem Instala todo en Windows con doble clic:
rem   1) Shomer TV: entorno de Python + dependencias
rem   2) Genera los .xpi de Firefox de shomer-sport y shomer-web
rem Requisito: Python 3.9+ de python.org.
setlocal
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File"
echo ===== Shomer TV =====
%PS% "%~dp0shomer-tv\instalar.ps1" || goto :error
echo ===== Shomer Sport (Firefox) =====
%PS% "%~dp0shomer-sport\scripts\build-firefox.ps1" || goto :error
echo ===== Shomer Web (Firefox) =====
%PS% "%~dp0shomer-web\scripts\build-firefox.ps1" || goto :error
echo.
echo Todo listo.
echo  - Shomer TV: shomer-tv\run.bat
echo  - Chrome/Edge: chrome://extensions, Modo de desarrollador, Cargar descomprimida (carpeta shomer-sport o shomer-web)
echo  - Firefox: dist\*-firefox.xpi de cada extension
pause
exit /b 0
:error
echo.
echo *** Algo fallo. Revisa el mensaje de arriba. ***
pause
exit /b 1
