#!/bin/bash
# 跑批等待模板：等 bench-runner 退出。
# 不要写 while pgrep -f '/tmp/bench-runner.*<arm>'：模式串在轮询进程自己的 cmdline 里，
# pgrep -f 会匹配到自己，runner 结束后循环永不退出。
#
# 启动时把 runner 的 pid 记进文件（在启动进程里写，不要在本等待循环里 pgrep 自己的模式）：
#   setsid nohup /tmp/bench-runner ... >>"$LOG/run-<arm>.log" 2>&1 &
#   echo $! > "$LOG/<arm>-runner.pid"
# 然后：
#   wait-bench-runner.sh "$LOG/<arm>-runner.pid"
#
# 若必须用 pgrep，模式里用方括号，避免匹配到含该字面量的等待进程：
#   pgrep -f '[b]ench-runner.*r10-s1-<arm>'
set -u
pidfile="${1:?pid file}"
pid=$(cat "$pidfile")
while kill -0 "$pid" 2>/dev/null; do
  sleep 30
done
