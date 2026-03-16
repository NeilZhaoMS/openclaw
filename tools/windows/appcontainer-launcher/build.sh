#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
"C:/msys64/ucrt64/bin/gcc.exe" main.c \
  -O2 -municode -DUNICODE -D_UNICODE -Wall \
  -o bin/appcontainer-launcher.exe \
  -lkernel32 -ladvapi32 -luserenv
echo "Build succeeded: $(ls -lh bin/appcontainer-launcher.exe)"
