#!/bin/sh
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$dir/ai.js" "$@"
