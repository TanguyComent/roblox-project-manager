#!/bin/sh
# Lance le Worker (double-clic sous macOS, ou ./start.command sous Linux).
cd "$(dirname "$0")" && exec node --disable-warning=ExperimentalWarning src/main.ts "$@"
