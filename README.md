# Imperium — the Roman economy, c. 200 AD

An interactive map of the Roman economy around 200 AD: the transport network,
land productivity, and the flows of the imperial economy.

**Live:** https://eddyh-dotcom.github.io/roman-economy/

Run locally: `python3 -m http.server --directory .` and open the printed URL.

Route network from [ORBIS: The Stanford Geospatial Network Model of the Roman
World](https://orbis.stanford.edu/) (`data/raw/orbis_*.csv`, rebuilt into
`data/network.json` by `tools/build_network.py`). Map rendering by
[Leaflet](https://leafletjs.com/) (BSD-2, vendored).
