@echo off
cd /d "%~dp0"
set PYTHONUTF8=1
echo Starting companion: http://127.0.0.1:8765
echo Keep this window open for proactive messages. Ctrl+C to stop.
where python >nul 2>nul
if errorlevel 1 goto use_py
python -u app.py
goto finished
:use_py
py -3 -u app.py
:finished
pause
