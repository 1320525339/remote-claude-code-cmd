@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Rome Client

cd /d "%~dp0"

echo.
echo ============================================================
echo   Rome Client - Auto connect
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js 18+.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/2] Installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

if not exist "dist\cli.js" (
  echo [2/2] Building...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] build failed.
    pause
    exit /b 1
  )
)

echo.
echo Auto connecting using rome.config.json ...
echo.
node bin\rome.js connect

echo.
echo (session ended)
timeout /t 3 >nul
