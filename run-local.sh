#!/bin/sh
# Usage: 
# ./run-local.sh
# ./run-local.sh tidyverse
export UNIVERSE="${1:-ropensci}"
YELLOW='\033[0;33m'
RESET='\033[0m'

# Kill child process on exit
trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT

# Start dummy server on port 3993
dbpath="dummydata-$UNIVERSE"
if [ -d "$dbpath" ]; then
printf "${YELLOW} Found existing directory $dbpath, not downloading new dummy data ${RESET}\n"
else
printf "${YELLOW} Downloading new dummy data in $dbpath, one second...${RESET}\n"
mkdir $dbpath
DOWNLOAD_DATA=1
fi

# Start dummy server on port 3993
DEBUG=cranlike:* mongod --bind_ip_all --port 3993 --dbpath "$dbpath" --logpath mongo.log --logappend & sleep 1

# If --download is given download some data
if [ "$DOWNLOAD_DATA" ]; then
  echo "Copying data for $UNIVERSE"
  curl -L "https://$UNIVERSE.r-universe.dev/api/dbdump?binaries=1" -o $UNIVERSE.bson
  mongorestore --port 3993 -d cranlike --drop -c packages $UNIVERSE.bson
  rm -fv $UNIVERSE.bson
  export REBUILD_INDEXES=1
fi

CRANLIKE_MONGODB_PORT=3993 npm start
