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

  let ECO, RESULT, map;
  let view = "food";            // food | production | trade
  let comFilter = "all";        // commodity id or "all"
  const shocks = new Set();
  let selected = null;          // {kind:"city"|"source", ...}

  let landLayer, flowLayer, cityLayer, sourceLayer, highlightLayer;

  const STATUS_COLOR = { local: "#7cb56b", fed: "#5b9bd5", strained: "#e0a63c", famine: "#d1493f" };
  const MODE_DASH = { sea: null, road: "6 5", river: "2 6" };

  // ---------- boot ----------
  Promise.all(["data/network.json", "data/economy.json", "data/med_land.json"].map(u =>
    fetch(u).then(r => r.json())
  )).then(([net, eco, land]) => {
    ECO = eco;
    Graph.init(net);
    Engine.init(eco);
    buildMap(land);
    buildSidebar();
    recompute();
  });

  function buildMap(land) {
    map = L.map("map", {
      zoomControl: true, attributionControl: false,
      minZoom: 4, maxZoom: 9, zoomSnap: 0.5,
    }).setView([38.5, 18], 5);
    ["flows", "cities", "sources", "highlight"].forEach((name, i) => {
      map.createPane(name).style.zIndex = 410 + i * 10;
    });
    landLayer = L.geoJSON(land, {
      style: { fillColor: "#232f38", fillOpacity: 1, color: "#41586a", weight: 1 },
      interactive: false,
    }).addTo(map);
    flowLayer = L.layerGroup().addTo(map);
    sourceLayer = L.layerGroup().addTo(map);
    cityLayer = L.layerGroup().addTo(map);
    highlightLayer = L.layerGroup().addTo(map);
    map.on("click", () => { select(null); });
  }

  // ---------- sidebar ----------
  function buildSidebar() {
    const vr = $("#viewRadios");
    [["food", "Food & population"], ["production", "Production"], ["trade", "Trade flows"]].forEach(([id, label]) => {
      const l = el("label", "radio");
      l.innerHTML = `<input type="radio" name="view" value="${id}" ${id === view ? "checked" : ""}> ${label}`;
      l.querySelector("input").addEventListener("change", () => { view = id; select(null); render(); });
      vr.appendChild(l);
    });

    const cf = $("#comFilter");
    cf.appendChild(new Option("All commodities", "all"));
    Object.entries(ECO.commodities).forEach(([cid, c]) => cf.appendChild(new Option(c.name, cid)));
    cf.addEventListener("change", () => { comFilter = cf.value; select(null); render(); });

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

    const ed = $("#edictBody");
    ECO.edictSampler.forEach(r => {
      ed.appendChild(el("div", "edictRow", `<span>${r.item}</span><b>${r.price}</b>`));
    });
    $("#edictToggle").addEventListener("click", () => $("#edictBody").classList.toggle("open"));
    $("#aboutToggle").addEventListener("click", () => $("#aboutBody").classList.toggle("open"));
  }

  function recompute() {
    RESULT = Engine.compute({ shocks });
    renderTotals();
    render();
    if (selected) reselect();
  }

  function renderTotals() {
    const t = RESULT.totals;
    $("#totals").innerHTML =
      `<div><b>${fmt1(t.pop / 1000)} M</b><span>people</span></div>` +
      `<div><b>${fmt1(t.urban / 1000)} M</b><span>in ${RESULT.cities.length} cities</span></div>` +
      `<div><b>${fmt(t.grainTraded)} kt</b><span>grain shipped/yr</span></div>` +
      `<div class="${t.famines ? "bad" : ""}"><b>${t.famines}</b><span>cities in famine</span></div>`;
  }

  // ---------- rendering ----------
  function render() {
    flowLayer.clearLayers(); cityLayer.clearLayers(); sourceLayer.clearLayers();
    if (!selected) highlightLayer.clearLayers();
    renderFlows();
    if (view === "production") renderSources();
    renderCities();
    renderLegend();
  }

  function flowsToDraw() {
    const out = [];
    RESULT.edgeAgg.forEach(e => {
      let t, color;
      if (view === "food") {
        t = e.byCom.grain || 0; color = ECO.commodities.grain.color;
      } else if (comFilter !== "all") {
        t = e.byCom[comFilter] || 0; color = ECO.commodities[comFilter].color;
      } else {
        t = e.total;
        // dominant commodity colours the edge
        let best = null, bt = 0;
        Object.entries(e.byCom).forEach(([cid, v]) => { if (v > bt) { bt = v; best = cid; } });
        color = best ? ECO.commodities[best].color : "#888";
      }
      if (t > 0.01) out.push({ e, t, color });
    });
    return out;
  }

  function renderFlows() {
    if (view === "production" && comFilter === "all") return; // sources view shows all markers; flows only when filtered
    const fl = flowsToDraw();
    if (!fl.length) return;
    const max = Math.max(...fl.map(f => f.t));
    fl.forEach(({ e, t, color }) => {
      const w = 0.6 + 5.5 * Math.sqrt(t / max);
      L.polyline(e.latlngs, {
        pane: "flows", color, weight: w, opacity: 0.55,
        interactive: false,
      }).addTo(flowLayer);
    });
  }

  function renderCities() {
    RESULT.cities.forEach(c => {
      const n = Graph.node(c.nodeId);
      const r = 2.2 + 2.6 * Math.sqrt(c.pop / 10);
      let color = "#c9b98a", fill = "#8f8465";
      if (view === "food") {
        fill = STATUS_COLOR[c.grain.status]; color = "#0e161c";
      } else if (view === "trade") {
        fill = "#c9b98a"; color = "#0e161c";
      }
      const m = L.circleMarker([n.lat, n.lon], {
        pane: "cities", radius: r, fillColor: fill, fillOpacity: 0.9,
        color, weight: 1,
      }).addTo(cityLayer);
      m.bindTooltip(`<b>${c.orbis}</b> — ${fmt(c.pop * 1000)} people`, { direction: "top", opacity: 0.95 });
      m.on("click", ev => { L.DomEvent.stopPropagation(ev); select({ kind: "city", city: c }); });
      if (c.pop >= 60) {
        L.tooltip({ permanent: true, direction: "right", className: "cityLabel", offset: [r, 0] })
          .setContent(c.orbis).setLatLng([n.lat, n.lon]).addTo(cityLayer);
      }
    });
  }

  function renderSources() {
    RESULT.sources.forEach(s => {
      if (comFilter !== "all" && s.commodity !== comFilter) return;
      const n = Graph.node(s.nodeId);
      const com = ECO.commodities[s.commodity];
      const m = L.circleMarker([n.lat, n.lon], {
        pane: "sources", radius: 7, fillColor: com.color, fillOpacity: 0.95,
        color: "#0e161c", weight: 1.5,
      }).addTo(sourceLayer);
      m.bindTooltip(`<b>${s.label}</b><br>${com.name} — ships ${kt(s.shipped)}/yr`, { direction: "top", opacity: 0.95 });
      m.on("click", ev => { L.DomEvent.stopPropagation(ev); select({ kind: "source", source: s }); });
    });
  }

  function renderLegend() {
    const lg = $("#legend");
    if (view === "food") {
      lg.innerHTML = "<b>Grain supply</b>" +
        [["local", "fed by own hinterland"], ["fed", "fed by imports"], ["strained", "strained"], ["famine", "famine"]]
          .map(([k, t]) => `<span><i style="background:${STATUS_COLOR[k]}"></i>${t}</span>`).join("") +
        `<span class="hint">gold lines: grain shipments; circle size = population; click a city</span>`;
    } else if (view === "production") {
      lg.innerHTML = "<b>Production</b><span class='hint'>dots are production sources — pick a commodity above, click a source to see where it ships</span>";
    } else {
      const coms = comFilter === "all" ? Object.entries(ECO.commodities).slice(0, 10) : [[comFilter, ECO.commodities[comFilter]]];
      lg.innerHTML = "<b>Trade flows</b>" +
        (comFilter === "all"
          ? "<span class='hint'>edges coloured by dominant cargo; width = tonnage; click a city for its trade profile</span>"
          : coms.map(([cid, c]) => `<span><i style="background:${c.color}"></i>${c.name}</span>`).join(""));
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
    else showSource(sel.source);
  }
  function reselect() {
    if (!selected) return;
    if (selected.kind === "city") {
      const c = RESULT.cities.find(x => x.orbis === selected.city.orbis);
      select(c ? { kind: "city", city: c } : null);
    } else {
      const s = RESULT.sources.find(x => x.label === selected.source.label);
      select(s ? { kind: "source", source: s } : null);
    }
  }

  function drawPath(path, color, weight) {
    if (!path || path.length < 2) return;
    L.polyline(Graph.pathLatLngs(path), {
      pane: "highlight", color, weight: weight || 3, opacity: 0.9,
    }).addTo(highlightLayer);
  }

  function showCity(c) {
    const p = RESULT.provinces[c.province];
    const g = c.grain;
    const grainEdict = ECO.commodities.grain.edict;
    let html = `<h2>${c.orbis}</h2>
      <div class="sub">${p.name} — ${fmt(c.pop * 1000)} people${c.wealth > 1 ? ` — wealth ×${c.wealth}` : ""}</div>`;
    if (c.note) html += `<p class="note">${c.note}</p>`;

    // food
    html += `<h3>Where its food comes from</h3>
      <div class="sub">needs ${kt(c.grainDemand)} grain/yr — avg price <b>${g.price ? dc(g.price) : "—"}</b> d.c./kg (Edict: ${grainEdict})</div>
      <table class="tbl"><tr><th>source</th><th>share</th><th>price</th></tr>`;
    if (g.local > 0.01) {
      html += `<tr><td>${p.name} hinterland</td><td>${Math.round(100 * g.local / c.grainDemand)}%</td><td>${dc(g.localPrice)}</td></tr>`;
    }
    g.imports.filter(i => i.t / c.grainDemand >= 0.005).forEach(i => {
      html += `<tr><td>${i.from.name}${i.annona ? ' <b class="annona">annona</b>' : ""} <span class="via">via ${Graph.node(i.gatewayNode).label}, ${Math.round(i.days)}d</span></td>
        <td>${Math.round(100 * i.t / c.grainDemand)}%</td><td>${dc(i.delivered)}</td></tr>`;
      drawPath(i.path, ECO.commodities.grain.color, 1.5 + 5 * Math.sqrt(i.t / c.grainDemand));
    });
    if (g.unmet > 0.01) {
      html += `<tr class="bad"><td>UNMET</td><td>${Math.round(100 * g.unmet / c.grainDemand)}%</td><td>—</td></tr>`;
    }
    html += `</table>`;

    // exports from here
    const outbound = RESULT.sources.filter(s => s.nodeId === c.nodeId && s.shipped > 0.001);
    const gw = Object.values(RESULT.provinces).find(pp => pp.gateway === c.orbis);
    if (outbound.length || (gw && gw.exported > 0.01)) {
      html += `<h3>What it exports</h3><table class="tbl">`;
      if (gw && gw.exported > 0.01) html += `<tr><td>grain (${gw.name})</td><td colspan=2>${kt(gw.exported)}/yr</td></tr>`;
      outbound.forEach(s => {
        html += `<tr><td>${ECO.commodities[s.commodity].name}<span class="via">${s.label}</span></td><td colspan=2>${kt(s.shipped)}/yr</td></tr>`;
      });
      html += `</table>`;
    }

    // market prices here
    html += `<h3>Market prices here <span class="via">d.c./kg, vs Edict</span></h3><table class="tbl">`;
    Object.entries(c.goods).forEach(([cid, gd]) => {
      const com = ECO.commodities[cid];
      const rel = gd.price / com.edict;
      html += `<tr><td><i class="dot" style="background:${com.color}"></i>${com.name}</td>
        <td>${dc(gd.price)}</td>
        <td class="${rel > 1.25 ? "bad" : rel < 0.95 ? "good" : ""}">${Math.round(rel * 100)}%</td></tr>`;
    });
    html += `</table>
      <div class="hint">Click elsewhere on the map to close. Prices = origin price + real freight along the cheapest ORBIS route.</div>`;
    $("#detail").innerHTML = html;
  }

  function showSource(s) {
    const com = ECO.commodities[s.commodity];
    const n = Graph.node(s.nodeId);
    let html = `<h2><i class="dot" style="background:${com.color}"></i>${s.label}</h2>
      <div class="sub">${com.name} — at ${s.orbis} — ships ${kt(s.shipped)}/yr — FOB ${dc(s.fobEff)} d.c./kg</div>`;
    if (s.note) html += `<p class="note">${s.note}</p>`;
    html += `<p class="note">${com.blurb}</p>`;
    const dests = [...s.destinations].sort((a, b) => b.t - a.t).slice(0, 14);
    html += `<h3>Where it goes</h3><table class="tbl"><tr><th>city</th><th>t/yr</th><th>delivered</th></tr>`;
    dests.forEach(d => {
      html += `<tr><td>${d.city.orbis}</td><td>${fmt(d.t * 1000)}</td><td>${dc(d.delivered)}</td></tr>`;
    });
    html += `</table><div class="hint">Showing top ${dests.length} of ${s.destinations.length} destinations; routes drawn on the map.</div>`;
    $("#detail").innerHTML = html;
    // draw top flows
    const flows = (RESULT.comFlows[s.commodity] || []).filter(f => f.from === s.nodeId);
    const max = Math.max(...flows.map(f => f.t), 1e-9);
    flows.sort((a, b) => b.t - a.t).slice(0, 40).forEach(f =>
      drawPath(f.path, com.color, 1 + 4.5 * Math.sqrt(f.t / max)));
  }

  window.APP = { get result() { return RESULT; }, recompute, select };
})();
