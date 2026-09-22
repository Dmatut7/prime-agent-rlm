#!/bin/sh
# One-line installer for the Dmatut7/prime-agent-rlm fork line.
# Clones (or updates) the repo, builds it, and installs the `prime-agent`
# command from this tree. Installs THIS line's fixes - not the upstream release.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Dmatut7/prime-agent-rlm/merge/repl-kernel/install-fork.sh | sh
#   INSTALL_DIR=~/prime-agent sh install-fork.sh          # custom checkout dir
#   sh install-fork.sh /path/to/existing/checkout         # build an existing clone
set -eu

INSTALL_DIR="${INSTALL_DIR:-$HOME/prime-agent-rlm}"
if [ "$#" -gt 0 ]; then
    INSTALL_DIR="$1"
fi

need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "install-fork: missing prerequisite: $1 ($2)" >&2
        exit 1
    fi
}
need node "install Node.js 20+ first (https://nodejs.org)"
need npm "comes with Node.js"
need git "https://git-scm.com"

if [ -d "$INSTALL_DIR/.git" ]; then
    echo "install-fork: updating existing checkout at $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch origin merge/repl-kernel
    git -C "$INSTALL_DIR" checkout merge/repl-kernel
    git -C "$INSTALL_DIR" reset --hard origin/merge/repl-kernel
else
    echo "install-fork: cloning into $INSTALL_DIR"
    git clone --branch merge/repl-kernel --depth 1 \
        https://github.com/Dmatut7/prime-agent-rlm.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "install-fork: installing dependencies (npm ci)"
npm ci
echo "install-fork: building (npm run build)"
npm run build
echo "install-fork: linking the prime-agent command"
npm link

echo
echo "install-fork: done. This shell's PATH may need a reload (hash -r)."
echo "  prime-agent --version    # verify the fork build"
echo "If you previously installed the upstream release, this link now"
echo "overrides it for this machine."
