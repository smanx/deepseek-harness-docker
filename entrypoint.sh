#!/bin/sh
set -e

# admin 变体：镜像内存在 /app/.admin-mode 标记时，改由管理服务接管
# （管理服务负责：页面安装/切换 DSH 版本、配置 npm 源、托管 DSH 进程并反向代理；
#   未安装 DSH 时访问 / 自动跳转管理员页）
if [ -f /app/.admin-mode ]; then
  echo "[admin] 检测到 admin 变体，启动 DSH 管理服务 ..."
  exec node /app/manager/index.js
fi

# 端口配置（均可通过环境变量覆盖）
#   DSH_PORT    源端口（DSH 监听，容器内 127.0.0.1），默认 3079
#   PROXY_PORT  代理端口（代理对外监听），默认 3080（必须与 DSH_PORT 不同）
DSH_PORT="${DSH_PORT:-3079}"
PROXY_PORT="${PROXY_PORT:-3080}"

# ── 1. 启动 DSH（默认监听 127.0.0.1:3080）────────────────────────────
# DSH 输出需同时落盘到 /app/.dsh-web.log：代理的 upstream-token.js 靠读该文件
# 打捞 launch token（用于根目录 401 时重发换会话 cookie）。用重定向直写文件
# （立即落盘、无管道缓冲延迟），再用 tail -f 转发到容器输出保持可见。
# 注意：不能用 `| tee` 管道——那样 $! 捕获的是 tee 的 PID，cleanup 会杀错进程。
echo "[dsh] 启动 DSH (dsh web --port $DSH_PORT) ..."
dsh web --port "$DSH_PORT" > /app/.dsh-web.log 2>&1 &
DSH_PID=$!
tail -f /app/.dsh-web.log &

# ── 2. 等待 DSH 就绪（最多 120 秒）─────────────────────────────────
echo "[dsh] 等待 DSH 就绪 (127.0.0.1:$DSH_PORT) ..."
ready=0
i=0
while [ "$i" -lt 120 ]; do
  if node -e "fetch('http://127.0.0.1:$DSH_PORT/').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    echo "[dsh] 错误：DSH 进程已退出"
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$ready" != "1" ]; then
  echo "[dsh] 错误：DSH 120 秒内未就绪"
  exit 1
fi
echo "[dsh] DSH 就绪（pid $DSH_PID）"

# ── 3. 容器停止时同时关闭 DSH ──────────────────────────────────────
cleanup() {
  echo "[proxy] 收到退出信号，停止 DSH ..."
  kill "$DSH_PID" 2>/dev/null || true
  wait "$DSH_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── 4. 启动代理（前台运行，保持容器存活）──────────────────────────
echo "[proxy] 启动代理：0.0.0.0:$PROXY_PORT -> 127.0.0.1:$DSH_PORT"
cd /app/proxy
exec node index.js
