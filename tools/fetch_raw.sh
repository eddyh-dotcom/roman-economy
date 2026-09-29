#!/bin/sh
# Download the raw inputs too large to keep in git into data/raw/.
# The smaller ones (ORBIS CSVs, Hanson's cities, the site databases) are committed.
set -e
cd "$(dirname "$0")/../data/raw"

# Itiner-e v1.3 roads (de Soto, Pažout, Brughmans et al. 2025; CC BY 4.0), 78 MB.
# doi:10.5281/zenodo.17122148 — note the GeoJSON is in EPSG:3395, not lon/lat.
if [ ! -f itinere_roads.geojson ]; then
  curl -L --fail -o itinere_roads.geojson \
    "https://zenodo.org/api/records/17122148/files/itinere_roads.geojson/content"
fi
echo "raw data ready; now run: python3 tools/build.py"
