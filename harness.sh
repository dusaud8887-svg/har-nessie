#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "Har-Nessie: Node.js 22 or newer is required."
  exit 1
fi

if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >/dev/null 2>&1; then
  echo "Har-Nessie: Node.js 22 or newer is required."
  exit 1
fi

PORT=$(node -e "const net=require('node:net'); const start=3482; const end=3510; (async()=>{ for (let port=start; port<=end; port+=1) { const open = await new Promise((resolve)=>{ const server = net.createServer(); server.once('error', ()=>resolve(false)); server.once('listening', ()=>server.close(()=>resolve(true))); server.listen(port, '127.0.0.1'); }); if (open) { process.stdout.write(String(port)); return; } } process.exit(1); })().catch(()=>process.exit(1));")

if [ -z "$PORT" ]; then
  echo "Har-Nessie: No available local port found between 3482 and 3510."
  exit 1
fi

echo "Har-Nessie: starting local web UI..."
echo "Har-Nessie: browser http://127.0.0.1:$PORT"
if [ "$PORT" != "3482" ]; then
  echo "Har-Nessie: default port 3482 is busy, using $PORT instead."
fi
echo "Har-Nessie: open the URL above in your browser."

if [ -n "${NODE_OPTIONS:-}" ]; then
  export NODE_OPTIONS="$NODE_OPTIONS --disable-warning=ExperimentalWarning"
else
  export NODE_OPTIONS="--disable-warning=ExperimentalWarning"
fi

export HARNESS_PORT="$PORT"
exec node "$SCRIPT_DIR/app/server.mjs"
