#!/bin/bash

# Install pnpm
curl -f https://get.pnpm.io/v6.16.js | node - add --global pnpm

# Install dependencies
pnpm install

# Run the build command
pnpm run build
