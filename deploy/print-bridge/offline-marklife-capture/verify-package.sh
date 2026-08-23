#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

expected_artwork="b421a2f74da6c5cec20048c494ba3e898296f0909a309c08badf746bb83dc423"
expected_filter="81b1bb4baa28be9daf1afcbfd8d6f4e305784923a0735714463d1e7d99dd4f48"

[[ "$(shasum -a 256 input/Thank-You-Sticker-job-960-copy.png | awk '{print $1}')" == "$expected_artwork" ]]
[[ "$(stat -f '%z' input/Thank-You-Sticker-job-960-copy.png)" == "2123" ]]
file input/Thank-You-Sticker-job-960-copy.png | grep -Fq "393 x 393, 1-bit colormap"
[[ "$(shasum -a 256 input/vendor/rastertoX2 | awk '{print $1}')" == "$expected_filter" ]]
file input/vendor/rastertoX2 | grep -Fq "x86_64"
[[ -f input/vendor/MARKLIFE_X2.ppd ]]
[[ ! -e capture/OPERATOR_AUTHORIZATION ]]

if find . -type f \( -name '*.env' -o -name '.env*' -o -name 'c00960' -o -name 'd00960-*' \) | grep -q .; then
  echo "Credential or live-spool-shaped file found; package rejected" >&2
  exit 1
fi
echo "Package verified; no filter was executed."
