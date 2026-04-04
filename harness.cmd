@echo off
setlocal
set "PORT=3482"
where node >nul 2>nul
if errorlevel 1 (
  echo Har-Nessie: Node.js 22 or newer is required.
  echo Har-Nessie: Install Node and run again.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Har-Nessie: Node.js 22 or newer is required.
  echo Har-Nessie: Current Node version is too old.
  pause
  exit /b 1
)

for /f %%P in ('node -e "const net=require('node:net'); const start=3482; const end=3510; (async()=>{ for (let port=start; port<=end; port+=1) { const open = await new Promise((resolve)=>{ const server = net.createServer(); server.once('error', ()=>resolve(false)); server.once('listening', ()=>server.close(()=>resolve(true))); server.listen(port, '127.0.0.1'); }); if (open) { console.log(port); return; } } process.exit(1); })().catch(()=>process.exit(1));"') do set "PORT=%%P"
if not defined PORT (
  echo Har-Nessie: No available local port found between 3482 and 3510.
  pause
  exit /b 1
)

echo Har-Nessie: starting local web UI...
echo Har-Nessie: browser http://127.0.0.1:%PORT%
if not "%PORT%"=="3482" (
  echo Har-Nessie: default port 3482 is busy, using %PORT% instead.
)
echo Har-Nessie: open the URL above in your browser.
if defined NODE_OPTIONS (
  set "NODE_OPTIONS=%NODE_OPTIONS% --disable-warning=ExperimentalWarning"
) else (
  set "NODE_OPTIONS=--disable-warning=ExperimentalWarning"
)
set "HARNESS_PORT=%PORT%"
node "%~dp0app\server.mjs"
endlocal
