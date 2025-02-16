#!/bin/bash

# Install pnpm globally
npm install -g pnpm

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
