# Imperium — the Roman economy, c. 200 AD

An interactive map of the Roman economy around 200 AD: the transport network,
the cities, the army, and the flows of the imperial economy — with views for
food, production, trade, the army, real wages and taxes.

**Live:** https://eddyh-dotcom.github.io/roman-economy/

Run locally: `python3 -m http.server --directory .` and open the printed URL.

## Rebuilding the data

`data/network.json`, `data/places.json` and `data/sites.json` are built from
`data/raw/` and the authored model in `data/economy.json`:

    tools/fetch_raw.sh        # downloads the Itiner-e roads (78 MB, not in git)
    python3 tools/build.py    # needs numpy, scipy, shapely, pyproj, openpyxl

## Sources

- **Sea and river lanes:** [ORBIS](https://orbis.stanford.edu/) (Scheidel &
  Meeks, Stanford; CC BY). The build corrects ~40 nodes the deposit misplaces
  (swapped coordinates in the Cyclades, ports out at sea).
- **Roads:** Itiner-e v1.3 — de Soto, Pažout, Brughmans et al., "Itiner-e: A
  high-resolution dataset of roads of the Roman Empire", *Scientific Data* 12,
  1731 (2025); data doi:[10.5281/zenodo.17122148](https://doi.org/10.5281/zenodo.17122148) (CC BY 4.0).
- **Cities:** Hanson, *An Urban Geography of the Roman World, 100 B.C. to A.D.
  300* (2016); Cities Database v1.0, OXREP, doi:10.5287/bodleian:eqapevAn8.
  Populations from area by Hanson & Ortman, *JRA* 30 (2017).
- **Mines:** Wilson & Friedman, Mining Database v1.0 (OXREP, 2010).
- **Presses:** Marzano & Flohr, Olive Oil and Wine Presses Database (OXREP).
- **Shipwrecks:** Strauss, Shipwrecks Database v1.0 (OXREP, 2013), after
  Parker 1992; positions supplemented from the MAPS 2020 summary geodatabase
  (More, McCormick, Strauss, Wilson et al.; CC BY-NC-SA 4.0).
- **Fish-salting:** Motz, *A Dataset of Roman Fish-Salting and Fulling
  Workshops* (2021), doi:10.7945/22dv-xm57 (ODbL); capacities from Wilson,
  "Quantification of fish-salting infrastructure capacity" (OXREP, 2007).
- **Army:** auxiliary deployment after Holder (2003); army costs after
  Duncan-Jones, *Money and Government in the Roman Empire* (1994).
- **Wages:** Allen, "How prosperous were the Romans?", in Bowman & Wilson (eds.),
  *Quantifying the Roman Economy* (2009).
- **Taxes and trade:** Hopkins, "Taxes and trade in the Roman Empire", *JRS* 70
  (1980); output per head from Scheidel & Friesen, *JRS* 99 (2009).
- **Prices:** Diocletian's Price Edict (AD 301).

Map rendering by [Leaflet](https://leafletjs.com/) (BSD-2, vendored).
