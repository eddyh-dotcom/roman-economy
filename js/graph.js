// graph.js — the ORBIS network as a weighted directed graph, with Dijkstra
// routing by freight cost (denarii per kg of grain, Diocletianic).
(function () {
  "use strict";

  const Graph = {};

  let nodes = new Map();      // id -> {label, lon, lat}
  let byLabel = new Map();    // label -> id (only unique labels)
  let adj = new Map();        // id -> [{t, cost, days, km, mode, type}]

  Graph.init = function (net) {
    nodes = new Map();
    byLabel = new Map();
    adj = new Map();
    const seen = new Map();
    net.nodes.forEach(n => {
      nodes.set(n.id, n);
      seen.set(n.label, (seen.get(n.label) || 0) + 1);
    });
    net.nodes.forEach(n => { if (seen.get(n.label) === 1) byLabel.set(n.label, n.id); });
    net.edges.forEach(e => {
      if (!adj.has(e.s)) adj.set(e.s, []);
      adj.get(e.s).push({ t: e.t, cost: e.cost, days: e.days, km: e.km, mode: e.mode, type: e.type });
    });
  };

  Graph.node = id => nodes.get(id);
  Graph.idFor = label => byLabel.get(label);
  Graph.nodeCount = () => nodes.size;

  // Dijkstra by freight cost. mods: {seaCostMult, openSeaClosed}
  // Returns {dist: Map, days: Map, prev: Map(id -> {p, edge})}
  Graph.shortestFrom = function (srcId, mods) {
    mods = mods || {};
    const seaMult = mods.seaCostMult || 1;
    const noOpenSea = !!mods.openSeaClosed;

    const dist = new Map(), days = new Map(), prev = new Map();
    // binary min-heap of [cost, id]
    const heap = [[0, srcId]];
    const push = it => {
      heap.push(it);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    dist.set(srcId, 0); days.set(srcId, 0);
    const settled = new Set();

    while (heap.length) {
      const [d, u] = pop();
      if (settled.has(u)) continue;
      settled.add(u);
      const es = adj.get(u);
      if (!es) continue;
      for (const e of es) {
        if (noOpenSea && (e.type === "overseas" || e.type === "slowover")) continue;
        let c = e.cost;
        if (e.mode === "sea") c *= seaMult;
        const nd = d + c;
        if (!dist.has(e.t) || nd < dist.get(e.t) - 1e-12) {
          dist.set(e.t, nd);
          days.set(e.t, days.get(u) + e.days * (e.mode === "sea" ? (mods.seaDaysMult || 1) : 1));
          prev.set(e.t, { p: u, edge: e });
          push([nd, e.t]);
        }
      }
    }
    return { dist, days, prev };
  };

  // Reconstruct node-id path src..dst from a prev map.
  Graph.path = function (prev, srcId, dstId) {
    const out = [dstId];
    let cur = dstId;
    let guard = 0;
    while (cur !== srcId && guard++ < 2000) {
      const pe = prev.get(cur);
      if (!pe) return null;
      cur = pe.p;
      out.push(cur);
    }
    return out.reverse();
  };

  Graph.pathLatLngs = function (idPath) {
    return idPath.map(id => { const n = nodes.get(id); return [n.lat, n.lon]; });
  };

  window.Graph = Graph;
})();
