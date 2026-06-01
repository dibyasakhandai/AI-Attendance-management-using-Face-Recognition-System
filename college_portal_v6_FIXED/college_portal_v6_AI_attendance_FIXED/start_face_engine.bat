@echo off
title TAT Face Recognition Engine
color 0A
echo ============================================================
echo   TAT College Portal  —  Face Recognition Engine v2
echo ============================================================
echo.

:: ── 1. Check Python ──────────────────────────────────────────
echo [1/4] Checking Python installation...
python --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [ERROR] Python is NOT installed or not in PATH.
    echo.
    echo  Fix:
    echo    1. Download Python 3.10 from https://python.org/downloads
    echo    2. During install, CHECK "Add Python to PATH"
    echo    3. Re-run this file.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo  Found: %%v
echo.

:: ── 2. Check pip ────────────────────────────────────────────
echo [2/4] Checking pip...
pip --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] pip not found. Run: python -m ensurepip --upgrade
    pause
    exit /b 1
)
echo  pip OK
echo.

:: ── 3. Install / verify dependencies ────────────────────────
echo [3/4] Installing dependencies (opencv-python, numpy)...
echo  This may take 1-2 minutes on first run.
echo.

:: Uninstall conflicting opencv variants first, then install the full one
pip uninstall -y opencv-python-headless >nul 2>&1
pip install opencv-python numpy --quiet
if errorlevel 1 (
    echo.
    echo  [WARNING] pip install reported an error.
    echo  Trying with --user flag...
    pip install opencv-python numpy --user --quiet
    if errorlevel 1 (
        echo.
        echo  [ERROR] Could not install dependencies.
        echo  Try running this CMD window as Administrator.
        echo  Or manually run:  pip install opencv-python numpy
        echo.
        pause
        exit /b 1
    )
)
echo  Dependencies OK
echo.

:: ── 4. Check face_engine.py exists ──────────────────────────
echo [4/4] Checking face_engine.py...
if not exist "%~dp0face_engine.py" (
    echo.
    echo  [ERROR] face_engine.py not found in:
    echo  %~dp0
    echo.
    echo  Make sure start_face_engine.bat is in the portal_v6 folder
    echo  alongside face_engine.py
    echo.
    pause
    exit /b 1
)
echo  face_engine.py found
echo.

:: ── 5. Check if port 5001 is already in use ─────────────────
netstat -an 2>nul | find ":5001 " | find "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo  [WARNING] Port 5001 is already in use.
    echo  Another instance of face_engine.py may already be running.
    echo  If the browser still cannot connect, close the other window first.
    echo.
)

:: ── 6. Start engine ─────────────────────────────────────────
echo ============================================================
echo   Starting Face Engine on http://localhost:5001
echo   Keep this window OPEN while using AI Attendance.
echo   Press Ctrl+C to stop.
echo ============================================================
echo.

cd /d "%~dp0"
python face_engine.py

:: ── If Python exits ─────────────────────────────────────────
echo.
echo ============================================================
echo  [STOPPED] Face engine has exited.
echo.
echo  Common reasons:
echo    - No camera detected  →  plug in a USB webcam
echo      Fix: open Device Manager and check for webcam under
echo           "Imaging devices" or "Cameras"
echo    - opencv-python conflict (headless vs full)
echo      Fix: pip uninstall opencv-python-headless
echo           pip install opencv-python --force-reinstall
echo    - Port 5001 already in use
echo      Fix: close other face engine windows, then retry
echo           Or run:  netstat -ano | findstr :5001
echo    - Python version too old (need 3.8+)
echo      Fix: upgrade Python from https://python.org
echo ============================================================
echo.
pause