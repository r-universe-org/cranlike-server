#!/bin/sh
# npm install
trap 'kill $(jobs -p)' EXIT
DEBUG=cranlike:* mongod & sleep 2 & npm start
