#!/usr/bin/env bash

createFileList() {
  echo "Creating test file list with only A.java and B.java..."
  echo "./test/A.java" > /app/files.txt
  echo "./test/B.java" >> /app/files.txt
  echo "DEBUG: file list content:"
  cat /app/files.txt
}

sendFile() {
  curl -s -F "name=$1" -F "data=@$1" "$TARGET"
  sleep 0.01
}

if [[ "$DELAY" == "" ]]; then
  DELAY=0
fi

echo "Stream-of-Code generator."
echo "Delay (seconds) between each file is: $DELAY"
echo "files are sent to: $TARGET"

echo "Waiting 5 seconds to give consumer time to get started..."
sleep 5

if [[ "$1" == "TEST" ]]; then
  echo "Started with TEST argument, sending test files..."
  sendFile ./test/A.java
  sendFile ./test/B.java
  echo "Sent test files. Sleeping before continuing..."
  sleep 10
fi

createFileList

while read LINE; do
  sendFile $LINE
  sleep $DELAY
done < ~/files.txt

echo "No more files to send. Exiting."
