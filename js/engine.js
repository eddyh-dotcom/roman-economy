// engine.js — the economic model.
//
// Grain: the army eats first — each garrison takes its province's rural surplus,
// then the state ships the rest to it (the annona militaris). Rome's annona has
// first claim on African and Egyptian grain. Cities eat what is left of their
// province's surplus, then buy on the empire-wide market from exporting
// provinces' gateways, cheapest delivered price first, until gateway pools run
// dry. Delivered price = FOB at the gateway + freight along the cheapest path
// (both in denarii per kg, the Price Edict's own unit).
//
// Other commodities: each city and garrison splits its demand among the
// cheapest few sources — weighted steeply toward the cheapest — so heavy cheap
// goods (timber, marble) stay local while luxuries flow empire-wide from one or
// two origins. Tonnages are summed onto the network edge by edge.
//
// Then two readings of the result: what a labourer's Edict wage buys at each
// city's prices (Allen 2009), and who pays the state and who it pays (Hopkins'
// "taxes and trade").
(function () {
  "use strict";

  const Engine = {};
  let ECO = null, PL = null;

  // shortest-path trees depend only on the transport shocks, so keep them across
  // recomputes (for the current and the previous set of sea conditions)
  const treeCache = new Map();
  let currentMods = null;
  function treeFor(nodeId, mods) {
    const mk = `${mods.seaCostMult}|${mods.seaDaysMult}|${mods.openSeaClosed}`;
    let byNode = treeCache.get(mk);
    if (!byNode) {
      byNode = new Map();
      treeCache.set(mk, byNode);
      while (treeCache.size > 2) treeCache.delete(treeCache.keys().next().value);
    }
    if (!byNode.has(nodeId)) byNode.set(nodeId, Graph.shortestFrom(nodeId, mods));
    return byNode.get(nodeId);
  }
  // the cached tree from a node under the current conditions (for drawing routes)
  Engine.tree = nodeId => treeFor(nodeId, currentMods);

  Engine.init = function (eco, places) { ECO = eco; PL = places; };

  const CLASS_FACTOR = {
    staple: (pop, w) => pop,
    comfort: (pop, w) => pop * w,
    luxury: (pop, w) => (pop >= 25 ? pop * w * w : 0),
  };
  // bullion goes to the mints: the mines were imperial property, so silver and
  // gold are state revenue, not trade, in the provincial accounts
  const NOT_TRADE = new Set(["silver", "gold"]);

  // settings: { shocks: Set<string> }
  Engine.compute = function (settings) {
    const t0 = performance.now();
    const shocksOn = settings.shocks || new Set();

    // ---- fold active shock effects together ----
    const fx = {
      provinceSurplusMult: {}, provinceFobMult: {}, sourceFobMult: {}, garrisonMult: {},
      seaCostMult: 1, seaDaysMult: 1, popMult: 1, armyCostMult: 1, openSeaClosed: false,
    };
    ECO.shocks.filter(s => shocksOn.has(s.id)).forEach(s => {
      const e = s.effects;
      ["provinceSurplusMult", "provinceFobMult", "sourceFobMult", "garrisonMult"].forEach(key =>
        Object.entries(e[key] || {}).forEach(([k, v]) => fx[key][k] = (fx[key][k] || 1) * v));
      ["seaCostMult", "seaDaysMult", "popMult", "armyCostMult"].forEach(key => { if (e[key]) fx[key] *= e[key]; });
      if (e.openSeaClosed) fx.openSeaClosed = true;
    });
    const mods = { seaCostMult: fx.seaCostMult, seaDaysMult: fx.seaDaysMult, openSeaClosed: fx.openSeaClosed };
    currentMods = mods;

    // ---- cities, garrisons, provinces ----
    const kgPC = ECO.meta.grainKgPerCapita;
    const A = ECO.army;
    const cities = PL.cities.map(c => ({
      ...c, kind: "city", nodeId: c.node, pop: c.pop * fx.popMult, wealth: c.wealth || 1,
    }));
    const garrisons = PL.garrisons.map(g => {
      const men = g.men * (fx.garrisonMult[g.province] || 1);
      return { ...g, nodeId: g.node, men, pop: men / 1000, wealth: A.wealth,
               // the Rome garrison is already counted in the city's population
               fed: g.kind !== "guard" };
    });
    const eaters = [...cities, ...garrisons.filter(g => g.fed)];

    // the army's grain is a tax in kind levied across the empire: it is extra
    // grain squeezed from every province's peasants in proportion to their number
    const armyGrain = garrisons.reduce((s, g) => s + (g.fed ? g.men * A.grainKgPerSoldier / 1e6 : 0), 0);
    const ruralOf = pid => (PL.provinces[pid] ? PL.provinces[pid].ruralPop : ECO.provinces[pid].ruralPop) * fx.popMult;
    const ruralTotal = Object.keys(ECO.provinces).reduce((s, pid) => s + ruralOf(pid), 0);
    const provinces = {};
    Object.entries(ECO.provinces).forEach(([pid, p]) => {
      const sm = fx.provinceSurplusMult[pid] || 1;
      const rural = ruralOf(pid);
      const surplus = PL.provinces[pid] ? PL.provinces[pid].surplus : p.surplus;
      provinces[pid] = {
        id: pid, ...p, ruralPop: rural, surplus,
        levy: armyGrain * rural / ruralTotal,
        pool: (rural * surplus / 1000 + armyGrain * rural / ruralTotal) * sm,     // thousand tonnes
        fob: p.grainFob * (fx.provinceFobMult[pid] || 1),
        cities: [], garrisons: [], armyLocal: 0, localUse: 0,
      };
    });
    cities.forEach(c => provinces[c.province].cities.push(c));
    garrisons.forEach(g => provinces[g.province].garrisons.push(g));
    const localPrice = p => p.fob + ECO.meta.localHaulCost;

    // ---- grain demand ----
    cities.forEach(c => {
      c.grainDemand = c.pop * kgPC / 1000;                  // kt (pop is thousands)
      c.grain = { local: 0, imports: [], unmet: 0 };
    });
    garrisons.forEach(g => {
      g.grainDemand = g.fed ? g.men * A.grainKgPerSoldier / 1e6 : 0;
      g.grain = { local: 0, imports: [], unmet: 0 };
    });

    // 1. the army requisitions from its own province first
    Object.values(provinces).forEach(p => {
      const need = p.garrisons.reduce((s, g) => s + g.grainDemand, 0);
      if (need <= 0) return;
      const take = Math.min(need, p.pool);
      p.garrisons.forEach(g => { g.grain.local = g.grainDemand * take / need; g.grain.localPrice = localPrice(p); });
      p.armyLocal = take;
    });
    // 2. cities eat what is left of the provincial surplus
    Object.values(provinces).forEach(p => {
      const left = p.pool - p.armyLocal;
      const cityDemand = p.cities.reduce((s, c) => s + c.grainDemand, 0);
      const ratio = cityDemand > 0 ? Math.min(1, left / cityDemand) : 0;
      p.cities.forEach(c => { c.grain.local = c.grainDemand * ratio; c.grain.localPrice = localPrice(p); });
      p.localUse = cityDemand * ratio;
      p.exportable = Math.max(0, left - p.localUse);
      // provinces without a declared sea gateway still sell regional surplus
      // through their largest city — road freight prices it out beyond a
      // short range on its own
      if (!p.gateway && p.cities.length && p.exportable > 0) {
        p.gateway = p.cities.reduce((a, b) => a.pop > b.pop ? a : b).name;
        p.gatewayNode = p.cities.reduce((a, b) => a.pop > b.pop ? a : b).nodeId;
        p.impliedGateway = true;
      } else if (p.gateway) {
        p.gatewayNode = Graph.idFor(p.gateway);
      }
    });

    const gateways = Object.values(provinces)
      .filter(p => p.gatewayNode !== undefined && p.exportable > 0.05)
      .map(p => ({ prov: p, nodeId: p.gatewayNode, remaining: p.exportable, sp: treeFor(p.gatewayNode, mods) }));

    const grainLoads = new Map();   // gateway -> [[node index, tonnes, military?], ...]
    const ship = (e, g, take, delivered, kind) => {
      e.grain.imports.push({ from: g.prov, gatewayNode: g.nodeId, t: take, delivered, kind,
                             days: g.sp.daysTo(e.nodeId), tree: g.sp });
      if (!grainLoads.has(g)) grainLoads.set(g, []);
      grainLoads.get(g).push([Graph.index(e.nodeId), take, kind === "military"]);
      g.prov.shipped = (g.prov.shipped || { annona: 0, military: 0, market: 0 });
      g.prov.shipped[kind] += take;
    };
    const need = e => e.grainDemand - e.grain.local - e.grain.imports.reduce((s, i) => s + i.t, 0);

    // 3. the annona: Rome's unmet demand has first claim on the African and
    // Egyptian tax grain (historically ~2/3 Africa, ~1/3 Egypt)
    const roma = cities.find(c => c.orbis === "Roma");
    if (roma) {
      [["africa", 0.67], ["aegyptus", 1.0]].forEach(([pid, share]) => {
        const g = gateways.find(x => x.prov.id === pid);
        const n = need(roma);
        if (!g || n <= 1e-6) return;
        const d = g.sp.cost(roma.nodeId);
        if (d === undefined) return;
        const take = Math.min(n * share, g.remaining);
        if (take <= 1e-6) return;
        g.remaining -= take;
        ship(roma, g, take, g.prov.fob + d, "annona");
      });
    }

    // 4. the annona militaris: garrisons short of grain are supplied by the
    // state from the cheapest surplus anywhere, whatever the freight
    const milOffers = [];
    garrisons.forEach(g => {
      if (!g.fed || need(g) <= 1e-6) return;
      gateways.forEach(gw => {
        const d = gw.sp.cost(g.nodeId);
        if (d !== undefined) milOffers.push({ e: g, g: gw, delivered: gw.prov.fob + d });
      });
    });
    milOffers.sort((a, b) => a.delivered - b.delivered);
    milOffers.forEach(o => {
      const n = need(o.e);
      if (n <= 1e-6 || o.g.remaining <= 1e-6) return;
      const take = Math.min(n, o.g.remaining);
      o.g.remaining -= take;
      ship(o.e, o.g, take, o.delivered, "military");
    });

    // 5. the open market. Nobody pays more than ~4.5x the Edict for grain:
    // past that a city is in famine, not in the market
    const PRICE_CEILING = 45;
    const offers = [];
    cities.forEach(c => {
      if (need(c) <= 1e-6) return;
      gateways.forEach(g => {
        const d = g.sp.cost(c.nodeId);
        if (d === undefined) return;
        const delivered = g.prov.fob + d;
        if (delivered <= PRICE_CEILING) offers.push({ c, g, delivered });
      });
    });
    offers.sort((a, b) => a.delivered - b.delivered);
    offers.forEach(o => {
      const n = need(o.c);
      if (n <= 1e-6 || o.g.remaining <= 1e-6) return;
      const take = Math.min(n, o.g.remaining);
      o.g.remaining -= take;
      ship(o.c, o.g, take, o.delivered, "market");
    });
    gateways.forEach(g => { g.prov.exported = g.prov.exportable - g.remaining; });

    const grainEdict = ECO.commodities.grain.edict;
    eaters.forEach(e => {
      const g = e.grain;
      g.unmet = Math.max(0, need(e));
      const parts = [[g.local, g.localPrice || 0], ...g.imports.map(i => [i.t, i.delivered])];
      const got = parts.reduce((s, p) => s + p[0], 0);
      g.price = got > 0 ? parts.reduce((s, p) => s + p[0] * p[1], 0) / got : null;
      const unmetShare = e.grainDemand > 0 ? g.unmet / e.grainDemand : 0;
      g.status = unmetShare > 0.10 ? "famine"
        : (unmetShare > 0.01 || (g.price && g.price > 1.6 * grainEdict)) ? "strained"
        : (g.local / e.grainDemand > 0.85 ? "local" : "fed");
    });

    // ---- other commodities ----
    const sources = PL.sources.map(s => ({
      ...s, nodeId: s.node, fobEff: s.fob * (fx.sourceFobMult[s.commodity] || 1),
      shipped: 0, destinations: [], tree: treeFor(s.node, mods),
    }));
    const srcByCommodity = {};
    sources.forEach(s => (srcByCommodity[s.commodity] = srcByCommodity[s.commodity] || []).push(s));

    const comLoads = new Map();   // "cid|nodeId" -> {cid, tree, list: [[node index, tonnes, to a garrison?]]}
    eaters.forEach(e => { e.goods = {}; });
    Object.entries(ECO.commodities).forEach(([cid, com]) => {
      if (cid === "grain") return;
      const srcs = srcByCommodity[cid] || [];
      if (!srcs.length) return;
      eaters.forEach(e => {
        const eff = CLASS_FACTOR[com.class](e.pop, e.wealth);
        const demand = eff * 1000 * com.perCapita / 1e6;   // kt
        if (demand <= 0) return;
        const opts = [];
        srcs.forEach(s => {
          const d = s.tree.cost(e.nodeId);
          if (d !== undefined) opts.push({ s, delivered: s.fobEff + d });
        });
        if (!opts.length) return;
        const min = Math.min(...opts.map(o => o.delivered));
        // steeply prefer the cheapest; ignore anything >60% dearer
        const ws = opts.map(o => o.delivered <= min * 1.6 ? o.s.share * Math.pow(min / o.delivered, 6) : 0);
        const tot = ws.reduce((a, b) => a + b, 0);
        const alloc = [];
        opts.forEach((o, i) => {
          if (ws[i] <= 0) return;
          const t = demand * ws[i] / tot;
          alloc.push({ source: o.s, t, delivered: o.delivered });
          o.s.shipped += t;
          if (t > 1e-9) {
            o.s.destinations.push({ to: e, t, delivered: o.delivered });
            if (o.s.nodeId !== e.nodeId) {
              const key = cid + "|" + o.s.nodeId;
              if (!comLoads.has(key)) comLoads.set(key, { cid, tree: o.s.tree, list: [] });
              comLoads.get(key).list.push([Graph.index(e.nodeId), t, e.kind !== "city"]);
            }
          }
        });
        e.goods[cid] = { demand, alloc, price: alloc.reduce((s, a) => s + a.t * a.delivered, 0) / demand };
      });
    });

    // ---- sum flows onto edges: one Float64Array per cargo ----
    const E = Graph.edges().length;
    const edgeFlows = {};
    const flowsFor = key => edgeFlows[key] || (edgeFlows[key] = new Float64Array(E));
    // each list is summed twice up its tree: everything, and the garrison-bound part
    const sum = (tree, list, key, milKey) => {
      const all = flowsFor(key), mil = flowsFor(milKey);
      Graph.accumulate(tree, list, (k, t) => { all[k] += t; });
      const ml = list.filter(x => x[2]);
      if (ml.length) Graph.accumulate(tree, ml, (k, t) => { mil[k] += t; });
    };
    grainLoads.forEach((list, g) => sum(g.sp, list, "grain", "grain_mil"));
    comLoads.forEach(({ cid, tree, list }) => sum(tree, list, cid, "army:" + cid));

    const wages = computeWages(cities);
    const fiscal = computeFiscal({ cities, garrisons, provinces, sources, fx });

    const grainShipped = [...grainLoads.values()].reduce((s, list) => s + list.reduce((a, x) => a + x[1], 0), 0);
    const soldiers = garrisons.reduce((s, g) => s + g.men, 0);
    return {
      cities, garrisons, provinces, sources, edgeFlows, fx, wages, fiscal,
      totals: {
        pop: cities.reduce((s, c) => s + c.pop, 0) + Object.values(provinces).reduce((s, p) => s + p.ruralPop, 0),
        urban: cities.reduce((s, c) => s + c.pop, 0),
        grainTraded: grainShipped, soldiers,
        famines: cities.filter(c => c.grain.status === "famine").length,
        strained: cities.filter(c => c.grain.status === "strained").length,
        hungryGarrisons: garrisons.filter(g => g.fed && g.grain.status === "famine").length,
        ms: Math.round(performance.now() - t0),
      },
    };
  };

  // ---- real wages (Allen 2009) ----
  // The Edict's unskilled wage is the same everywhere; what it buys is not.
  // The traded goods in the basket, and the in-kind food allowance, are
  // revalued at each city's own prices from the model.
  function computeWages(cities) {
    const W = ECO.wages, C = ECO.commodities;
    const edictBasket = W.basket.reduce((s, b) => s + b.qty * b.price, 0);
    const out = { edictRatio: (W.cashDaily + W.allowanceDaily) * W.daysWorked / (edictBasket * W.familyFactor * W.rentFactor) };
    cities.forEach(c => {
      const index = cid => {
        if (cid === "grain") return (c.grain.price || 45) / C.grain.edict;
        const g = c.goods[cid];
        return g ? g.price / C[cid].edict : 1;
      };
      const lines = W.basket.map(b => {
        const ix = b.index ? index(b.index) : 1;
        return { ...b, local: b.price * ix, cost: b.qty * b.price * ix };
      });
      const basket = lines.reduce((s, l) => s + l.cost, 0);
      const income = (W.cashDaily + W.allowanceDaily * index("grain")) * W.daysWorked;
      const family = basket * W.familyFactor * W.rentFactor;
      c.wage = { lines, basket, family, income, ratio: income / family };
    });
    return out;
  }

  // ---- taxes and trade (Hopkins 1980) ----
  // Everything in thousand tonnes of wheat-equivalent: 10 d.c. per kg of wheat
  // is the Edict's price, so a value in d.c. per kg divides by 10 to convert.
  function computeFiscal({ cities, garrisons, provinces, sources, fx }) {
    const F = ECO.fiscal, A = ECO.army;
    const wheat = ECO.commodities.grain.edict;
    const P = {};
    Object.keys(provinces).forEach(pid => P[pid] = {
      id: pid, name: provinces[pid].name, weight: provinces[pid].ruralPop, pop: provinces[pid].ruralPop,
      army: 0, rome: 0, admin: 0, annona: 0, inKindPaid: 0, inKindSpent: 0,
      exports: 0, imports: 0, soldiers: 0,
    });
    cities.forEach(c => { P[c.province].weight += c.pop * c.wealth; P[c.province].pop += c.pop; });
    const totalPop = Object.values(P).reduce((s, p) => s + p.pop, 0);
    const totalW = Object.values(P).reduce((s, p) => s + p.weight, 0);
    const gdp = totalPop * F.gdpKgPerCapita / 1000;                     // kt
    Object.values(P).forEach(p => { p.gdp = gdp * p.weight / totalW; });

    // spending: the army where it stands, Rome's court and annona, provincial government
    garrisons.forEach(g => {
      P[g.province].army += g.men * A.costKg[g.kind] * fx.armyCostMult / 1e6;
      P[g.province].soldiers += g.men;
    });
    P.italia.rome = F.romeSpendKt;
    Object.values(P).forEach(p => { p.admin = p.pop * F.adminKgPerCapita / 1000; });

    // grain paid and consumed in kind — the annona to Rome, and the army's grain
    // (its local requisition and the state's shipments) — valued at the source price
    garrisons.forEach(g => {
      if (g.grain.local > 0) {
        const v = g.grain.local * provinces[g.province].fob / wheat;
        P[g.province].inKindPaid += v; P[g.province].inKindSpent += v;
      }
    });
    [...cities, ...garrisons].forEach(e => e.grain.imports.forEach(i => {
      const v = i.t * i.from.fob / wheat, from = i.from.id;
      if (i.kind === "annona") {
        P[from].inKindPaid += v; P[e.province].inKindSpent += v; P[e.province].annona += v;
      } else if (i.kind === "military") {
        P[from].inKindPaid += v; P[e.province].inKindSpent += v;
      } else if (from !== e.province) {
        P[from].exports += v; P[e.province].imports += v;    // market grain is trade
      }
    }));
    // the annona grain is spending too (the army's is already inside its cost)
    Object.values(P).forEach(p => { p.spending = p.army + p.rome + p.admin + p.annona; });
    const budget = Object.values(P).reduce((s, p) => s + p.spending, 0);
    const base = Object.values(P).reduce((s, p) => s + p.gdp * (F.taxFactor[p.id] ?? 1), 0);
    const rate = budget / base;
    Object.values(P).forEach(p => {
      p.tax = rate * (F.taxFactor[p.id] ?? 1) * p.gdp;
      p.net = p.tax - p.spending;                            // + pays in, − is paid
      // Hopkins: coin that leaves as tax and isn't spent back must be earned back by exports
      p.coinOut = (p.tax - p.inKindPaid) - (p.spending - p.inKindSpent);
    });

    // the rest of the market's trade between provinces, valued at the origin price
    sources.forEach(s => {
      if (NOT_TRADE.has(s.commodity) || !s.province) return;
      s.destinations.forEach(d => {
        if (d.to.province === s.province) return;
        const v = d.t * s.fobEff / wheat;
        P[s.province].exports += v; P[d.to.province].imports += v;
      });
    });
    Object.values(P).forEach(p => { p.trade = p.exports - p.imports; });

    const armyCost = Object.values(P).reduce((s, p) => s + p.army, 0);
    return { provinces: P, gdp, budget, rate, armyCost, armyShare: armyCost / budget };
  }

  window.Engine = Engine;
})();
