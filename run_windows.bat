@echo off
cd /d "%~dp0"
echo SignBridge AI - CPU Local Website
where py >nul 2>nul
if %ERRORLEVEL%==0 (set PYTHON=py -3) else (set PYTHON=python)
if not exist .venv\Scripts\python.exe (
  echo Creating virtual environment...
  %PYTHON% -m venv .venv
  if errorlevel 1 goto :fail
)
if not exist .venv\.installed (
  echo Installing CPU PyTorch and website requirements (first launch only)...
  .venv\Scripts\python.exe -m pip install --upgrade pip
  .venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
  if errorlevel 1 goto :fail
  .venv\Scripts\python.exe -m pip install -r requirements.txt
  if errorlevel 1 goto :fail
  echo ready> .venv\.installed
)
echo.
echo Open this address in your browser: http://127.0.0.1:8000
start "" http://127.0.0.1:8000
.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
pause
exit /b 0
:fail
echo.
echo Setup failed. Check Python 3.10+ and network connection.
pause
exit /b 1
