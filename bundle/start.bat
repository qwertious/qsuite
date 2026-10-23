@echo off
REM qSuite launcher for Windows. Tries the py launcher first (what the
REM python.org installer sets up), then a plain python on PATH.
setlocal

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 "%~dp0start.py" %*
    goto :done
)

where python >nul 2>nul
if %errorlevel%==0 (
    python "%~dp0start.py" %*
    goto :done
)

echo.
echo   qSuite needs Python 3, which does not appear to be installed.
echo   Get it from https://www.python.org/downloads/ and try again.
echo.
pause

:done
endlocal
