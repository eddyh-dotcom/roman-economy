// app.js — map + UI for Imperium, the Roman economy simulator.
(function () {
  "use strict";

  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const fmt = n => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const fmt1 = n => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const kt = t => t >= 100 ? fmt(t) + " kt" : (t >= 1 ? fmt1(t) + " kt" : fmt(t * 1000) + " t");
  const dc = p => p >= 100 ? fmt(p) : p.toLocaleString("en-US", { maximumFractionDigits: p >= 10 ? 1 : 2 });
  const pct = x => Math.round(100 * x) + "%";
  const people = k => fmt(Math.round(k * 1000 / (k >= 10 ? 1000 : 100)) * (k >= 10 ? 1000 : 100));

  let ECO, PL, SITES, RESULT, map;
  let view = "food";            // food | production | trade | army | wages | fiscal
  let comFilter = "all";        // commodity id or "all"
  let fiscalMode = "tax";       // tax | trade | gap
  const shocks = new Set();
  const layersOn = { roads: true };
  let selected = null;          // {kind: "city"|"source"|"garrison"|"province", ...}

  let roadLayer, flowLayer, cityLayer, sourceLayer, armyLayer, provLayer, siteLayer, highlightLayer;
  const R = {};                 // canvas renderers, one per pane

  const STATUS_COLOR = { local: "#7cb56b", fed: "#5b9bd5", strained: "#e0a63c", famine: "#d1493f" };
  const KIND_COLOR = { legion: "#d0513f", auxilia: "#e3913f", fleet: "#5b9bd5", guard: "#b48ad8" };
  const KIND_NAME = { legion: "legion", auxilia: "auxiliaries", fleet: "fleet", guard: "Rome garrison" };
  const PAYER = "#d9a62e", RECIPIENT = "#5b9bd5", SURPLUS = "#7cb56b", DEFICIT = "#d1493f";
  const VIEWS = [["food", "Food & population"], ["production", "Production"], ["trade", "Trade flows"],
                 ["army", "The army"], ["wages", "Real wages"], ["fiscal", "Taxes & trade"]];

  // ---------- boot ----------
  const get = u => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
  Promise.all(["data/network.json", "data/economy.json", "data/places.json", "data/med_land.json", "data/sites.json"].map(get))
    .then(([net, eco, places, land, sites]) => {
      ECO = eco; PL = places; SITES = sites;
      Graph.init(net);
      Engine.init(eco, places);
      buildMap(land);
      buildSidebar();
      recompute();
    });

  function buildMap(land) {
    map = L.map("map", {
      zoomControl: true, attributionControl: false,
      minZoom: 4, maxZoom: 10, zoomSnap: 0.5,
    }).setView([41, 16], 5);
    ["roads", "flows", "provinces", "cities", "sites", "sources", "army", "highlight"].forEach((name, i) => {
      map.createPane(name).style.zIndex = 400 + i * 10;
      R[name] = L.canvas({ pane: name, padding: 0.4 });
    });
    L.geoJSON(land, {
      style: { fillColor: "#232f38", fillOpacity: 1, color: "#41586a", weight: 1 },
      interactive: false,
    }).addTo(map);
    roadLayer = buildRoads();
    if (layersOn.roads) roadLayer.addTo(map);
    flowLayer = L.layerGroup().addTo(map);
    provLayer = L.layerGroup().addTo(map);
    siteLayer = L.layerGroup().addTo(map);
    sourceLayer = L.layerGroup().addTo(map);
    cityLayer = L.layerGroup().addTo(map);
    armyLayer = L.layerGroup().addTo(map);
    highlightLayer = L.layerGroup().addTo(map);
    map.on("click", () => { select(null); });
  }

  // the Itiner-e network as two faint multi-polylines, main roads a little brighter
  function buildRoads() {
    const main = [], secondary = [];
    Graph.edges().forEach((e, k) => {
      if (e.mode !== "road" || !e.g) return;
      (e.type === "main" ? main : secondary).push(Graph.edgeLatLngs(k));
    });
    return L.layerGroup([
      L.polyline(secondary, { renderer: R.roads, color: "#3b4d59", weight: 0.7, opacity: 0.7, interactive: false }),
      L.polyline(main, { renderer: R.roads, color: "#566f7f", weight: 1.1, opacity: 0.85, interactive: false }),
    ]);
  }

  // ---------- sidebar ----------
  function buildSidebar() {
    const vr = $("#viewRadios");
    VIEWS.forEach(([id, label]) => {
      const l = el("label", "radio");
      l.innerHTML = `<input type="radio" name="view" value="${id}" ${id === view ? "checked" : ""}> ${label}`;
      l.querySelector("input").addEventListener("change", () => { view = id; select(null); render(); });
      vr.appendChild(l);
    });

    const cf = $("#comFilter");
    cf.appendChild(new Option("All commodities", "all"));
    Object.entries(ECO.commodities).forEach(([cid, c]) => cf.appendChild(new Option(c.name, cid)));
    cf.addEventListener("change", () => { comFilter = cf.value; select(null); render(); });
    $("#fiscalMode").addEventListener("change", ev => { fiscalMode = ev.target.value; render(); });

    const sh = $("#shockList");
    ECO.shocks.forEach(s => {
      const l = el("label", "shock");
      l.innerHTML = `<input type="checkbox" value="${s.id}"> <span class="shockName">${s.name}</span><span class="shockDesc">${s.desc}</span>`;
      l.querySelector("input").addEventListener("change", ev => {
        ev.target.checked ? shocks.add(s.id) : shocks.delete(s.id);
        recompute();
      });
      sh.appendChild(l);
    });

    const ll = $("#layerList");
    const layerDefs = [["roads", "Roman roads (Itiner-e)"]];
    if (SITES) Object.entries(SITES.layers).forEach(([id, L]) => layerDefs.push([id, L.name]));
    layerDefs.forEach(([id, label]) => {
      const l = el("label", "radio");
      l.innerHTML = `<input type="checkbox" ${layersOn[id] ? "checked" : ""}> ${label}`;
      l.querySelector("input").addEventListener("change", ev => {
        layersOn[id] = ev.target.checked;
        if (id === "roads") ev.target.checked ? roadLayer.addTo(map) : map.removeLayer(roadLayer);
        else renderSites();
      });
      ll.appendChild(l);
    });
    if (SITES) {
      $("#aboutSites").innerHTML = SITES.about || "";
      $("#footSites").innerHTML = SITES.credit ? SITES.credit + " · " : "";
    }

    const ed = $("#edictBody");
    ECO.edictSampler.forEach(r => {
      ed.appendChild(el("div", "edictRow", `<span>${r.item}</span><b>${r.price}</b>`));
    });
    $("#edictToggle").addEventListener("click", () => $("#edictBody").classList.toggle("open"));
    $("#aboutToggle").addEventListener("click", () => $("#aboutBody").classList.toggle("open"));
  }

  function recompute() {
    const t0 = performance.now();
    RESULT = Engine.compute({ shocks });
    timing.compute = performance.now() - t0;
    renderTotals();
    render();
    if (selected) reselect();
  }

  function renderTotals() {
    const t = RESULT.totals, f = RESULT.fiscal;
    $("#totals").innerHTML =
      `<div><b>${fmt1(t.pop / 1000)} M</b><span>people</span></div>` +
      `<div><b>${fmt1(t.urban / 1000)} M</b><span>in ${fmt(RESULT.cities.length)} towns</span></div>` +
      `<div><b>${fmt(t.soldiers / 1000)} k</b><span>soldiers</span></div>` +
      `<div><b>${fmt(t.grainTraded)} kt</b><span>grain shipped/yr</span></div>` +
      `<div><b>${fmt1(100 * f.rate)}%</b><span>tax on output</span></div>` +
      `<div class="${t.famines ? "bad" : ""}"><b>${t.famines ? t.famines : t.strained}</b><span>${t.famines ? "towns in famine" : "towns short of grain"}</span></div>`;
  }

  // ---------- rendering ----------
  function render() {
    [flowLayer, cityLayer, sourceLayer, armyLayer, provLayer].forEach(l => l.clearLayers());
    if (!selected) highlightLayer.clearLayers();
    $("#comFilter").style.display = (view === "production" || view === "trade") ? "" : "none";
    $("#fiscalMode").style.display = view === "fiscal" ? "" : "none";
    const T = timing, t = () => performance.now();
    let t0 = t();
    renderFlows(); T.flows = t() - t0; t0 = t();
    if (view === "production") renderSources();
    if (view === "army") renderGarrisons();
    if (view === "fiscal") renderProvinces();
    T.overlays = t() - t0; t0 = t();
    renderCities(); T.cities = t() - t0; t0 = t();
    renderSites(); T.sites = t() - t0; t0 = t();
    renderLegend();
  }
  const timing = {};

  // per-edge tonnage and colour for the current view
  function flowsToDraw() {
    const F = RESULT.edgeFlows, C = ECO.commodities;
    let keys;
    if (view === "food") keys = ["grain"];
    else if (view === "production") keys = comFilter === "all" ? [] : [comFilter];
    else if (view === "trade") keys = comFilter === "all" ? Object.keys(C) : [comFilter];
    else if (view === "army") keys = ["grain_mil", ...Object.keys(C).map(c => "army:" + c)];
    else return [];
    keys = keys.filter(k => F[k]);
    if (!keys.length) return [];
    const colorOf = k => C[k.replace("army:", "").replace("grain_mil", "grain")].color;
    const out = [];
    const E = F[keys[0]].length;
    for (let e = 0; e < E; e++) {
      let t = 0, best = null, bt = 0;
      for (const k of keys) {
        const v = F[k][e];
        if (v > 0) { t += v; if (v > bt) { bt = v; best = k; } }
      }
      if (t > 0.005) out.push({ e, t, color: colorOf(best) });
    }
    return out;
  }

  // edges batched into one multi-polyline per colour and (quantised) width
  function renderFlows() {
    const fl = flowsToDraw();
    if (!fl.length) return;
    const max = Math.max(...fl.map(f => f.t));
    const groups = new Map();
    fl.forEach(({ e, t, color }) => {
      if (t < max * 0.0015) return;
      const w = Math.round((0.5 + 6 * Math.sqrt(t / max)) * 2) / 2;
      const key = color + "|" + w;
      if (!groups.has(key)) groups.set(key, { color, w, lines: [] });
      groups.get(key).lines.push(Graph.edgeLatLngs(e));
    });
    [...groups.values()].sort((a, b) => a.w - b.w).forEach(g => {
      L.polyline(g.lines, { renderer: R.flows, color: g.color, weight: g.w, opacity: 0.6, interactive: false }).addTo(flowLayer);
    });
  }

  function cityRadius(c) { return 1.5 + 2.4 * Math.sqrt(c.pop / 10); }

  function wageColor(r) {
    // diverging around the bare-bones line: red below 1, green above
    const stops = [[0.8, [209, 73, 63]], [0.95, [224, 166, 60]], [1.1, [222, 214, 150]], [1.25, [124, 181, 107]], [1.4, [60, 150, 110]]];
    if (r <= stops[0][0]) return `rgb(${stops[0][1]})`;
    for (let i = 1; i < stops.length; i++) {
      if (r <= stops[i][0]) {
        const [a, ca] = stops[i - 1], [b, cb] = stops[i], f = (r - a) / (b - a);
        return `rgb(${ca.map((v, j) => Math.round(v + f * (cb[j] - v))).join(",")})`;
      }
    }
    return `rgb(${stops[stops.length - 1][1]})`;
  }

  function renderCities() {
    const dim = view === "army" || view === "fiscal";
    RESULT.cities.forEach(c => {
      const ll = Graph.latlng(c.nodeId);
      const r = dim ? Math.max(1.2, cityRadius(c) * 0.6) : cityRadius(c);
      let fill = "#8f8465", stroke = "#0e161c", op = 0.9;
      if (view === "food") fill = STATUS_COLOR[c.grain.status];
      else if (view === "wages") fill = wageColor(c.wage.ratio);
      else if (view === "trade" || view === "production") fill = "#c9b98a";
      else { fill = "#77705d"; op = 0.55; }
      const m = L.circleMarker(ll, {
        renderer: R.cities, radius: r, fillColor: fill, fillOpacity: op, color: stroke, weight: 0.8,
      }).addTo(cityLayer);
      const extra = view === "wages" ? ` — wage buys ${c.wage.ratio.toFixed(2)}× a family's bare needs` : "";
      m.bindTooltip(`<b>${c.name}</b> — ${people(c.pop)} people${extra}`, { direction: "top", opacity: 0.95 });
      m.on("click", ev => { L.DomEvent.stopPropagation(ev); select({ kind: "city", city: c }); });
      if (c.pop >= 60 && !dim) {
        L.tooltip({ permanent: true, direction: "right", className: "cityLabel", offset: [r, 0] })
          .setContent(c.name).setLatLng(ll).addTo(cityLayer);
      }
    });
  }

  function renderSources() {
    RESULT.sources.forEach(s => {
      if (comFilter !== "all" && s.commodity !== comFilter) return;
      const com = ECO.commodities[s.commodity];
      const m = L.circleMarker(Graph.latlng(s.nodeId), {
        renderer: R.sources, radius: 7, fillColor: com.color, fillOpacity: 0.95, color: "#0e161c", weight: 1.5,
      }).addTo(sourceLayer);
      m.bindTooltip(`<b>${s.label}</b><br>${com.name} — ships ${kt(s.shipped)}/yr`, { direction: "top", opacity: 0.95 });
      m.on("click", ev => { L.DomEvent.stopPropagation(ev); select({ kind: "source", source: s }); });
    });
  }

  function renderGarrisons() {
    RESULT.garrisons.forEach(g => {
      const size = Math.round(6 + 9 * Math.sqrt(g.men / 5500));
      const ring = g.fed && g.grain.status === "strained" ? "#e0a63c" : g.fed && g.grain.status === "famine" ? "#d1493f" : "#0e161c";
      const icon = L.divIcon({
        className: "garrison",
        html: `<i style="width:${size}px;height:${size}px;background:${KIND_COLOR[g.kind]};border-color:${ring}"></i>`,
        iconSize: [size, size],
      });
      const m = L.marker(Graph.latlng(g.nodeId), { icon, pane: "army", keyboard: false }).addTo(armyLayer);
      m.bindTooltip(`<b>${g.name}</b> — ${g.unit}<br>${fmt(g.men)} men`, { direction: "top", opacity: 0.95 });
      m.on("click", ev => { L.DomEvent.stopPropagation(ev); select({ kind: "garrison", garrison: g }); });
    });
  }

  // population-weighted centre of each province's towns
  function provinceCentres() {
    const acc = {};
    RESULT.cities.forEach(c => {
      const [la, lo] = Graph.latlng(c.nodeId);
      const a = acc[c.province] || (acc[c.province] = { w: 0, la: 0, lo: 0 });
      a.w += c.pop; a.la += c.pop * la; a.lo += c.pop * lo;
    });
    const out = {};
    Object.entries(acc).forEach(([pid, a]) => out[pid] = [a.la / a.w, a.lo / a.w]);
    out.italia = [42.3, 12.9];    // not Rome itself: the bubble would hide the city
    return out;
  }

  function fiscalValue(p) {
    return fiscalMode === "tax" ? p.net : fiscalMode === "trade" ? p.trade : p.trade - p.coinOut;
  }

  function renderProvinces() {
    const P = RESULT.fiscal.provinces, ctr = provinceCentres();
    const vals = Object.values(P).map(p => Math.abs(fiscalValue(p)));
    const max = Math.max(...vals, 1e-9);
    if (fiscalMode === "tax") drawTransfers(P, ctr);
    Object.values(P).forEach(p => {
      if (!ctr[p.id]) return;
      const v = fiscalValue(p);
      const color = fiscalMode === "tax" ? (v >= 0 ? PAYER : RECIPIENT) : (v >= 0 ? SURPLUS : DEFICIT);
      const m = L.circleMarker(ctr[p.id], {
        renderer: R.provinces, radius: 5 + 26 * Math.sqrt(Math.abs(v) / max),
        fillColor: color, fillOpacity: 0.55, color, weight: 1.5,
      }).addTo(provLayer);
      const what = fiscalMode === "tax" ? (v >= 0 ? `pays in ${kt(v)}` : `receives ${kt(-v)}`)
        : fiscalMode === "trade" ? (v >= 0 ? `exports ${kt(v)} more than it imports` : `imports ${kt(-v)} more than it exports`)
        : (v >= 0 ? `trade earns ${kt(v)} more than taxes take` : `taxes take ${kt(-v)} more than trade earns back`);
      m.bindTooltip(`<b>${p.name}</b> — ${what} <span class="unit">wheat-eq./yr</span>`, { direction: "top", opacity: 0.95 });
      m.on("click", ev => { L.DomEvent.stopPropagation(ev); select({ kind: "province", pid: p.id }); });
      L.tooltip({ permanent: true, direction: "center", className: "provLabel" })
        .setContent(shortName(p)).setLatLng(ctr[p.id]).addTo(provLayer);
    });
  }

  const SHORT = { germania_inferior: "Germ. Inf.", germania_superior: "Germ. Sup.", sardinia_corsica: "Sardinia",
                  bithynia_pontus: "Bithynia", lycia_pamphylia: "Lycia", africa: "Africa" };
  function shortName(p) { return SHORT[p.id] || p.name.replace(/^(Gallia|Hispania) /, "").split(" ")[0]; }

  // tax transfers: each net payer's surplus shared among the net recipients in
  // proportion to their deficits; the largest few dozen drawn as arcs
  function drawTransfers(P, ctr) {
    const pay = Object.values(P).filter(p => p.net > 0 && ctr[p.id]);
    const rec = Object.values(P).filter(p => p.net < 0 && ctr[p.id]);
    const recTot = rec.reduce((s, p) => s - p.net, 0);
    const tr = [];
    pay.forEach(a => rec.forEach(b => tr.push({ a, b, t: a.net * (-b.net) / recTot })));
    tr.sort((x, y) => y.t - x.t);
    const top = tr.slice(0, 45), max = top.length ? top[0].t : 1;
    top.forEach(({ a, b, t }) => {
      const pts = arc(ctr[a.id], ctr[b.id]);
      L.polyline(pts, { renderer: R.flows, color: PAYER, weight: 0.6 + 7 * Math.sqrt(t / max), opacity: 0.45, interactive: false }).addTo(provLayer);
      // arrowhead near the recipient
      const [p1, p2] = [pts[pts.length - 4], pts[pts.length - 2]];
      const dy = p2[0] - p1[0], dx = p2[1] - p1[1], len = Math.hypot(dx, dy) || 1, s = 0.35 + 0.5 * Math.sqrt(t / max);
      const ux = dx / len, uy = dy / len;
      L.polygon([[p2[0], p2[1]], [p2[0] - s * uy + s * 0.5 * ux, p2[1] - s * ux - s * 0.5 * uy], [p2[0] - s * uy - s * 0.5 * ux, p2[1] - s * ux + s * 0.5 * uy]],
        { renderer: R.flows, color: PAYER, fillColor: PAYER, fillOpacity: 0.7, weight: 0, interactive: false }).addTo(provLayer);
    });
  }
  function arc(a, b) {
    const [la1, lo1] = a, [la2, lo2] = b;
    const mx = (lo1 + lo2) / 2, my = (la1 + la2) / 2, dx = lo2 - lo1, dy = la2 - la1;
    const cx = mx - dy * 0.18, cy = my + dx * 0.18;   // bend to one side: direction reads clockwise
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, u = 1 - t;
      pts.push([u * u * la1 + 2 * u * t * cy + t * t * la2, u * u * lo1 + 2 * u * t * cx + t * t * lo2]);
    }
    return pts;
  }

  function renderSites() {
    siteLayer.clearLayers();
    if (!SITES) return;
    Object.entries(SITES.layers).forEach(([id, Ly]) => {
      if (!layersOn[id]) return;
      Ly.sites.forEach(s => {
        const m = L.circleMarker([s.lat, s.lon], {
          renderer: R.sites, radius: s.r || 3, fillColor: s.color || Ly.color, fillOpacity: 0.85,
          color: "#0e161c", weight: 0.6,
        }).addTo(siteLayer);
        m.bindTooltip(`<b>${s.name}</b>${s.info ? "<br>" + s.info : ""}`, { direction: "top", opacity: 0.95 });
      });
    });
  }

  function renderLegend() {
    const lg = $("#legend"), T = RESULT.totals, F = RESULT.fiscal;
    if (view === "food") {
      lg.innerHTML = "<b>Grain supply</b>" +
        [["local", "fed by own hinterland"], ["fed", "fed by imports"], ["strained", "short or dear"], ["famine", "famine"]]
          .map(([k, t]) => `<span><i style="background:${STATUS_COLOR[k]}"></i>${t}</span>`).join("") +
        `<span class="hint">gold lines: grain shipments along the real roads and sea lanes; circle size = population (Hanson); click a town</span>`;
    } else if (view === "production") {
      lg.innerHTML = "<b>Production</b><span class='hint'>dots are production sources — pick a commodity above, click a source to see where it ships</span>";
    } else if (view === "trade") {
      const coms = comFilter === "all" ? [] : [[comFilter, ECO.commodities[comFilter]]];
      lg.innerHTML = "<b>Trade flows</b>" +
        (comFilter === "all"
          ? "<span class='hint'>edges coloured by dominant cargo; width = tonnage; click a town for its trade profile</span>"
          : coms.map(([cid, c]) => `<span><i style="background:${c.color}"></i>${c.name}</span>`).join(""));
    } else if (view === "army") {
      const byKind = {};
      RESULT.garrisons.forEach(g => byKind[g.kind] = (byKind[g.kind] || 0) + g.men);
      const local = RESULT.garrisons.reduce((s, g) => s + g.grain.local, 0);
      const need = RESULT.garrisons.reduce((s, g) => s + g.grainDemand, 0);
      lg.innerHTML = `<b>The army — ${fmt(T.soldiers)} men</b>` +
        Object.entries(byKind).map(([k, n]) => `<span><i class="sq" style="background:${KIND_COLOR[k]}"></i>${KIND_NAME[k]} ${fmt(n / 1000)}k</span>`).join("") +
        `<span class="hint">It costs ${kt(F.armyCost)} of wheat-equivalent a year — ${pct(F.armyShare)} of the state's spending. ` +
        `${pct(local / need)} of its grain is requisitioned in its own provinces; lines show what the state ships to it — grain, and the oil, wine and cloth it buys with its pay. ` +
        `Orange outline: the garrison's province is short of grain.</span>`;
    } else if (view === "wages") {
      const rs = RESULT.cities.map(c => c.wage.ratio).sort((a, b) => a - b);
      const med = rs[Math.floor(rs.length / 2)];
      lg.innerHTML = `<b>What a labourer's day wage buys</b>` +
        [0.85, 1.0, 1.1, 1.2, 1.3].map(r => `<span><i style="background:${wageColor(r)}"></i>${r.toFixed(2)}</span>`).join("") +
        `<span class="hint">Allen's welfare ratio: a family's income over the cost of three 'bare bones' baskets plus rent. 1 = just enough. ` +
        `At the Edict's own prices it is ${RESULT.wages.edictRatio.toFixed(2)}; across the empire's towns it runs ${rs[0].toFixed(2)}–${rs[rs.length - 1].toFixed(2)} (median ${med.toFixed(2)}), because the wage is fixed and the prices are not.</span>`;
    } else {
      const lead = fiscalMode === "tax"
        ? `<span><i style="background:${PAYER}"></i>pays in more than the state spends there</span><span><i style="background:${RECIPIENT}"></i>receives more than it pays</span>`
        : fiscalMode === "trade"
          ? `<span><i style="background:${SURPLUS}"></i>exports more than it imports</span><span><i style="background:${DEFICIT}"></i>imports more</span>`
          : `<span><i style="background:${SURPLUS}"></i>trade earns back more coin than taxes take</span><span><i style="background:${DEFICIT}"></i>coin drains out</span>`;
      const hint = fiscalMode === "tax"
        ? "Arrows: the taxes of the interior provinces paying for Rome and the frontier armies."
        : fiscalMode === "trade"
          ? "The model's market trade between provinces (grain and goods at origin prices; tax grain and bullion excluded)."
          : "Hopkins: a province that pays more coin in taxes than the state spends there must export to earn it back. Green/red = how far the model's trade falls short of that.";
      lg.innerHTML = `<b>Taxes &amp; trade</b>${lead}<span class="hint">State spending ${kt(F.budget)} of wheat-equivalent a year (${fmt1(100 * F.budget / F.gdp)}% of output) → a tax of ${fmt1(100 * F.rate)}% on provincial output (Italy a fifth of that, Egypt half again). ${hint} Click a province.</span>`;
    }
  }

  // ---------- selection & detail panel ----------
  function select(sel) {
    selected = sel;
    highlightLayer.clearLayers();
    const panel = $("#detail");
    if (!sel) { panel.classList.remove("open"); panel.innerHTML = ""; return; }
    panel.classList.add("open");
    if (sel.kind === "city") showCity(sel.city);
    else if (sel.kind === "source") showSource(sel.source);
    else if (sel.kind === "garrison") showGarrison(sel.garrison);
    else showProvince(sel.pid);
  }
  function reselect() {
    if (!selected) return;
    if (selected.kind === "city") {
      const c = RESULT.cities.find(x => x.nodeId === selected.city.nodeId && x.name === selected.city.name);
      select(c ? { kind: "city", city: c } : null);
    } else if (selected.kind === "source") {
      const s = RESULT.sources.find(x => x.label === selected.source.label);
      select(s ? { kind: "source", source: s } : null);
    } else if (selected.kind === "garrison") {
      const g = RESULT.garrisons.find(x => x.name === selected.garrison.name);
      select(g ? { kind: "garrison", garrison: g } : null);
    } else select(selected);
  }

  function drawLatLngs(pts, color, weight) {
    if (!pts || pts.length < 2) return;
    L.polyline(pts, { pane: "highlight", color, weight: weight || 3, opacity: 0.9 }).addTo(highlightLayer);
  }
  function drawRoute(tree, dstId, color, weight) {
    drawLatLngs(Graph.pathLatLngs(Graph.pathArcs(tree, dstId)), color, weight);
  }

  function popLine(c) {
    const src = c.popBasis === "area"
      ? `Hanson: ${fmt(c.area)} ha built-up → ${people(c.hansonPop || c.pop)} (Hanson &amp; Ortman's formula)`
      : c.popBasis === "rank" ? `Hanson lists no area; median for a town of its Barrington Atlas rank`
      : `outside Hanson's list; hand estimate`;
    let s = src;
    if (c.hansonPop) s += `, scaled to ${people(c.pop)} so ${RESULT.provinces[c.province].name}'s towns stay within its population`;
    if (c.prevPop && Math.abs(c.prevPop - c.pop) / c.prevPop > 0.1) s += `. Earlier hand estimate: ${fmt(c.prevPop * 1000)}`;
    return s + ".";
  }

  function grainTable(e, withLocal) {
    const g = e.grain, p = RESULT.provinces[e.province];
    let html = `<table class="tbl"><tr><th>source</th><th>share</th><th>price</th></tr>`;
    if (g.local > 0.001 && withLocal) {
      html += `<tr><td>${p.name} ${e.kind === "city" ? "hinterland" : "requisition"}</td><td>${pct(g.local / e.grainDemand)}</td><td>${dc(g.localPrice)}</td></tr>`;
    }
    g.imports.filter(i => i.t / e.grainDemand >= 0.005).forEach(i => {
      const tag = i.kind === "annona" ? ' <b class="annona">annona</b>' : i.kind === "military" ? ' <b class="annona">state</b>' : "";
      html += `<tr><td>${i.from.name}${tag} <span class="via">via ${Graph.node(i.gatewayNode).label}, ${Math.round(i.days)} days</span></td>
        <td>${pct(i.t / e.grainDemand)}</td><td>${dc(i.delivered)}</td></tr>`;
      drawRoute(i.tree, e.nodeId, ECO.commodities.grain.color, 1.5 + 5 * Math.sqrt(i.t / e.grainDemand));
    });
    if (g.unmet > 0.001) html += `<tr class="bad"><td>UNMET</td><td>${pct(g.unmet / e.grainDemand)}</td><td>—</td></tr>`;
    return html + `</table>`;
  }

  function showCity(c) {
    const p = RESULT.provinces[c.province];
    const g = c.grain;
    const grainEdict = ECO.commodities.grain.edict;
    const names = [c.alt, c.modern].filter(Boolean).join(" · ");
    let html = `<h2>${c.name}</h2>
      <div class="sub">${p.name} — <b>${people(c.pop)}</b> people${c.wealth > 1 ? ` — wealth ×${c.wealth}` : ""}${names ? `<br>${names}` : ""}${c.civic ? `<br>${c.civic.join(", ")}` : ""}</div>
      <div class="sub popsrc">${popLine(c)}</div>`;
    if (c.note) html += `<p class="note">${c.note}</p>`;

    html += `<h3>Where its food comes from</h3>
      <div class="sub">needs ${kt(c.grainDemand)} grain/yr — avg price <b>${g.price ? dc(g.price) : "—"}</b> d.c./kg (Edict: ${grainEdict})</div>` + grainTable(c, true);

    const outbound = RESULT.sources.filter(s => s.nodeId === c.nodeId && s.shipped > 0.001);
    const gw = Object.values(RESULT.provinces).find(pp => pp.gatewayNode === c.nodeId);
    if (outbound.length || (gw && gw.exported > 0.01)) {
      html += `<h3>What it exports</h3><table class="tbl">`;
      if (gw && gw.exported > 0.01) html += `<tr><td>grain (${gw.name})</td><td colspan=2>${kt(gw.exported)}/yr</td></tr>`;
      outbound.forEach(s => {
        html += `<tr><td>${ECO.commodities[s.commodity].name}<span class="via">${s.label}</span></td><td colspan=2>${kt(s.shipped)}/yr</td></tr>`;
      });
      html += `</table>`;
    }

    const w = c.wage;
    html += `<h3>What a labourer's wage buys here</h3>
      <div class="sub">Edict wage 25 d.c./day + food allowance worth ${dc(w.income / 250 - 25)} → <b>${fmt(w.income)}</b> d.c./yr. A family's bare-bones year costs <b>${fmt(w.family)}</b>: welfare ratio <b class="${w.ratio < 1 ? "bad" : ""}">${w.ratio.toFixed(2)}</b> (Allen, at Edict prices: ${RESULT.wages.edictRatio.toFixed(2)})</div>
      <table class="tbl"><tr><th>basket, per adult</th><th>price</th><th>d.c./yr</th></tr>` +
      w.lines.map(l => `<tr><td>${l.item} <span class="via">${l.qty} ${l.unit}</span></td><td class="${l.local > l.price * 1.15 ? "bad" : l.local < l.price * 0.9 ? "good" : ""}">${dc(l.local)}</td><td>${fmt(l.cost)}</td></tr>`).join("") +
      `</table>`;

    html += `<h3>Market prices here <span class="via">d.c./kg, vs Edict</span></h3><table class="tbl">`;
    Object.entries(c.goods).forEach(([cid, gd]) => {
      const com = ECO.commodities[cid];
      const rel = gd.price / com.edict;
      html += `<tr><td><i class="dot" style="background:${com.color}"></i>${com.name}</td>
        <td>${dc(gd.price)}</td>
        <td class="${rel > 1.25 ? "bad" : rel < 0.95 ? "good" : ""}">${Math.round(rel * 100)}%</td></tr>`;
    });
    html += `</table>
      <div class="hint">Click elsewhere on the map to close. Prices = origin price + freight along the cheapest route by road, river and sea.</div>`;
    $("#detail").innerHTML = html;
  }

  function showGarrison(g) {
    const p = RESULT.provinces[g.province], A = ECO.army, F = RESULT.fiscal.provinces[g.province];
    const cost = g.men * A.costKg[g.kind] * RESULT.fx.armyCostMult / 1e6;
    let html = `<h2><i class="sq" style="background:${KIND_COLOR[g.kind]}"></i>${g.name}</h2>
      <div class="sub">${g.unit} — <b>${fmt(g.men)}</b> men — ${p.name}</div>`;
    if (g.note) html += `<p class="note">${g.note}</p>`;
    html += `<h3>What it costs</h3>
      <div class="sub">≈ <b>${kt(cost)}</b> of wheat-equivalent a year in pay, rations and kit (${fmt(A.costKg[g.kind] * RESULT.fx.armyCostMult)} kg a man) — ${pct(cost / F.tax)} of everything ${p.name} pays in tax.</div>`;
    if (!g.fed) {
      html += `<p class="note">Counted in Rome's population: fed from the city's own grain supply.</p>`;
    } else {
      html += `<h3>Its grain</h3>
        <div class="sub">${kt(g.grainDemand)} a year (${A.grainKgPerSoldier} kg a man) — ${g.grain.price ? `<b>${dc(g.grain.price)}</b> d.c./kg` : ""}</div>` + grainTable(g, true);
      const goods = Object.entries(g.goods).filter(([, gd]) => gd.alloc.length).sort((a, b) => b[1].demand - a[1].demand).slice(0, 6);
      html += `<h3>What its pay buys</h3><table class="tbl"><tr><th>good</th><th>t/yr</th><th>from</th></tr>`;
      goods.forEach(([cid, gd]) => {
        const com = ECO.commodities[cid];
        const top = [...gd.alloc].sort((a, b) => b.t - a.t).slice(0, 2).map(a => `${a.source.label} ${pct(a.t / gd.demand)}`).join(", ");
        html += `<tr><td><i class="dot" style="background:${com.color}"></i>${com.name}</td><td>${fmt(gd.demand * 1000)}</td><td class="left">${top}</td></tr>`;
        const best = [...gd.alloc].sort((a, b) => b.t - a.t)[0];
        if (best && best.source.nodeId !== g.nodeId) {
          const tree = Engine.tree(best.source.nodeId);
          drawRoute(tree, g.nodeId, com.color, 2.5);
        }
      });
      html += `</table>`;
    }
    html += `<div class="hint">Soldiers are paid well by provincial standards (wealth ×${A.wealth}) — which is how Spanish oil jars reach the Rhine.</div>`;
    $("#detail").innerHTML = html;
  }

  function showSource(s) {
    const com = ECO.commodities[s.commodity];
    let html = `<h2><i class="dot" style="background:${com.color}"></i>${s.label}</h2>
      <div class="sub">${com.name} — ships ${kt(s.shipped)}/yr — FOB ${dc(s.fobEff)} d.c./kg</div>`;
    if (s.note) html += `<p class="note">${s.note}</p>`;
    html += `<p class="note">${com.blurb}</p>`;
    const dests = [...s.destinations].sort((a, b) => b.t - a.t);
    html += `<h3>Where it goes</h3><table class="tbl"><tr><th>to</th><th>t/yr</th><th>delivered</th></tr>`;
    dests.slice(0, 14).forEach(d => {
      html += `<tr><td>${d.to.name}${d.to.kind !== "city" ? ' <span class="via">garrison</span>' : ""}</td><td>${fmt(d.t * 1000)}</td><td>${dc(d.delivered)}</td></tr>`;
    });
    html += `</table><div class="hint">Top ${Math.min(14, dests.length)} of ${dests.length} destinations; routes to the top 40 drawn on the map.</div>`;
    $("#detail").innerHTML = html;
    const tree = Engine.tree(s.nodeId);
    const max = Math.max(...dests.map(d => d.t), 1e-9);
    dests.slice(0, 40).forEach(d => drawRoute(tree, d.to.nodeId, com.color, 1 + 4.5 * Math.sqrt(d.t / max)));
  }

  function showProvince(pid) {
    const F = RESULT.fiscal, p = F.provinces[pid];
    const row = (a, b, cls) => `<tr class="${cls || ""}"><td>${a}</td><td>${b}</td></tr>`;
    let html = `<h2>${p.name}</h2>
      <div class="sub">${people(p.pop)} people — output ≈ <b>${kt(p.gdp)}</b> of wheat-equivalent a year${p.soldiers ? ` — ${fmt(p.soldiers)} soldiers` : ""}</div>`;
    html += `<h3>The state's account <span class="via">kt wheat-equivalent / yr</span></h3><table class="tbl two">` +
      row(`Taxes paid (${fmt1(100 * p.tax / p.gdp)}% of output)`, fmt(p.tax)) +
      row(`&nbsp;&nbsp;of which in grain (annona, army supply)`, fmt(p.inKindPaid)) +
      row(`State spending here`, fmt(p.spending)) +
      (p.army ? row(`&nbsp;&nbsp;the army`, fmt(p.army)) : "") +
      (p.rome ? row(`&nbsp;&nbsp;court, largesse, building in Rome`, fmt(p.rome)) : "") +
      (p.annona ? row(`&nbsp;&nbsp;the annona`, fmt(p.annona)) : "") +
      row(`&nbsp;&nbsp;provincial government`, fmt(p.admin)) +
      row(p.net >= 0 ? `<b>Net: pays in</b>` : `<b>Net: is paid</b>`, `<b>${fmt(Math.abs(p.net))}</b>`, p.net >= 0 ? "" : "good") +
      `</table>`;
    const need = p.coinOut;
    html += `<h3>Hopkins' test</h3><table class="tbl two">` +
      row(`Coin that leaves as tax and isn't spent back`, need >= 0 ? fmt(need) : `−${fmt(-need)}`) +
      row(`Exports to other provinces (model)`, fmt(p.exports)) +
      row(`Imports from other provinces (model)`, fmt(p.imports)) +
      row(`<b>Trade balance</b>`, `<b>${p.trade >= 0 ? "+" : "−"}${fmt(Math.abs(p.trade))}</b>`) + `</table>`;
    const gap = p.trade - need;
    html += `<p class="note">${need > 0
      ? `${p.name} sends more coin to the state than comes back to it, so on Hopkins' argument it must sell ${kt(need)} a year more than it buys. ${gap >= 0 ? `The model's market does that, with ${kt(gap)} to spare.` : `The model's market falls ${kt(-gap)} short — the coin would have to come from somewhere else: rents to absentee landlords, debt, or a drain of money that deflates prices.`}`
      : `The state spends ${kt(-need)} more coin here than it collects, so ${p.name} can buy more than it sells. ${p.trade <= 0 ? `The model's market does run a deficit of ${kt(-p.trade)}.` : `Yet the model's market still has it exporting on balance.`}`}</p>`;
    html += `<div class="hint">Output ≈ ${F.gdp ? fmt(ECO.fiscal.gdpKgPerCapita) : ""} kg of wheat-equivalent a head (Scheidel &amp; Friesen), shared by population with towns weighted by wealth. Values in wheat at the Edict price.</div>`;
    $("#detail").innerHTML = html;
  }

  window.APP = { get result() { return RESULT; }, recompute, select, timing };
})();
