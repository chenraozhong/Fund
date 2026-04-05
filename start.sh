#!/bin/bash
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

export ANTHROPIC_API_KEY=ak_2Dl6V34xu4EC5HA8gS2WG8vc9A45a
export ANTHROPIC_BASE_URL=https://api.longcat.chat/anthropic
export AI_MODEL=LongCat-Flash-Thinking

# 先启动server，等端口就绪后再启动client
cd "$ROOT_DIR/server" && npx tsx src/index.ts &
SERVER_PID=$!

# 等待server就绪（最多15秒）
for i in $(seq 1 30); do
  if curl -s --noproxy '*' http://localhost:3001/api/stats/summary > /dev/null 2>&1; then
    echo "Server ready on port 3001"
    break
  fi
  sleep 0.5
done

# 启动client
cd "$ROOT_DIR/client" && npx vite --host &
CLIENT_PID=$!

# 捕获退出信号，同时关闭server和client
trap "kill $SERVER_PID $CLIENT_PID 2>/dev/null; exit" INT TERM
wait
