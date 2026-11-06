@echo off
echo 🎬 Intimora Local Admin
echo ====================
echo.

echo Checking dependencies...
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

echo.
echo Starting server...
echo.
echo 👉 Open http://localhost:3000 in your browser
echo.
echo Press Ctrl+C to stop
echo.
node server.js
