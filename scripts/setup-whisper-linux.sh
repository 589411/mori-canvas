#!/usr/bin/env bash
# Build whisper.cpp's whisper-server (HTTP /inference) for the whiteboard's
# "自訂 · 本機 whisper" STT. Standalone: needs NO mori-ear, installs into ./whisper/.
# Auto-detects CUDA (nvcc) → GPU build (GGML_CUDA=1), else CPU. (Same approach as
# mori-meeting-recorder/scripts/install-whisper-linux.sh, but targets whisper-server.)
#
# Requires: git/curl, cmake, build-essential (g++/clang++). For GPU: nvidia-cuda-toolkit.
#   sudo apt install build-essential cmake ffmpeg   # (+ nvidia-cuda-toolkit for GPU)
#
# Env: WHISPER_VERSION (v1.8.4), WHISPER_PORT (8089), WHISPER_MODEL (small | large-v3-turbo | base | medium)
set -euo pipefail

version="${WHISPER_VERSION:-v1.8.4}"
port="${WHISPER_PORT:-8089}"
model="${WHISPER_MODEL:-small}"
root="$(cd "$(dirname "$0")/.." && pwd)"
bin_dir="$root/whisper/bin"
model_dir="$root/whisper/models"
work="/tmp/wb-whisper-${version}"
mkdir -p "$bin_dir" "$model_dir"

# 1. whisper-server binary -----------------------------------------------------
if [ -x "$bin_dir/whisper-server" ]; then
  echo "✓ already built: $bin_dir/whisper-server"
else
  echo "→ building whisper.cpp $version (whisper-server) from source…"
  rm -rf "$work" && mkdir -p "$work" && cd "$work"
  curl -L --fail -o whisper.tar.gz "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${version}.tar.gz"
  tar -xzf whisper.tar.gz
  src="whisper.cpp-${version#v}"
  cuda_flag=""
  if command -v nvcc >/dev/null 2>&1; then
    echo "  ✓ 偵測到 CUDA toolkit → GPU 編譯 (GGML_CUDA=1)"
    cuda_flag="-DGGML_CUDA=1"
  else
    echo "  · 無 nvcc → CPU 編譯。要 GPU 先 'sudo apt install nvidia-cuda-toolkit' 再重跑。"
  fi
  cmake -S "$src" -B build \
    -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH='$ORIGIN' $cuda_flag
  cmake --build build --target whisper-server -j"$(nproc)"
  cp -f build/bin/whisper-server "$bin_dir/whisper-server"
  chmod +x "$bin_dir/whisper-server"
  # shared libs (.so) — CUDA backend lives in a subdir, so recurse with find
  find build \( -name 'libwhisper.so.*' -o -name 'libggml*.so.*' \) -exec cp -f {} "$bin_dir/" \; 2>/dev/null || true
  # SONAME symlinks so RPATH=$ORIGIN resolves them
  cd "$bin_dir"
  for spec in libwhisper.so:1 libggml.so:0 libggml-base.so:0 libggml-cpu.so:0 libggml-cuda.so:0; do
    lib="${spec%:*}"; ver="${spec#*:}"
    if compgen -G "${lib}.*.*.*" >/dev/null; then ln -sf "$(ls ${lib}.*.*.* | sort -V | tail -1)" "${lib}.${ver}"; fi
  done
  ln -sf libwhisper.so.1 libwhisper.so 2>/dev/null || true
  if compgen -G "$bin_dir/libggml-cuda.so*" >/dev/null; then
    echo "  ✓ GPU backend lib present (libggml-cuda)"
  else
    echo "  · CPU build (no libggml-cuda). For GPU: ensure nvcc is on PATH, then re-run."
  fi
  rm -rf "$work"
  echo "✓ built: $bin_dir/whisper-server"
fi

# 2. model ---------------------------------------------------------------------
mf="$model_dir/ggml-${model}.bin"
if [ -f "$mf" ]; then
  echo "✓ model: $mf"
else
  echo "→ downloading ggml-${model} model…"
  curl -L --fail -o "$mf" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin"
  echo "✓ downloaded: $mf"
fi

# 3. run helper ----------------------------------------------------------------
cat > "$root/whisper/run-whisper.sh" <<RUN
#!/usr/bin/env bash
# start the local whisper-server (Ctrl-C to stop)
exec "$bin_dir/whisper-server" -m "$mf" --host 127.0.0.1 --port $port --inference-path /inference -t \$(nproc)
RUN
chmod +x "$root/whisper/run-whisper.sh"

echo ""
echo "✓ done."
echo "→ 啟動本機 whisper-server:  bash whisper/run-whisper.sh   (127.0.0.1:$port)"
echo "→ 白板 ⚙ 設定 → 自訂 → 本機 whisper,網址填:  http://127.0.0.1:$port/inference"
