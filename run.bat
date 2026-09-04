@echo off
REM ===========================================================================
REM One-click launcher for AI-Writing-without-AI-feel (Windows).
REM Creates backend\.env on first run, installs dependencies, then runs the
REM backend and frontend together in this terminal.
REM ===========================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Install Node 18+ and retry.
  pause
  exit /b 1
)

echo - Closing previous AI-Writing-without-AI-feel services...
call "%~dp0stop.bat" >nul 2>nul

for /f "usebackq delims=" %%P in (`node "%~dp0scripts\find-open-port.mjs" 51773`) do set "FRONTEND_PORT=%%P"
if not defined FRONTEND_PORT (
  echo [X] Could not find an available frontend port.
  exit /b 1
)
if not "%FRONTEND_PORT%"=="51773" (
  echo - Port 51773 is occupied; using %FRONTEND_PORT% instead.
)
set "CORS_ORIGINS=http://127.0.0.1:%FRONTEND_PORT%,http://localhost:%FRONTEND_PORT%"

if not exist "backend\.env" (
  echo - backend\.env not found - creating it from .env.example
  copy /Y "backend\.env.example" "backend\.env" >nul
  echo   WARNING: edit backend\.env and set your model API key.
  echo            ^(Article generation needs a key; the AI-smell score works offline.^)
)

if not exist "backend\node_modules\.bin\concurrently.cmd" (
  echo - Installing backend dependencies...
  pushd backend
  call npm install
  if errorlevel 1 (
    popd
    echo [X] Backend dependency installation failed.
    exit /b 1
  )
  popd
)

if not exist "frontend\node_modules" (
  echo - Installing frontend dependencies...
  pushd frontend
  call npm install
  if errorlevel 1 (
    popd
    echo [X] Frontend dependency installation failed.
    exit /b 1
  )
  popd
)

echo.
echo Starting AI-Writing-without-AI-feel in this terminal...
echo Waiting for the frontend and backend to become ready...
echo.

REM Node 24+ can route built-in fetch/http traffic through HTTP_PROXY / HTTPS_PROXY.
REM Keep external research on that proxy, but never proxy local health/API traffic.
set "NODE_USE_ENV_PROXY=1"
if defined NO_PROXY (
  set "NO_PROXY=localhost,127.0.0.1,%NO_PROXY%"
) else (
  set "NO_PROXY=localhost,127.0.0.1"
)

call "%~dp0backend\node_modules\.bin\concurrently.cmd" ^
  --kill-others-on-fail ^
  --names "backend,frontend,ready" ^
  --prefix "[{name}]" ^
  --prefix-colors "cyan,magenta,green" ^
  "npm --silent --prefix backend start" ^
  "npm --silent --prefix frontend run dev" ^
  "node scripts/wait-for-dev.mjs"

set "SP_EXIT=%ERRORLEVEL%"
endlocal & exit /b %SP_EXIT%
