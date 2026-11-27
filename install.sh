#!/bin/sh
# Installs `sidenote` (one self-contained binary) for macOS or Linux. The only requirement is Claude Code.
#   curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh
set -eu
REPO="${SIDENOTE_REPO:-themid6t/sidenote}"
DEST="${SIDENOTE_BIN:-$HOME/.local/bin}"

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS: on Windows use install.ps1 (see the README)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;; esac

url="https://github.com/$REPO/releases/latest/download/sidenote-$os-$arch"
mkdir -p "$DEST"
echo "Downloading $url"
curl -fL --progress-bar "$url" -o "$DEST/sidenote.tmp"
chmod +x "$DEST/sidenote.tmp"
mv "$DEST/sidenote.tmp" "$DEST/sidenote"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$DEST/sidenote" 2>/dev/null || true

echo "Installed $DEST/sidenote"
command -v claude >/dev/null 2>&1 || echo "Next: install Claude Code (https://claude.com/claude-code) and run \`claude\` once to sign in."
case ":$PATH:" in *":$DEST:"*) ;; *) echo "Add $DEST to your PATH, e.g.: echo 'export PATH=\"$DEST:\$PATH\"' >> ~/.profile" ;; esac
echo "Try: sidenote 1706.03762"
