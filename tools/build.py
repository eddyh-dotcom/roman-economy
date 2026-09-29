#!/usr/bin/env python3
"""Build Imperium's data files from the raw sources in data/raw/.

    python3 tools/build.py          (fetch the large raw files first: tools/fetch_raw.sh)

Inputs
  data/raw/orbis_nodes.csv, orbis_edges.csv  ORBIS v2 — Scheidel & Meeks, Stanford (CC-BY)
  data/raw/itinere_roads.geojson             Itiner-e v1.3 roads — de Soto, Pažout, Brughmans
                                             et al. 2025 (CC-BY 4.0). EPSG:3395, despite the paper.
  data/raw/hanson2016_cities.xlsx            Hanson, Cities Database v1.0 (OXREP, 2016)
  data/raw/sites/                            OXREP mines (Wilson & Friedman), presses (Marzano &
                                             Flohr) and shipwrecks (Strauss); Motz's fish-salting
                                             workshops; Wilson's fish-salting capacities
  data/economy.json                          the authored model: provinces, goods, army, city notes

Outputs
  data/network.json  ORBIS sea and river lanes + the Itiner-e road network, with every city,
                     fort and production site attached; road edges carry simplified geometry
  data/places.json   cities, garrisons and production sources pinned to network nodes, plus
                     each province's rural population after the urban figures change
  data/sites.json    archaeological point layers for the map
"""
import csv, difflib, json, math, os, re, unicodedata
from collections import Counter, defaultdict

import numpy as np
import openpyxl
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
RAW = os.path.join(DATA, "raw")

ROAD_COST_PER_KM = 0.035   # d.c. per kg of grain per km: ORBIS's road rate (the Edict's wagon tariff)
ROAD_KM_PER_DAY = 30       # ORBIS's civilian road speed
SECONDARY_MULT = 1.2       # lesser roads are slower and dearer than the paved main roads (assumption)
SLOPE_WEIGHT = 0.5         # cost ×(1 + w·(1/passability − 1)); Itiner-e's passability is 1 on the flat
DETOUR = 1.25              # a straight-line connector understates the real track
SIMPLIFY_DEG = 0.004       # display geometry tolerance (~400 m)
R_EARTH = 6371.0088

SNAP_KM = {"orbis": 12, "city": 60, "garrison": 60, "source": 80}
ORBIS_DIRECT_KM = 10       # a place this close to an ORBIS port/stop also gets a direct link to it
SEA_LINK_COST_PER_KM = 0.0008   # island hops without an ORBIS lane: small-boat coasting, a bit
SEA_LINK_KM_PER_DAY = 100       # dearer and slower than ORBIS's median coastal lane
MIN_CITY_POP = 1000        # Hanson's formula gives a 1-ha site 42 people; nothing urban is that small
MAX_URBAN_SHARE = 0.33     # cap on a province's urban share; see the note where it is applied

ORBIS_ROAD_NODE0, PLACE_NODE0 = 100000, 200000


