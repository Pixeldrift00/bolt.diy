#!/bin/bash

# Install pnpm
curl -f https://get.pnpm.io/v6.16.js | node - add --global pnpm

# Check if pnpm installation was successful
if ! command -v pnpm &> /dev/null
then
    echo "pnpm could not be installed"
    exit 1
fi

# Install dependencies
pnpm install

# Run the build command
pnpm run build
