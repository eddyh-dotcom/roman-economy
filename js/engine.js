// engine.js — the economic model.
//
// Grain: cities eat their province's rural surplus first (at the local price),
// then buy the rest on the empire-wide market from exporting provinces'
// gateways, cheapest delivered price first, until gateway pools run dry.
// Delivered price = FOB at the gateway + ORBIS freight along the cheapest
// path (both in denarii per kg, the Price Edict's own unit).
//
// Other commodities: each city splits its demand among the cheapest few
// sources — weighted steeply toward the cheapest — so heavy cheap goods
// (timber, marble) stay local while luxuries flow empire-wide from one or
// two origins. All tonnages are routed over the network and aggregated
// per edge for the flow map.
(function () {
  "use strict";

  const Engine = {};
  let ECO = null;

  Engine.init = function (eco) { ECO = eco; };

  const CLASS_FACTOR = {
    staple: (pop, w) => pop,
    comfort: (pop, w) => pop * w,
    luxury: (pop, w) => (pop >= 25 ? pop * w * w : 0),
  };

  // settings: { shocks: Set<string> }
  Engine.compute = function (settings) {
    const t0 = performance.now();
    const shocksOn = settings.shocks || new Set();

    // ---- fold active shock effects together ----
    const fx = {
      provinceSurplusMult: {}, provinceFobMult: {}, sourceFobMult: {},
      seaCostMult: 1, seaDaysMult: 1, popMult: 1, openSeaClosed: false,
    };
    ECO.shocks.filter(s => shocksOn.has(s.id)).forEach(s => {
      const e = s.effects;
      Object.entries(e.provinceSurplusMult || {}).forEach(([k, v]) =>
        fx.provinceSurplusMult[k] = (fx.provinceSurplusMult[k] || 1) * v);
      Object.entries(e.provinceFobMult || {}).forEach(([k, v]) =>
        fx.provinceFobMult[k] = (fx.provinceFobMult[k] || 1) * v);
      Object.entries(e.sourceFobMult || {}).forEach(([k, v]) =>
        fx.sourceFobMult[k] = (fx.sourceFobMult[k] || 1) * v);
      if (e.seaCostMult) fx.seaCostMult *= e.seaCostMult;
      if (e.seaDaysMult) fx.seaDaysMult *= e.seaDaysMult;
      if (e.popMult) fx.popMult *= e.popMult;
      if (e.openSeaClosed) fx.openSeaClosed = true;
    });
    const mods = { seaCostMult: fx.seaCostMult, seaDaysMult: fx.seaDaysMult, openSeaClosed: fx.openSeaClosed };

    // ---- cities & provinces ----
    const kgPC = ECO.meta.grainKgPerCapita;
    const cities = ECO.cities.map(c => ({
      ...c,
      nodeId: Graph.idFor(c.orbis),
      pop: c.pop * fx.popMult,               // thousands
      wealth: c.wealth || 1,
    }));
    const cityByNode = new Map(cities.map(c => [c.nodeId, c]));

    const provinces = {};
    Object.entries(ECO.provinces).forEach(([pid, p]) => {
      const sm = fx.provinceSurplusMult[pid] || 1;
      const fm = fx.provinceFobMult[pid] || 1;
      provinces[pid] = {
        id: pid, ...p,
        pool: p.ruralPop * fx.popMult * p.surplus * sm / 1000, // thousand tonnes
        fob: p.grainFob * fm,
        cities: [],
      };
    });
    cities.forEach(c => provinces[c.province].cities.push(c));

    // ---- grain: local draw ----
    cities.forEach(c => {
      c.grainDemand = c.pop * kgPC / 1000;   // thousand tonnes (pop is thousands)
      c.grain = { local: 0, imports: [], unmet: 0 };
    });
    Object.values(provinces).forEach(p => {
      const cityDemand = p.cities.reduce((s, c) => s + c.grainDemand, 0);
      const ratio = cityDemand > 0 ? Math.min(1, p.pool / cityDemand) : 0;
      p.cities.forEach(c => {
        c.grain.local = c.grainDemand * ratio;
        c.grain.localPrice = p.fob + ECO.meta.localHaulCost;
      });
      p.localUse = cityDemand * ratio;
      p.exportable = Math.max(0, p.pool - p.localUse);
      // provinces without a declared sea gateway still sell regional surplus
      // through their largest city — road freight prices it out beyond a
      // short range on its own
      if (!p.gateway && p.cities.length && p.exportable > 0) {
        p.gateway = p.cities.reduce((a, b) => a.pop > b.pop ? a : b).orbis;
        p.impliedGateway = true;
      }
    });

    // ---- grain: import market (capacitated, cheapest first) ----
    const gateways = Object.values(provinces)
      .filter(p => p.gateway && p.exportable > 0.05)
      .map(p => ({
        prov: p, nodeId: Graph.idFor(p.gateway),
        remaining: p.exportable,
        sp: Graph.shortestFrom(Graph.idFor(p.gateway), mods),
      }));

    const grainFlows = [];  // {from nodeId, to nodeId, t (thousand tonnes), path}
    const shipTo = (c, g, take, delivered) => {
      c.grain.imports.push({
        from: g.prov, gatewayNode: g.nodeId, t: take, delivered,
        days: g.sp.days.get(c.nodeId),
        path: Graph.path(g.sp.prev, g.nodeId, c.nodeId),
        annona: !!c._annona,
      });
      grainFlows.push({ from: g.nodeId, to: c.nodeId, t: take, path: c.grain.imports[c.grain.imports.length - 1].path });
    };

    // the annona: Rome's unmet demand has first claim on the African and
    // Egyptian tax grain (historically ~2/3 Africa, ~1/3 Egypt) before the
    // open market sees it
    const roma = cities.find(c => c.orbis === "Roma");
    if (roma) {
      roma._need = roma.grainDemand - roma.grain.local;
      roma._annona = true;
      [["africa", 0.67], ["aegyptus", 1.0]].forEach(([pid, shareOfNeed]) => {
        const g = gateways.find(x => x.prov.id === pid);
        if (!g || roma._need <= 1e-6) return;
        const d = g.sp.dist.get(roma.nodeId);
        if (d === undefined) return;
        const take = Math.min(roma._need * shareOfNeed, g.remaining);
        if (take <= 1e-6) return;
        roma._need -= take; g.remaining -= take;
        shipTo(roma, g, take, g.prov.fob + d);
      });
      roma._annona = false;
    }

    // nobody pays more than ~4.5x the Edict for grain: past that a city is
    // in famine, not in the market (freight has priced food out of reach)
    const PRICE_CEILING = 45;
    const offers = [];
    cities.forEach(c => {
      const already = c.grain.imports.reduce((s, i) => s + i.t, 0);
      c._need = c.grainDemand - c.grain.local - already;
      if (c._need <= 1e-6) return;
      gateways.forEach(g => {
        const d = g.sp.dist.get(c.nodeId);
        if (d === undefined) return;
        const delivered = g.prov.fob + d;
        if (delivered <= PRICE_CEILING) offers.push({ c, g, delivered });
      });
    });
    offers.sort((a, b) => a.delivered - b.delivered);
    offers.forEach(o => {
      if (o.c._need <= 1e-6 || o.g.remaining <= 1e-6) return;
      const take = Math.min(o.c._need, o.g.remaining);
      o.c._need -= take; o.g.remaining -= take;
      shipTo(o.c, o.g, take, o.delivered);
    });
    gateways.forEach(g => { g.prov.exported = g.prov.exportable - g.remaining; });

    cities.forEach(c => {
      c.grain.unmet = Math.max(0, c._need);
      const parts = [[c.grain.local, c.grain.localPrice || 0], ...c.grain.imports.map(i => [i.t, i.delivered])];
      const got = parts.reduce((s, p) => s + p[0], 0);
      c.grain.price = got > 0 ? parts.reduce((s, p) => s + p[0] * p[1], 0) / got : null;
      const unmetShare = c.grainDemand > 0 ? c.grain.unmet / c.grainDemand : 0;
      c.grain.status = unmetShare > 0.10 ? "famine"
        : (unmetShare > 0.01 || (c.grain.price && c.grain.price > 1.6 * ECO.commodities.grain.edict)) ? "strained"
        : (c.grain.local / c.grainDemand > 0.85 ? "local" : "fed");
      delete c._need;
    });

    // ---- other commodities ----
    const sources = ECO.sources.map(s => ({
      ...s,
      nodeId: Graph.idFor(s.orbis),
      fobEff: s.fob * (fx.sourceFobMult[s.commodity] || 1),
      shipped: 0, destinations: [],
    }));
    const srcByCommodity = {};
    sources.forEach(s => (srcByCommodity[s.commodity] = srcByCommodity[s.commodity] || []).push(s));
    const spCache = new Map();
    const spFor = s => {
      if (!spCache.has(s.nodeId)) spCache.set(s.nodeId, Graph.shortestFrom(s.nodeId, mods));
      return spCache.get(s.nodeId);
    };

    const comFlows = {};   // commodity -> [{from,to,t,path,delivered}]
    cities.forEach(c => { c.goods = {}; });

    Object.entries(ECO.commodities).forEach(([cid, com]) => {
      if (cid === "grain") return;
      const srcs = srcByCommodity[cid] || [];
      if (!srcs.length) return;
      comFlows[cid] = [];
      cities.forEach(c => {
        const eff = CLASS_FACTOR[com.class](c.pop, c.wealth);
        const demand = eff * 1000 * com.perCapita / 1e6; // thousand tonnes
        if (demand <= 0) return;
        const opts = srcs.map(s => {
          const d = spFor(s).dist.get(c.nodeId);
          return d === undefined ? null : { s, delivered: s.fobEff + d };
        }).filter(Boolean);
        if (!opts.length) return;
        const min = Math.min(...opts.map(o => o.delivered));
        // steeply prefer the cheapest; ignore anything >60% dearer
        let ws = opts.map(o => o.delivered <= min * 1.6
          ? o.s.share * Math.pow(min / o.delivered, 6) : 0);
        const tot = ws.reduce((a, b) => a + b, 0);
        const alloc = [];
        opts.forEach((o, i) => {
          if (ws[i] <= 0) return;
          const t = demand * ws[i] / tot;
          alloc.push({ source: o.s, t, delivered: o.delivered });
          o.s.shipped += t;
          if (t > 1e-9) {
            o.s.destinations.push({ city: c, t, delivered: o.delivered });
            if (o.s.nodeId !== c.nodeId) comFlows[cid].push({
              from: o.s.nodeId, to: c.nodeId, t, delivered: o.delivered,
              path: Graph.path(spFor(o.s).prev, o.s.nodeId, c.nodeId),
            });
          }
        });
        const price = alloc.reduce((s, a) => s + a.t * a.delivered, 0) / demand;
        c.goods[cid] = { demand, alloc, price };
      });
    });

    // ---- aggregate flows onto edges for the map ----
    // edge key "a|b" undirected; value: {latlngs, total, byCom:{cid:t}}
    const edgeAgg = new Map();
    const addPath = (path, t, cid) => {
      if (!path) return;
      for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i], b = path[i + 1];
        const key = a < b ? a + "|" + b : b + "|" + a;
        let e = edgeAgg.get(key);
        if (!e) {
          const na = Graph.node(a), nb = Graph.node(b);
          e = { a, b, latlngs: [[na.lat, na.lon], [nb.lat, nb.lon]], total: 0, byCom: {} };
          edgeAgg.set(key, e);
        }
        e.total += t;
        e.byCom[cid] = (e.byCom[cid] || 0) + t;
      }
    };
    grainFlows.forEach(f => addPath(f.path, f.t, "grain"));
    Object.entries(comFlows).forEach(([cid, fs]) => fs.forEach(f => addPath(f.path, f.t, cid)));

    const seaGrain = grainFlows.reduce((s, f) => s + f.t, 0);
    const famines = cities.filter(c => c.grain.status === "famine").length;
    const strained = cities.filter(c => c.grain.status === "strained").length;

    return {
      cities, provinces, sources, edgeAgg, comFlows, grainFlows, fx,
      totals: {
        pop: cities.reduce((s, c) => s + c.pop, 0) +
             Object.values(ECO.provinces).reduce((s, p) => s + p.ruralPop, 0) * fx.popMult,
        urban: cities.reduce((s, c) => s + c.pop, 0),
        grainTraded: seaGrain, famines, strained,
        ms: Math.round(performance.now() - t0),
      },
    };
  };

  window.Engine = Engine;
})();
