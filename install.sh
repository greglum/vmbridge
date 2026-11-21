#!/bin/sh
# Installs VM Bridge (server, dashboard and CLI in one file) on macOS or Linux.
#   curl -fsSL https://raw.githubusercontent.com/vkpdeveloper/vmbridge/main/install.sh | sh
# VMBRIDGE_INSTALL_DIR picks where the file goes (default ~/.local/bin).
set -eu

repo="vkpdeveloper/vmbridge"
dir="${VMBRIDGE_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "VM Bridge runs on macOS and Linux only." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

# Rosetta reports x86_64 on Apple silicon. Use the native build instead.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  arch=arm64
fi

url="https://github.com/$repo/releases/latest/download/vmbridge-$os-$arch"
mkdir -p "$dir"
tmp="$(mktemp "$dir/.vmbridge.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

echo "Downloading VM Bridge for $os-$arch..."
curl -fSL --progress-bar "$url" -o "$tmp"
chmod 755 "$tmp"
# Check the download runs before it replaces a working install.
if ! version="$("$tmp" --version 2>/dev/null)"; then
  echo "The downloaded VM Bridge does not run on this machine. Nothing was changed." >&2
  exit 1
fi
mv "$tmp" "$dir/vmbridge"
trap - EXIT

echo "Installed VM Bridge $version to $dir/vmbridge"

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    echo
    echo "Add $dir to your PATH, for example:"
    echo "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.$(basename "${SHELL:-sh}")rc"
    ;;
esac

echo
echo "Start it with: vmbridge"
echo "Keep it running in the background with: vmbridge service install"
