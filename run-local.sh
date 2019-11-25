#!/bin/sh
# npm install
trap 'kill $(jobs -p)' EXIT
DEBUG=cranlike:* mongod --config /usr/local/etc/mongod.conf & sleep 2 & npm start
