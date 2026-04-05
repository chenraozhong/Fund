#!/bin/bash
# 停止所有相关进程
echo "Stopping services..."
lsof -ti:3001 | xargs kill -9 2>/dev/null && echo "Server (port 3001) stopped" || echo "Server not running"
lsof -ti:5173 | xargs kill -9 2>/dev/null && echo "Client (port 5173) stopped" || echo "Client not running"
echo "Done"
