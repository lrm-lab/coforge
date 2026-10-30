#!/bin/sh
# Runs in the migrate container, from its .migrate directory (remote-deploy.sh, blue-green-deploy.sh):
# the migration safety gate first, then the migrations. A gate that rejects a pending migration (or
# cannot read the live catalog) stops here, before `migrate deploy` has changed anything.
set -e
bun migration-safety/check-migration.ts --deploy
exec bun node_modules/prisma/build/index.js migrate deploy