def hav(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(min(1, math.sqrt(a)))


def xyz(lon, lat):
    lon, lat = np.radians(np.asarray(lon, float)), np.radians(np.asarray(lat, float))
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


def chord_to_km(ch):
    return 2 * R_EARTH * np.arcsin(np.minimum(1, ch / 2))


def norm_name(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(.*?\)", "", s)
    return re.sub(r"[^a-z]", "", s)


# ---------------------------------------------------------------- ORBIS ----
# the deposit is missing coordinates for a few dozen nodes; these are real,
# identifiable places, so supply them rather than sever their routes  (lon, lat)
KNOWN_COORDS = {
    "Agrigentum": (13.576, 37.311), "Aleria": (9.513, 42.104), "Amphipolis": (23.845, 40.822),
    "Boiodurum": (13.46, 48.574), "Demetrias": (22.93, 39.35), "Forum Appii": (13.03, 41.43),
    "Horreum Margi": (21.37, 43.93), "Krane": (20.48, 38.18), "Malaca": (-4.42, 36.72),
    "Mouth of Witham": (0.07, 52.96), "Neapolis (Thrace)": (24.41, 40.94),
    "Palinurus Pr.": (15.28, 40.02), "Palma": (2.65, 39.57), "Panormus": (13.36, 38.12),
    "Populonium": (10.49, 42.99), "Samonion Pr.": (26.31, 35.30),
    "Toletum": (-4.03, 39.86), "Tripolis": (35.84, 34.44),
    "Olbia": (9.50, 40.92),  # Sardinia; the deposit has it at 0,0
    # not the Sicilian Selinus: its lanes run to Demetrias (87 km), Thessalonica and Geraistos,
    # which puts it in the northern Sporades (located from its lane lengths)
    "Selinous": (23.77, 39.26),
}
# the deposit also places some nodes wrongly. ~25 Aegean islands, Miletus and Isthmia have
# latitude and longitude swapped (they plot in Arabia) — fixed by rule in load_orbis. These
# sit far off at sea or in the wrong valley; checked against their lane lengths and Hanson's
# coordinates for the same city
ORBIS_FIX = {
    "Raphia": (34.25, 31.29), "Azotus Paralios": (34.65, 31.80),     # swapped, but at sea
    "Leros": (26.85, 37.15), "Paphos": (32.41, 34.76), "Portus Pachyni": (15.13, 36.69),
    "Isca": (-2.955, 51.61),   # its lanes (Burrio 14 km, Glevum 79 km) make it Isca Silurum, not Exeter
    "Syracusae": (15.28, 37.07), "Patara": (29.32, 36.26), "Xanthos": (29.33, 36.36),
    "Myra": (29.99, 36.26), "Phaselis": (30.55, 36.52), "Thabraca": (8.75, 36.96),
    "Amastris": (32.38, 41.73), "Salamis": (33.90, 35.18), "Attalea": (30.71, 36.88),
    "Perge": (30.85, 36.96), "Amisus": (36.33, 41.29), "Doclea": (19.27, 42.47),
    "Augustoritum": (1.26, 45.82), "Salmantica": (-5.66, 40.96), "Augustonemetum": (3.08, 45.78),
    "Lissus": (19.64, 41.79), "Iuliobona": (0.53, 49.52), "Aginnum": (0.61, 44.20),
    "Rotomagus": (1.09, 49.44), "Ulpiana": (21.20, 42.60), "Sinuessa": (13.89, 41.12),
    "Mediolanum (Aquitania)": (-0.64, 45.75), "Ebusus": (1.43, 38.91), "Palmyra": (38.27, 34.55),
    "Mytilene": (26.56, 39.11), "Dianium": (0.11, 38.84), "Smyrna": (27.14, 38.42),
    "Latopolis": (32.55, 25.27), "Memphis": (31.26, 29.85), "Oxyrhynchus": (30.66, 28.54),
    "Apamea": (36.40, 35.42),
}
DIRECTED = {"upstream", "downstream", "fastup", "fastdown"}
SEA = {"coastal", "overseas", "slowcoast", "slowover", "ferry"}


def load_orbis():
    """ORBIS v2 node/edge CSVs (purl.stanford.edu/mn425tz9757). River types are directed;
    everything else is bidirectional. Parallel edges keep the cheapest."""
    nodes, pending = [], []
    with open(os.path.join(RAW, "orbis_nodes.csv")) as f:
        for r in csv.DictReader(f):
            n = {"id": int(r["id"]), "label": r["label"]}
            # NB: in the deposit CSV, column x is LATITUDE and y is LONGITUDE
            if r["x"] and r["y"] and not (float(r["x"]) == 0 and float(r["y"]) == 0) \
                    and r["label"] not in KNOWN_COORDS:
                n["lon"], n["lat"] = float(r["y"]), float(r["x"])
            elif r["label"] in KNOWN_COORDS:
                n["lon"], n["lat"] = KNOWN_COORDS[r["label"]]
            else:
                pending.append(n)
            nodes.append(n)
    best = {}
    with open(os.path.join(RAW, "orbis_edges.csv")) as f:
        for r in csv.DictReader(f):
            s, t = int(r["source"]), int(r["target"])
            e = {"km": float(r["km"]), "days": float(r["days"]), "cost": float(r["expense"]), "type": r["type"]}
            for a, b in ([(s, t)] if r["type"] in DIRECTED else [(s, t), (t, s)]):
                if (a, b) not in best or e["cost"] < best[(a, b)]["cost"]:
                    best[(a, b)] = {**e, "s": a, "t": b}
    # coordinate-less junctions settle at the mean of their placed neighbours
    neigh = defaultdict(set)
    for (a, b) in best:
        neigh[a].add(b); neigh[b].add(a)
    byid = {n["id"]: n for n in nodes}
    for _ in range(20):
        moved = False
        for n in pending:
            pts = [(byid[m]["lon"], byid[m]["lat"]) for m in neigh[n["id"]] if "lon" in byid[m]]
            if pts:
                lon = round(sum(p[0] for p in pts) / len(pts), 4)
                lat = round(sum(p[1] for p in pts) / len(pts), 4)
                if (n.get("lon"), n.get("lat")) != (lon, lat):
                    n["lon"], n["lat"] = lon, lat
                    moved = True
        if not moved:
            break
    nodes = [n for n in nodes if "lon" in n]
    for n in nodes:
        if n["lon"] >= 36 and n["lat"] < 28:   # nothing real lies east of Berenice and south of 28°N
            n["lon"], n["lat"] = n["lat"], n["lon"]
        if n["label"] in ORBIS_FIX:
            n["lon"], n["lat"] = ORBIS_FIX[n["label"]]
    ids = {n["id"] for n in nodes}
    edges = [e for e in best.values() if e["s"] in ids and e["t"] in ids]
    for e in edges:
        e["mode"] = "sea" if e["type"] in SEA else ("river" if e["type"] in DIRECTED else "road")
    return nodes, edges


# ------------------------------------------------------------- Itiner-e ----
def load_itinere():
    gj = json.load(open(os.path.join(RAW, "itinere_roads.geojson")))
    parts, props = [], []
    for f in gj["features"]:
        g, p = f["geometry"], f["properties"]
        lines = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
        for ln in lines:
            if len(ln) >= 2:
                parts.append(ln)
                props.append(p)
    # the published GeoJSON is World Mercator (EPSG:3395) with Z, not lon/lat
    tr = Transformer.from_crs(3395, 4326, always_xy=True)
    xs = np.array([c[0] for ln in parts for c in ln])
    ys = np.array([c[1] for ln in parts for c in ln])
    lon, lat = tr.transform(xs, ys)
    feats, i = [], 0
    for ln, p in zip(parts, props):
        n = len(ln)
        pas = p.get("passabilit")
        feats.append({
            "lon": lon[i:i + n], "lat": lat[i:i + n],
            "main": p.get("Type") == "Main Road",
            "mult": (1.0 if p.get("Type") == "Main Road" else SECONDARY_MULT)
                    * (1 + SLOPE_WEIGHT * (1 / max(0.1, pas) - 1) if pas else 1.0),
        })
        i += n
    return feats


def vkey(lon, lat):
    return (int(round(lon * 1e6)), int(round(lat * 1e6)))


# ------------------------------------------------------------- Hanson ------
HANSON_PROV = {
    "Achaea": ["achaea"], "Asia": ["asia"], "Africa Proconsularis": ["africa"], "Numidia": ["africa"],
    "Hispania Tarraconensis": ["tarraconensis"], "Dalmatia": ["dalmatia"], "Baetica": ["baetica"],
    "Lycia et Pamphylia": ["lycia_pamphylia"], "Aegyptus": ["aegyptus"],
    "Cilicia et Cyprus": ["cilicia", "cyprus"], "Mauretania Caesariensis": ["mauretania"],
    "Mauretania Tingitana": ["mauretania"], "Gallia Lugdunensis": ["lugdunensis"],
    "Gallia Narbonensis": ["narbonensis"], "Silicia": ["sicilia"], "Britannia": ["britannia"],
    "Syria": ["syria"], "Gallia Aquitania": ["aquitania"], "Lusitania": ["lusitania"],
    "Syria Palestina": ["palaestina"], "Thracia": ["thracia"],
    "Cappadocia et Galatia": ["cappadocia", "galatia"], "Creta et Cyrenaica": ["creta", "cyrenaica"],
    "Macedonia": ["macedonia"], "Gallia Belgica": ["belgica"], "Germania Superior": ["germania_superior"],
    "Germania Inferior": ["germania_inferior"], "Arabia": ["arabia"], "Pannonia Superior": ["pannonia"],
    "Pannonia Inferior": ["pannonia"], "Moesia Inferior": ["moesia"], "Moesia Superior": ["moesia"],
    "Dacia": ["dacia"], "Bithynia et Pontus": ["bithynia_pontus"], "Corsica et Sardinia": ["sardinia_corsica"],
    "Noricum": ["noricum"], "Raetia": ["raetia"],
    "Alpes Cottiae": ["italia", "narbonensis"], "Alpes Graiae et Poeninae": ["italia", "germania_superior"],
    "Alpes Maritimae": ["narbonensis", "italia"],
}


# curated (ORBIS) names that Hanson spells differently
CURATED_ALIAS = {"Caesarea (Cappadocia)": "Mazaca", "Constantinopolis": "Byzantium",
                 "Narbo": "Narbo Martius", "Sarmizegethusa": "Sarmizegetusa"}
# ORBIS labels that are anachronistic for AD 200
DISPLAY_NAME = {"Constantinopolis": "Byzantium"}


ECO_NOUN = {"silver": "Silver", "gold": "Gold", "copper": "Copper", "garum": "Garum"}


def area_to_pop(ha):
    """Hanson & Ortman 2017 (JRA 30): N = 41.834 · A^1.3361, A = inhabited area in ha."""
    return 41.834 * ha ** 1.3361


def load_hanson():
    wb = openpyxl.load_workbook(os.path.join(RAW, "hanson2016_cities.xlsx"), read_only=True)
    sheet = lambda name: [r for r in wb[name].iter_rows(values_only=True)][1:]
    area = {r[0]: (r[1], r[2]) for r in sheet("Areas") if r[1] not in (None, "NULL")}
    civic = defaultdict(list)
    for r in sheet("Civic Status"):
        if r[1] and r[1] != "NULL" and r[1] not in civic[r[0]]:
            civic[r[0]].append(r[1])
    mons = Counter(r[0] for r in sheet("Monuments"))
    num = lambda v: None if v in (None, "NULL", "") else int(v)
    out = []
    for r in sheet("Cities"):
        pk, anc, mod, prov, country, rank, _, start, end, lon, lat = r[:11]
        start, end = num(start), num(end)
        if start is not None and start > 200:
            continue
        if end is not None and end < 200:
            continue
        a = area.get(pk)
        out.append({
            "hid": int(pk.split("_")[1]), "name": re.sub(r"\s*\(\d\)$", "", anc), "modern": mod, "hprov": prov,
            "lon": float(lon), "lat": float(lat), "rank": str(rank),
            "area": float(a[0]) if a else None, "areaBasis": a[1] if a else None,
            "civic": civic.get(pk, []), "monuments": mons.get(pk, 0),
        })
    return out


# ------------------------------------------------ archaeological sites ----
SITES = os.path.join(RAW, "sites")
METAL_COLOR = {"gold": "#e8b923", "silver": "#c0c0c0", "copper": "#b87333", "lead": "#7f8e9c", "iron": "#6e7b8b"}
CARGO_COLOR = {"amphorae": "#b06a3b", "marble/stone": "#e8e3d8", "metal": "#9fa8b3", "pottery/fineware": "#c9a36b",
               "art/bronzes": "#c28a3a", "tiles/bricks": "#a0584a"}
# the model's metal and garum sources come from these databases rather than being hand-placed
DERIVED = {"silver": "silver", "gold": "gold", "copper": "copper", "garum": None}


def read_sites(name):
    return list(csv.DictReader(open(os.path.join(SITES, name), encoding="utf-8")))


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_mines():
    out = []
    for r in read_sites("oxrep_mines.csv"):
        lat, lon = fnum(r["latitude"]), fnum(r["longitude"])
        if lat is None or lon is None or r["coord_flag"]:
            continue
        metals = [m for m in ("gold", "silver", "copper", "lead", "iron") if r[m] == "True"]
        if not metals:
            continue
        out.append({"name": r["name"], "lon": lon, "lat": lat, "metals": metals, "province": r["province"],
                    "district": r["mining_area"].replace("Mountians", "Mountains"),
                    "techniques": r["mining_techniques"], "start": fnum(r["start_after"]), "end": fnum(r["end_before"])})
    return out


def load_fish():
    wil = [(fnum(r["longitude"]), fnum(r["latitude"]), fnum(r["aggregate_vat_capacity_m3"]), r["factory"])
           for r in read_sites("wilson2007_factory_capacities_geocoded.csv")]
    out = []
    for r in read_sites("motz2021_fish_salting_workshops.csv"):
        lat, lon = fnum(r["Latitude"]), fnum(r["Longitude"])
        if lat is None or lon is None:
            continue
        if r["construction_dated"] == "True" and r["constructed_by_AD200"] != "1.0":
            continue   # built after 200
        vats = fnum(r["Number of vats _ treading installations"]) or 1
        m3 = next((w[2] for w in wil if w[0] is not None and hav(lon, lat, w[0], w[1]) < 1.5), None)
        name = r["Modern Workshop Name"] or r["Modern Site Name"] or r["Site Name"]
        out.append({"name": name, "site": r["Ancient Site Name"] or r["Modern Site Name"], "lon": lon, "lat": lat,
                    "vats": vats, "m3": m3, "area": r["Geographical Area"],
                    "start": fnum(r["Construction date _ start"]) if r["construction_dated"] == "True" else None})
    return out


def load_presses():
    out = []
    for r in read_sites("oxrep_presses.csv"):
        lat, lon = fnum(r["latitude"]), fnum(r["longitude"])
        if lat is None or lon is None or r["coord_flag"]:
            continue
        out.append({"name": r["site"] + ("" if r["location_name"] in ("", "none") else f" — {r['location_name']}"),
                    "lon": lon, "lat": lat, "n": int(fnum(r["n_presses"]) or 1), "type": r["building_type"],
                    "from": fnum(r["construction_after"]), "to": fnum(r["abandonment_before"])})
    return out


def load_wrecks():
    out = []
    for r in read_sites("oxrep_strauss_shipwrecks.csv"):
        lat, lon = fnum(r["latitude_best"]), fnum(r["longitude_best"])
        lo, hi = fnum(r["Earliest date"]), fnum(r["Latest date"])
        if lat is None or lon is None or lo is None or hi is None:
            continue
        if hi < 100 or lo > 300 or hi - lo > 300:   # the High Empire, and not too vaguely dated
            continue
        out.append({"name": r["Name"] or "unnamed wreck", "lon": lon, "lat": lat, "dating": r["Dating"],
                    "cargo": [c for c in r["cargo_categories"].split(";") if c], "amph": r["Amphora type"],
                    "origin": r["Place of origin"], "dest": r["Place of destination"], "t": fnum(r["tonnage_t"])})
    return out


def cluster(points, radius_km, weight="w"):
    """Greedy clustering: seed at the heaviest neighbourhood, take everything within the radius."""
    if not points:
        return []
    X = xyz([p["lon"] for p in points], [p["lat"] for p in points])
    tree = cKDTree(X)
    neigh = [tree.query_ball_point(X[i], radius_km / R_EARTH) for i in range(len(points))]
    left, out = set(range(len(points))), []
    while left:
        seed = max(left, key=lambda i: sum(points[j][weight] for j in neigh[i] if j in left))
        members = [j for j in neigh[seed] if j in left]
        left.difference_update(members)
        out.append([points[j] for j in members])
    return out


def centroid(members, weight="w"):
    w = sum(m[weight] for m in members)
    return (sum(m["lon"] * m[weight] for m in members) / w, sum(m["lat"] * m[weight] for m in members) / w)


# ---------------------------------------------------------------- build ----
def main():
    eco = json.load(open(os.path.join(DATA, "economy.json")))
    orbis_nodes, orbis_edges = load_orbis()
    orbis_by_id = {n["id"]: n for n in orbis_nodes}
    label_count = Counter(n["label"] for n in orbis_nodes)
    orbis_by_label = {n["label"]: n for n in orbis_nodes if label_count[n["label"]] == 1}
    print(f"ORBIS: {len(orbis_nodes)} nodes, {len(orbis_edges)} directed edges")

    # ---------- cities: Hanson's list, carrying over the curated notes ----------
    hanson = load_hanson()
    curated = eco["cities"]
    for c in curated:
        n = orbis_by_label[c["orbis"]]
        c["lon"], c["lat"] = n["lon"], n["lat"]

    # province: Hanson's (Hadrianic) province → the model's; ambiguous ones go to the
    # candidate whose curated cities lie nearest
    cur_xyz = xyz([c["lon"] for c in curated], [c["lat"] for c in curated])
    cur_tree = cKDTree(cur_xyz)
    for h in hanson:
        cands = ["italia"] if h["hprov"].startswith("Italia") else HANSON_PROV.get(h["hprov"])
        if not cands:
            raise SystemExit(f"no province mapping for {h['hprov']!r}")
        if len(cands) == 1:
            h["province"] = cands[0]
            continue
        _, idx = cur_tree.query(xyz([h["lon"]], [h["lat"]]), k=12)
        for i in idx[0]:
            if curated[i]["province"] in cands:
                h["province"] = curated[i]["province"]
                break
        else:
            h["province"] = cands[0]

    # match curated cities to Hanson sites: nearby and similarly named
    h_tree = cKDTree(xyz([h["lon"] for h in hanson], [h["lat"] for h in hanson]))
    matched = {}
    for ci, c in enumerate(curated):
        want = norm_name(CURATED_ALIAS.get(c["orbis"], c["orbis"].split("/")[0]))
        idxs = h_tree.query_ball_point(xyz([c["lon"]], [c["lat"]])[0], r=30 / R_EARTH)
        best, bscore = None, 0
        for hi in idxs:
            h = hanson[hi]
            d = hav(c["lon"], c["lat"], h["lon"], h["lat"])
            nm = difflib.SequenceMatcher(None, want, norm_name(h["name"])).ratio()
            score = nm - d / 100
            if (nm >= 0.6 or d < 3) and score > bscore and hi not in matched.values():
                best, bscore = hi, score
        if best is not None:
            matched[ci] = best
    print(f"Hanson: {len(hanson)} cities existing c. AD 200; {len(matched)}/{len(curated)} curated cities matched")

    # population: area formula where Hanson has an area; otherwise the median for
    # that Barrington Atlas rank among sites that do
    by_rank = defaultdict(list)
    for h in hanson:
        if h["area"]:
            by_rank[h["rank"]].append(area_to_pop(h["area"]))
    rank_median = {k: float(np.median(v)) for k, v in by_rank.items()}
    rank_median.setdefault("-", rank_median["4 or 5"])
    print("median pop by rank (sites with area):", {k: round(v) for k, v in rank_median.items()})
    for h in hanson:
        if h["area"]:
            h["pop"], h["popBasis"] = max(MIN_CITY_POP, area_to_pop(h["area"])), "area"
        else:
            h["pop"], h["popBasis"] = rank_median[h["rank"]], "rank"

    cities = []
    matched_h = {hi: ci for ci, hi in matched.items()}
    for hi, h in enumerate(hanson):
        c = curated[matched_h[hi]] if hi in matched_h else None
        city = {
            "name": DISPLAY_NAME.get(c["orbis"], c["orbis"]) if c else h["name"], "hid": h["hid"], "province": h["province"],
            "lon": round(h["lon"], 4), "lat": round(h["lat"], 4),
            "pop": round(h["pop"] / 1000, 2), "popBasis": h["popBasis"],
        }
        if h["name"] != city["name"]:
            city["alt"] = h["name"]
        if h["modern"] and h["modern"] != "NULL":
            city["modern"] = h["modern"]
        if h["area"]:
            city["area"] = h["area"]
        if h["civic"]:
            city["civic"] = h["civic"]
        if c:
            city["orbis"] = c["orbis"]
            city["wealth"] = c.get("wealth", 1)
            city["prevPop"] = c["pop"]
            if c.get("note"):
                city["note"] = c["note"]
            if c["province"] != h["province"]:
                city["province"] = c["province"]
        cities.append(city)
    # curated cities Hanson doesn't list (beyond his coverage — Mesopotamia, the Bosporus,
    # caravan towns) stay, with their hand-set populations
    for ci, c in enumerate(curated):
        if ci in matched:
            continue
        cities.append({
            "name": c["orbis"], "orbis": c["orbis"], "province": c["province"],
            "lon": c["lon"], "lat": c["lat"], "pop": c["pop"], "popBasis": "curated",
            "wealth": c.get("wealth", 1), **({"note": c["note"]} if c.get("note") else {}),
        })

    # rural populations: keep each province's total population and let the countryside
    # absorb the change in the urban figure. Hanson's area formula implies more townspeople
    # than some provinces' totals allow — above all in Greece, where Hellenistic walls enclose
    # far more ground than was lived in by AD 200 (Megalopolis was "a great desert", Strabo
    # 8.8.1). There, the area-based figures are scaled down so towns make up at most a third.
    cur_urban, new_urban, fixed_urban = defaultdict(float), defaultdict(float), defaultdict(float)
    for c in curated:
        cur_urban[c["province"]] += c["pop"]
    for c in cities:
        new_urban[c["province"]] += c["pop"]
        if c["popBasis"] == "curated":
            fixed_urban[c["province"]] += c["pop"]
    rural = {}
    for pid, p in eco["provinces"].items():
        total = p["ruralPop"] + cur_urban[pid]
        if new_urban[pid] > MAX_URBAN_SHARE * total:
            f = (MAX_URBAN_SHARE * total - fixed_urban[pid]) / (new_urban[pid] - fixed_urban[pid])
            for c in cities:
                if c["province"] == pid and c["popBasis"] != "curated":
                    c["hansonPop"] = c["pop"]
                    c["pop"] = round(max(MIN_CITY_POP / 1000, c["pop"] * f), 2)
            new_urban[pid] = sum(c["pop"] for c in cities if c["province"] == pid)
            print(f"  {pid}: Hanson's towns scaled x{f:.2f} to a third of the province")
        rural[pid] = round(total - new_urban[pid])
    # the hand-set surpluses (kg a rural head can send to market) were sized to feed the old
    # city list. Hanson adds townspeople; feed them from their own countryside in the same
    # proportion the province fed its towns before (at most fully), so the great exporters
    # keep their export capacity and importers stay importers
    kg = eco["meta"]["grainKgPerCapita"]
    surplus = {}
    for pid, p in eco["provinces"].items():
        old_pool = p["ruralPop"] * p["surplus"]                   # tonnes
        old_need = cur_urban[pid] * kg
        self_suff = min(1.0, old_pool / old_need) if old_need else 1.0
        pool = old_pool + max(0.0, new_urban[pid] - cur_urban[pid]) * kg * self_suff
        surplus[pid] = round(pool / rural[pid], 1)
    tot_old = sum(p["ruralPop"] for p in eco["provinces"].values()) + sum(cur_urban.values())
    tot_new = sum(rural.values()) + sum(new_urban.values())
    print(f"urban {sum(cur_urban.values())/1000:.1f}M -> {sum(new_urban.values())/1000:.1f}M; "
          f"total {tot_old/1000:.1f}M -> {tot_new/1000:.1f}M")

    # ---------- garrisons ----------
    garrisons = [dict(g) for g in eco["army"]["garrisons"]]

    # ---------- network ----------
    feats = load_itinere()
    print(f"Itiner-e: {len(feats)} road segments, {sum(len(f['lon']) for f in feats):,} vertices")
    v_feat = np.concatenate([np.full(len(f["lon"]), i) for i, f in enumerate(feats)])
    v_idx = np.concatenate([np.arange(len(f["lon"])) for f in feats])
    v_lon = np.concatenate([f["lon"] for f in feats])
    v_lat = np.concatenate([f["lat"] for f in feats])
    vtree = cKDTree(xyz(v_lon, v_lat))

    splits = defaultdict(set)   # feature -> interior vertex indices to cut at

    def attach(lon, lat, max_km):
        ch, j = vtree.query(xyz([lon], [lat])[0])
        d = float(chord_to_km(ch))
        if d > max_km:
            return None
        fi, vi = int(v_feat[j]), int(v_idx[j])
        if 0 < vi < len(feats[fi]["lon"]) - 1:
            splits[fi].add(vi)
        return vkey(v_lon[j], v_lat[j]), d

    anchors = []   # (node id, attach result, lon, lat)
    for n in orbis_nodes:
        anchors.append((n["id"], attach(n["lon"], n["lat"], SNAP_KM["orbis"]), n["lon"], n["lat"]))
    orbis_attached = {nid for nid, a, _, _ in anchors if a}

    next_place = [PLACE_NODE0]
    place_nodes = []

    def place_node(name, lon, lat, kind):
        nid = next_place[0]; next_place[0] += 1
        place_nodes.append({"id": nid, "label": name, "lon": round(lon, 4), "lat": round(lat, 4), "kind": kind})
        anchors.append((nid, attach(lon, lat, SNAP_KM[kind]), lon, lat))
        return nid

    for c in cities:
        c["node"] = orbis_by_label[c["orbis"]]["id"] if c.get("orbis") else place_node(c["name"], c["lon"], c["lat"], "city")
    rome_node = orbis_by_label["Roma"]["id"]
    for g in garrisons:
        g["node"] = rome_node if g["kind"] == "guard" else place_node(g["name"], g["lon"], g["lat"], "garrison")

    # production sources: hand-placed ones from economy.json, except metals and garum,
    # which come from the mines and fish-salting databases: one source per district,
    # weighted by the number of mines or vats found there
    mines, fish, presses, wrecks = load_mines(), load_fish(), load_presses(), load_wrecks()
    city_xyz = cKDTree(xyz([c["lon"] for c in cities], [c["lat"] for c in cities]))

    def near_city(lon, lat):
        d, j = city_xyz.query(xyz([lon], [lat])[0])
        return cities[int(j)]["name"] if chord_to_km(d) < 120 else None

    authored = [s for s in eco["sources"] if s["commodity"] not in DERIVED]
    derived = []
    for com, metal in DERIVED.items():
        hand = [s for s in eco["sources"] if s["commodity"] == com]
        fob = float(np.median([s["fob"] for s in hand]))
        if metal:
            pts = [dict(m, w=1) for m in mines if metal in m["metals"]]
            groups, noun = cluster(pts, 110), "mines"
            # a lone mine joins the nearest district within 300 km rather than routing on its own
            big = [g for g in groups if len(g) > 1]
            for g in [g for g in groups if len(g) == 1]:
                m = g[0]
                near = min(big, key=lambda b: hav(m["lon"], m["lat"], *centroid(b)), default=None)
                if near and hav(m["lon"], m["lat"], *centroid(near)) < 300:
                    near.append(m)
                else:
                    big.append(g)
            groups = big
        else:
            pts = [dict(f, w=f["vats"]) for f in fish]
            groups, noun = cluster(pts, 120), "works"
        for g in groups:
            lon, lat = centroid(g)
            w = sum(m["w"] for m in g)
            if metal is None and w < 6:
                continue   # a lone small workshop is not a regional industry
            near = near_city(lon, lat)
            what = ECO_NOUN.get(com, com.capitalize())
            areas = Counter(m.get("district") or m.get("area") for m in g if m.get("district") or m.get("area")).most_common(2)
            if areas:
                place = areas[0][0] + (f" & {areas[1][0]}" if len(areas) > 1 and areas[1][1] >= 0.25 * len(g) else "")
                label = f"{what} {noun}: {place}"
            else:
                label = f"{what} {noun} near {near}" if near else f"{what} {noun}"
            ev = (f"{len(g)} mine{'s' if len(g) > 1 else ''} in the OXREP database" if metal
                  else f"{len(g)} workshop{'s' if len(g) > 1 else ''}, {int(w)} vats (Motz 2021)"
                       + (f"; {int(sum(m['m3'] or 0 for m in g))} m³ measured by Wilson" if any(m["m3"] for m in g) else ""))
            src = {"commodity": com, "lon": round(lon, 4), "lat": round(lat, 4), "fob": fob,
                   "share": round(w, 1), "label": label, "evidence": ev + (f"; nearest town {near}" if near else ""),
                   "derived": True}
            derived.append(src)
        # carry the hand-written notes over to the district nearest each hand-placed source
        for h in hand:
            hn = orbis_by_label[h["orbis"]] if "orbis" in h else h
            cand = [d for d in derived if d["commodity"] == com]
            if h.get("note") and cand:
                best = min(cand, key=lambda d: hav(d["lon"], d["lat"], hn["lon"], hn["lat"]))
                if hav(best["lon"], best["lat"], hn["lon"], hn["lat"]) < 250 and "note" not in best:
                    best["note"] = h["note"]
                    if com == "garum":
                        best["fob"] = h["fob"]
    for com in DERIVED:
        n = sum(1 for d in derived if d["commodity"] == com)
        print(f"  {com}: {n} districts from the databases")

    sources = []
    for s in authored + derived:
        s = dict(s)
        if "orbis" in s:
            n = orbis_by_label[s["orbis"]]
            s["node"], s["lon"], s["lat"] = n["id"], n["lon"], n["lat"]
        else:
            s["node"] = place_node(s["label"], s["lon"], s["lat"], "source")
        sources.append(s)

    # a source belongs to the province of its nearest city (for the provincial accounts)
    c_tree = cKDTree(xyz([c["lon"] for c in cities], [c["lat"] for c in cities]))
    for s in sources:
        s.setdefault("province", cities[int(c_tree.query(xyz([s["lon"]], [s["lat"]])[0])[1])]["province"])

    # cut the road segments into pieces at junctions and attachment points
    pieces = []
    for fi, f in enumerate(feats):
        n = len(f["lon"])
        cuts = sorted({0, n - 1} | splits.get(fi, set()))
        for a, b in zip(cuts, cuts[1:]):
            lo, la = f["lon"][a:b + 1], f["lat"][a:b + 1]
            u, v = vkey(lo[0], la[0]), vkey(lo[-1], la[-1])
            if u == v:
                continue
            km = sum(hav(lo[i], la[i], lo[i + 1], la[i + 1]) for i in range(len(lo) - 1))
            pieces.append({"u": u, "v": v, "lon": list(lo), "lat": list(la), "km": km,
                           "w": km * f["mult"], "main": km if f["main"] else 0.0})

    # contract pass-through vertices (degree 2) that nothing is attached to
    protected = {a[0] for _, a, _, _ in anchors if a}
    edges = dict(enumerate(pieces))
    inc = defaultdict(set)
    for eid, e in edges.items():
        inc[e["u"]].add(eid); inc[e["v"]].add(eid)
    next_eid = len(pieces)

    def flip(e):
        e["u"], e["v"] = e["v"], e["u"]
        e["lon"].reverse(); e["lat"].reverse()

    for node in list(inc):
        if node in protected or len(inc[node]) != 2:
            continue
        e1, e2 = (edges[i] for i in inc[node])
        i1, i2 = tuple(inc[node])
        if e1["v"] != node: flip(e1)
        if e2["u"] != node: flip(e2)
        if e1["u"] == node or e2["v"] == node or e1["u"] == e2["v"]:
            continue   # loops: leave them be
        m = {"u": e1["u"], "v": e2["v"], "lon": e1["lon"] + e2["lon"][1:], "lat": e1["lat"] + e2["lat"][1:],
             "km": e1["km"] + e2["km"], "w": e1["w"] + e2["w"], "main": e1["main"] + e2["main"]}
        del edges[i1], edges[i2]
        inc[e1["u"]].discard(i1); inc[e2["v"]].discard(i2)
        edges[next_eid] = m
        inc[m["u"]].add(next_eid); inc[m["v"]].add(next_eid)
        next_eid += 1
        del inc[node]

    road_keys = sorted({e["u"] for e in edges.values()} | {e["v"] for e in edges.values()})
    road_id = {k: ORBIS_ROAD_NODE0 + i for i, k in enumerate(road_keys)}
    print(f"road graph: {len(road_keys):,} nodes, {len(edges):,} edges after contraction")

    out_nodes = [{"id": n["id"], "label": n["label"], "lon": n["lon"], "lat": n["lat"]} for n in orbis_nodes]
    out_nodes += [{"id": road_id[k], "lon": k[0] / 1e6, "lat": k[1] / 1e6} for k in road_keys]
    out_nodes += place_nodes

    out_edges = []
    geom_pts = 0
    for e in edges.values():
        ls = LineString(list(zip(e["lon"], e["lat"]))).simplify(SIMPLIFY_DEG, preserve_topology=False)
        g = [round(x, 3) for pt in ls.coords for x in pt]
        geom_pts += len(g) // 2
        out_edges.append({
            "s": road_id[e["u"]], "t": road_id[e["v"]], "km": round(e["km"], 2),
            "days": round(e["w"] / ROAD_KM_PER_DAY, 3), "cost": round(e["w"] * ROAD_COST_PER_KM, 4),
            "mode": "road", "type": "main" if e["main"] >= 0.5 * e["km"] else "secondary", "bi": 1, "g": g,
        })
    # connectors: every anchored place or ORBIS stop to its road vertex
    for nid, a, lon, lat in anchors:
        if not a:
            continue
        key, d = a
        km = max(0.05, d * DETOUR)
        out_edges.append({"s": nid, "t": road_id[key], "km": round(km, 2), "days": round(km / ROAD_KM_PER_DAY, 3),
                          "cost": round(km * ROAD_COST_PER_KM, 4), "mode": "road", "type": "link", "bi": 1})
    # places close to an ORBIS stop also reach it directly (ports, river landings)
    o_tree = cKDTree(xyz([n["lon"] for n in orbis_nodes], [n["lat"] for n in orbis_nodes]))
    for pn in place_nodes:
        ch, j = o_tree.query(xyz([pn["lon"]], [pn["lat"]])[0])
        d = float(chord_to_km(ch))
        if d <= ORBIS_DIRECT_KM:
            km = max(0.05, d * DETOUR)
            out_edges.append({"s": pn["id"], "t": orbis_nodes[j]["id"], "km": round(km, 2),
                              "days": round(km / ROAD_KM_PER_DAY, 3), "cost": round(km * ROAD_COST_PER_KM, 4),
                              "mode": "road", "type": "link", "bi": 1})
    # places Itiner-e can't reach at all fall back to the nearest ORBIS stop — by road if it
    # is on the same land mass, otherwise by boat (the smaller Aegean and Balearic islands)
    land = [g for f in json.load(open(os.path.join(DATA, "med_land.json")))["features"]
            for g in getattr(shape(f["geometry"]), "geoms", [shape(f["geometry"])])]
    land_tree = STRtree(land)

    def landmass(lon, lat):
        i = land_tree.nearest(Point(lon, lat))
        return int(i) if land[int(i)].distance(Point(lon, lat)) < 0.05 else None

    def link(s, t, km, sea):
        if sea:
            return {"s": s, "t": t, "km": round(km, 2), "days": round(km / SEA_LINK_KM_PER_DAY, 3),
                    "cost": round(km * SEA_LINK_COST_PER_KM, 4), "mode": "sea", "type": "coastal", "bi": 1}
        return {"s": s, "t": t, "km": round(km, 2), "days": round(km / ROAD_KM_PER_DAY, 3),
                "cost": round(km * ROAD_COST_PER_KM, 4), "mode": "road", "type": "link", "bi": 1}

    by_node = {n["id"]: n for n in out_nodes}
    for nid, a, lon, lat in anchors:
        if a or nid < PLACE_NODE0:
            continue
        ch, j = o_tree.query(xyz([lon], [lat])[0])
        o = orbis_nodes[j]
        la, lb = landmass(lon, lat), landmass(o["lon"], o["lat"])
        sea = la is None or lb is None or la != lb   # islets too small for the coastline data go by boat
        km = float(chord_to_km(ch)) * (1.1 if sea else DETOUR)
        out_edges.append(link(nid, o["id"], km, sea))
        print(f"  no road near {by_node[nid]['label']}: {'sea' if sea else 'road'} link to ORBIS {o['label']} ({km:.0f} km)")
    # ORBIS: keep sea and river lanes; keep its roads only where Itiner-e doesn't reach
    kept_orbis_roads = 0
    for e in orbis_edges:
        if e["mode"] == "road" and e["s"] in orbis_attached and e["t"] in orbis_attached:
            continue
        kept_orbis_roads += e["mode"] == "road"
        out_edges.append({"s": e["s"], "t": e["t"], "km": e["km"], "days": e["days"], "cost": e["cost"],
                          "mode": e["mode"], "type": e["type"]})
    print(f"kept {kept_orbis_roads} ORBIS road edges where Itiner-e is absent; "
          f"{len(out_nodes):,} nodes, {len(out_edges):,} edges, {geom_pts:,} geometry points")

    # every place must be reachable from Rome; stranded road fragments (Itiner-e's
    # Adriatic island stubs) get a boat to the nearest ORBIS stop that is
    def reach():
        adj = defaultdict(list)
        for e in out_edges:
            adj[e["s"]].append(e["t"])
            if e.get("bi"):
                adj[e["t"]].append(e["s"])
        seen, stack = {rome_node}, [rome_node]
        while stack:
            u = stack.pop()
            for v in adj[u]:
                if v not in seen:
                    seen.add(v); stack.append(v)
        return seen
    seen = reach()
    reach_orbis = [n for n in orbis_nodes if n["id"] in seen]
    ro_tree = cKDTree(xyz([n["lon"] for n in reach_orbis], [n["lat"] for n in reach_orbis]))
    for pl in [p for p in place_nodes if p["id"] not in seen]:
        if pl["id"] in reach():
            continue
        ch, j = ro_tree.query(xyz([pl["lon"]], [pl["lat"]])[0])
        km = float(chord_to_km(ch)) * 1.1
        out_edges.append(link(pl["id"], reach_orbis[j]["id"], km, True))
        print(f"  {pl['label']} stranded: sea link to {reach_orbis[j]['label']} ({km:.0f} km)")
    seen = reach()
    lost = [c["name"] for c in cities if c["node"] not in seen] + [g["name"] for g in garrisons if g["node"] not in seen]
    print(f"unreachable from Rome: {len(lost)} {lost[:20]}")

    # presses don't record oil or wine, and survey coverage is very uneven (Tunisia and
    # Libya are far better known than Baetica), so they don't set output — but each oil or
    # wine source reports what has been found around it
    p_tree = cKDTree(xyz([p["lon"] for p in presses], [p["lat"] for p in presses]))
    for s in sources:
        if s["commodity"] in ("olive_oil", "wine"):
            idx = p_tree.query_ball_point(xyz([s["lon"]], [s["lat"]])[0], 150 / R_EARTH)
            n = sum(presses[i]["n"] for i in idx)
            s["evidence"] = (f"{n} presses at {len(idx)} sites within 150 km in the OXREP presses database"
                             if idx else "no presses within 150 km in the OXREP presses database")

    def span(a, b):
        if a is None and b is None:
            return ""
        f = lambda y: f"{-int(y)} BC" if y < 0 else f"AD {int(y)}"
        return f"{f(a) if a is not None else '?'}–{f(b) if b is not None else '?'}"

    sites = {
        "credit": "Mines, presses &amp; wrecks: OXREP (Wilson &amp; Friedman; Marzano &amp; Flohr; Strauss) · "
                  "Fish-salting: Motz 2021 (ODbL), Wilson 2007 · Wreck positions: MAPS 2020 (CC BY-NC-SA)",
        "about": "<b>Archaeology.</b> The model's silver, gold and copper come from the mining districts of the OXREP "
                 "Mines Database (551 mines; Spain is over-represented because it is best catalogued), and its garum "
                 "from the fish-salting workshops of Motz's 2021 dataset, weighted by vats. The OXREP presses (which "
                 "don't record oil or wine) and Strauss's shipwrecks of c. AD 100–300 are shown as evidence to lay "
                 "against the model: do the wrecks lie on its busy sea lanes?",
        "layers": {
            "wrecks": {"name": f"Shipwrecks c. AD 100–300 ({len(wrecks)}, Strauss)", "color": "#6d7c86", "sites": [
                {"name": w["name"], "lon": round(w["lon"], 3), "lat": round(w["lat"], 3), "r": 3,
                 "color": CARGO_COLOR.get(w["cargo"][0], "#6d7c86") if w["cargo"] else "#6d7c86",
                 "info": "; ".join(x for x in [w["dating"], ", ".join(w["cargo"]) or "cargo not recorded",
                                               w["amph"], (f"from {w['origin']}" if w["origin"] else ""),
                                               (f"to {w['dest']}" if w["dest"] else ""),
                                               (f"≈{int(w['t'])} t" if w["t"] else "")] if x)}
                for w in wrecks]},
            "mines": {"name": f"Mines ({len(mines)}, OXREP)", "color": "#c0c0c0", "sites": [
                {"name": m["name"], "lon": round(m["lon"], 3), "lat": round(m["lat"], 3), "r": 3,
                 "color": METAL_COLOR[m["metals"][0]],
                 "info": "; ".join(x for x in [", ".join(m["metals"]), m["techniques"], span(m["start"], m["end"])] if x)}
                for m in mines]},
            "presses": {"name": f"Oil & wine presses ({sum(p['n'] for p in presses)} at {len(presses)} sites, OXREP)",
                        "color": "#8a9a2e", "sites": [
                {"name": p["name"], "lon": round(p["lon"], 3), "lat": round(p["lat"], 3),
                 "r": round(2.5 + 1.2 * math.sqrt(p["n"]), 1),
                 "info": "; ".join(x for x in [f"{p['n']} press{'es' if p['n'] > 1 else ''}", p["type"], span(p["from"], p["to"])] if x)}
                for p in presses]},
            "fish": {"name": f"Fish-salting works ({len(fish)}, Motz)", "color": "#b06a3b", "sites": [
                {"name": f["name"], "lon": round(f["lon"], 3), "lat": round(f["lat"], 3),
                 "r": round(2.5 + 0.9 * math.sqrt(f["vats"]), 1),
                 "info": "; ".join(x for x in [f["site"], f"{int(f['vats'])} vats", (f"{int(f['m3'])} m³ (Wilson)" if f["m3"] else ""),
                                               (f"built c. AD {int(f['start'])}" if f["start"] is not None and f["start"] >= 0 else
                                                f"built c. {-int(f['start'])} BC" if f["start"] is not None else "")] if x)}
                for f in fish]},
        },
    }
    json.dump(sites, open(os.path.join(DATA, "sites.json"), "w"), separators=(",", ":"), ensure_ascii=False)

    json.dump({"nodes": out_nodes, "edges": out_edges}, open(os.path.join(DATA, "network.json"), "w"),
              separators=(",", ":"), ensure_ascii=False)
    places = {"cities": cities, "garrisons": garrisons, "sources": sources,
              "provinces": {pid: {"ruralPop": rural[pid], "surplus": surplus[pid]} for pid in rural}}
    json.dump(places, open(os.path.join(DATA, "places.json"), "w"), separators=(",", ":"), ensure_ascii=False)
    for fn in ("network.json", "places.json", "sites.json"):
        print(f"wrote data/{fn}: {os.path.getsize(os.path.join(DATA, fn)) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
