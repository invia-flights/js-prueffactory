#!/bin/sh
set -eu

npx c8 --reporter=text-summary npm test
