@echo off
REM Quick taste test: open a URL in a phone-sized window with a mobile UA.
REM Usage: quick-look.bat https://www.douyin.com

chcp 65001 >nul
setlocal

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Google\Chrome\Application\chrome.exe"

set "URL=%~1"
if "%URL%"=="" set "URL=https://m.bilibili.com/index.html"

set UA=Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1

start "" "%EDGE%" --app="%URL%" --window-size=400,780 --window-position=1400,60 ^
  --user-agent="%UA%" --touch-events=enabled --disable-features=UserAgentClientHints ^
  --user-data-dir="%LOCALAPPDATA%\MoyuQuickLook"

echo Launched: %URL%
timeout /t 3 >nul
