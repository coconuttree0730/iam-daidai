#!/bin/sh
# 头部朝向时间轴测量（193 帧滚动素材）
#
# 用途：为「内容在人物看向某侧时升起」这类时机对齐需求提供**实测依据**，
#       而不是凭感觉挑一个 --sc 断点。
#
# 原理：对每帧取「头部带」（整帧墨迹顶部往下 22% 高，该带内没有手）的
#       alpha 墨迹水平重心，减去全序列中位数得 yaw（+ 偏右 / − 偏左）。
#
# ⚠️ 不要改回「皮肤色像素质心」：双手进出画面会让掩码面积从 ~2 万
#    飙到 ~9 万像素，质心整体左移被误读成"看左"——**面积变化 ≠ 朝向变化**。
#
# 依赖：项目内 venv（自动创建）＋ Pillow + numpy。
# 用法：zsh qa/run-head-yaw.sh [帧目录]
#       默认 motion/scroll-slide/frames/rvm-v2
set -e

cd "$(dirname "$0")/.."
PROJ="$PWD"
VENV="$PROJ/.tmp/venv-img"

export TMPDIR="$PROJ/.tmp"
mkdir -p "$PROJ/.tmp" "$PROJ/qa/out"

if [ ! -x "$VENV/bin/python" ]; then
  echo "[head-yaw] 创建 venv：$VENV"
  python3 -m venv "$VENV"
fi

if ! "$VENV/bin/python" -c "import PIL, numpy" 2>/dev/null; then
  echo "[head-yaw] 安装 Pillow + numpy…"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check Pillow numpy
fi

exec "$VENV/bin/python" qa/head_yaw.py "$@"
