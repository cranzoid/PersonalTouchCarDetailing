#!/bin/sh
set -eu

# The GitHub release job builds Next.js standalone output on Linux. Azure only
# starts the already-built server; it does not install or extract dependencies.
exec node server.js
