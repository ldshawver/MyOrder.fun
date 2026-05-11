#!/bin/bash

set -e

echo "=== Updating Repo ==="

cd /opt/alavont

git fetch origin
git reset --hard origin/main

echo "=== Rebuilding Containers ==="

cd deploy

docker compose down

docker compose up -d --build

echo "=== Done ==="

docker compose ps
