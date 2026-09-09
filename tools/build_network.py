#!/usr/bin/env python3
"""Convert the ORBIS v2 node/edge CSVs (Stanford Digital Repository,
purl.stanford.edu/mn425tz9757, CC-BY) into data/network.json.

Nodes: id, label, lon, lat.
Edges: source, target, km, days, expense (Diocletianic denarii per kg of
grain — same unit as the Price Edict, so freight adds directly to prices).

River types (upstream/downstream/fastup/fastdown) are directed; everything
else is treated as bidirectional. Where parallel edges exist between the
same pair in the same direction (fast vs slow river, coastal vs slowcoast)
we keep the cheapest for routing and note the fastest days separately.
"""
import csv, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data", "raw")
OUT = os.path.join(HERE, "..", "data", "network.json")

DIRECTED = {"upstream", "downstream", "fastup", "fastdown"}
SEA = {"coastal", "overseas", "slowcoast", "slowover", "ferry"}

# the deposit is missing coordinates for a few dozen nodes; these are real,
# identifiable places, so supply them rather than sever their routes  (lon, lat)
KNOWN_COORDS = {
    "Agrigentum": (13.576, 37.311),
    "Aleria": (9.513, 42.104),
    "Amphipolis": (23.845, 40.822),
    "Boiodurum": (13.46, 48.574),
    "Demetrias": (22.93, 39.35),
    "Forum Appii": (13.03, 41.43),
    "Horreum Margi": (21.37, 43.93),
    "Krane": (20.48, 38.18),
    "Malaca": (-4.42, 36.72),
    "Mouth of Witham": (0.07, 52.96),
    "Neapolis (Thrace)": (24.41, 40.94),
    "Palinurus Pr.": (15.28, 40.02),
    "Palma": (2.65, 39.57),
    "Panormus": (13.36, 38.12),
    "Populonium": (10.49, 42.99),
    "Samonion Pr.": (26.31, 35.30),
    "Selinous": (12.82, 37.58),
    "Toletum": (-4.03, 39.86),
    "Tripolis": (35.84, 34.44),
    "Olbia": (9.50, 40.92),  # Sardinia; the deposit has it at 0,0
}

nodes = []
pending = []  # coordinate-less junctions: place at mean of neighbours later
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

# junction nodes are labelled "x" — keep them (the network needs them) but flag
for n in nodes:
    if n["label"] == "x":
        n["junction"] = True

best = {}  # (s,t) -> edge dict, cheapest expense wins
with open(os.path.join(RAW, "orbis_edges.csv")) as f:
    for r in csv.DictReader(f):
        s, t = int(r["source"]), int(r["target"])
        e = {
            "s": s, "t": t,
            "km": float(r["km"]),
            "days": float(r["days"]),
            "cost": float(r["expense"]),
            "type": r["type"],
        }
        dirs = [(s, t)] if r["type"] in DIRECTED else [(s, t), (t, s)]
        for a, b in dirs:
            k = (a, b)
            if k not in best or e["cost"] < best[k]["cost"]:
                best[k] = {**e, "s": a, "t": b}

# place coordinate-less junctions at the mean of their placed neighbours,
# iterating so chains of junctions settle into position
if pending:
    neigh = {}
    for (a, b) in best:
        neigh.setdefault(a, set()).add(b)
        neigh.setdefault(b, set()).add(a)
    byid = {n["id"]: n for n in nodes}
    for _ in range(20):
        moved = False
        for n in pending:
            pts = [(byid[m]["lon"], byid[m]["lat"]) for m in neigh.get(n["id"], [])
                   if "lon" in byid[m]]
            if pts:
                lon = sum(p[0] for p in pts) / len(pts)
                lat = sum(p[1] for p in pts) / len(pts)
                if n.get("lon") != lon or n.get("lat") != lat:
                    n["lon"], n["lat"] = round(lon, 4), round(lat, 4)
                    moved = True
        if not moved:
            break
    nodes = [n for n in nodes if "lon" in n]
    print(f"placed {sum(1 for n in pending if 'lon' in n)} junctions by neighbour mean, "
          f"dropped {sum(1 for n in pending if 'lon' not in n)} isolated")

ids = {n["id"] for n in nodes}
edges = [e for e in best.values() if e["s"] in ids and e["t"] in ids]
sea = {"s", "t"}
mode = lambda ty: "sea" if ty in SEA else ("river" if ty in DIRECTED else "road")
for e in edges:
    e["mode"] = mode(e["type"])

data = {"nodes": nodes, "edges": edges}
with open(OUT, "w") as f:
    json.dump(data, f, separators=(",", ":"))
print(f"{len(nodes)} nodes, {len(edges)} directed edges -> {os.path.relpath(OUT, os.path.join(HERE,'..'))}")
from collections import Counter
print(Counter(e["mode"] for e in edges))
