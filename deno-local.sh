#!/bin/sh
# npm install
#trap 'kill $(jobs -p)' EXIT
if [ -f "/opt/homebrew/etc/mongod.conf" ]; then
mongoconfig="/opt/homebrew/etc/mongod.conf"
else
mongoconfig="/usr/local/etc/mongod.conf"
fi
DEBUG=cranlike:* mongod --config $mongoconfig & sleep 2 & deno --allow-net --allow-sys --allow-write --allow-env --allow-read ./bin/www
