// graph.js — the transport network (ORBIS sea and river lanes + the Itiner-e
// road network) as a weighted graph, with Dijkstra routing by freight cost
// (denarii per kg of grain, Diocletianic).
//
// Nodes and arcs live in typed arrays: ~12,000 nodes and ~33,000 arcs, routed
// dozens of times per recompute. An edge marked `bi` yields an arc each way;
// road edges carry simplified geometry `g` = [lon, lat, lon, lat, ...] from s to t.
(function () {
  "use strict";

  const Graph = {};
  const MODE = { road: 0, river: 1, sea: 2 };

  let N = 0, idx = new Map(), lon, lat, labels, byLabel = new Map();
  let edges = [];
  let head, arcFrom, arcTo, arcEdge, arcRev, arcCost, arcDays, arcMode, arcOpenSea;

  Graph.init = function (net) {
    N = net.nodes.length;
    idx = new Map(); byLabel = new Map();
    lon = new Float64Array(N); lat = new Float64Array(N); labels = new Array(N);
    const seen = new Map();
    net.nodes.forEach((n, i) => {
      idx.set(n.id, i); lon[i] = n.lon; lat[i] = n.lat; labels[i] = n.label || "";
      if (n.label && n.id < 100000) seen.set(n.label, (seen.get(n.label) || 0) + 1);
    });
    // ORBIS labels (ids below 100000) are the names places.json refers to
    net.nodes.forEach(n => { if (n.label && n.id < 100000 && seen.get(n.label) === 1) byLabel.set(n.label, n.id); });

    edges = net.edges;
    const deg = new Int32Array(N);
    edges.forEach(e => { deg[idx.get(e.s)]++; if (e.bi) deg[idx.get(e.t)]++; });
    head = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) head[i + 1] = head[i] + deg[i];
    const M = head[N], fill = head.slice(0, N);
    arcFrom = new Int32Array(M); arcTo = new Int32Array(M); arcEdge = new Int32Array(M); arcRev = new Uint8Array(M);
    arcCost = new Float64Array(M); arcDays = new Float64Array(M); arcMode = new Uint8Array(M); arcOpenSea = new Uint8Array(M);
    const put = (from, to, k, rev) => {
      const e = edges[k], a = fill[from]++;
      arcFrom[a] = from; arcTo[a] = to; arcEdge[a] = k; arcRev[a] = rev;
      arcCost[a] = e.cost; arcDays[a] = e.days; arcMode[a] = MODE[e.mode];
      arcOpenSea[a] = (e.type === "overseas" || e.type === "slowover") ? 1 : 0;
    };
    edges.forEach((e, k) => {
      const s = idx.get(e.s), t = idx.get(e.t);
      put(s, t, k, 0);
      if (e.bi) put(t, s, k, 1);
    });
  };

  Graph.nodeCount = () => N;
  Graph.idFor = label => byLabel.get(label);
  Graph.index = id => idx.get(id);
  Graph.node = id => { const i = idx.get(id); return i === undefined ? null : { id, label: labels[i], lon: lon[i], lat: lat[i] }; };
  Graph.latlng = id => { const i = idx.get(id); return [lat[i], lon[i]]; };
  Graph.edge = k => edges[k];
  Graph.edges = () => edges;

  // Dijkstra by freight cost from one node. mods: {seaCostMult, seaDaysMult, openSeaClosed}.
  // Returns a tree: cost/days per node index, the arc used to reach each node,
  // and the settle order (so flows can be summed back up the tree in O(N)).
  Graph.shortestFrom = function (srcId, mods) {
    mods = mods || {};
    const seaMult = mods.seaCostMult || 1, seaDays = mods.seaDaysMult || 1, noOpen = !!mods.openSeaClosed;
    const dist = new Float64Array(N).fill(Infinity), days = new Float64Array(N);
    const prevArc = new Int32Array(N).fill(-1), done = new Uint8Array(N), order = new Int32Array(N);
    let nOrder = 0;
    const src = idx.get(srcId);
    // binary min-heap on parallel typed arrays, lazy deletion
    let hk = new Float64Array(4096), hv = new Int32Array(4096), hn = 0;
    const push = (k, v) => {
      if (hn === hk.length) {
        const k2 = new Float64Array(hn * 2); k2.set(hk); hk = k2;
        const v2 = new Int32Array(hn * 2); v2.set(hv); hv = v2;
      }
      let i = hn++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= k) break;
        hk[i] = hk[p]; hv[i] = hv[p]; i = p;
      }
      hk[i] = k; hv[i] = v;
    };
    const pop = () => {
      const top = hv[0], k = hk[--hn], v = hv[hn];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= hn) break;
        const m = (l + 1 < hn && hk[l + 1] < hk[l]) ? l + 1 : l;
        if (hk[m] >= k) break;
        hk[i] = hk[m]; hv[i] = hv[m]; i = m;
      }
      hk[i] = k; hv[i] = v;
      return top;
    };
    dist[src] = 0; push(0, src);
    while (hn) {
      const u = pop();
      if (done[u]) continue;
      done[u] = 1; order[nOrder++] = u;
      const du = dist[u];
      for (let a = head[u], end = head[u + 1]; a < end; a++) {
        if (noOpen && arcOpenSea[a]) continue;
        const sea = arcMode[a] === 2;
        const nd = du + (sea ? arcCost[a] * seaMult : arcCost[a]);
        const v = arcTo[a];
        if (nd < dist[v] - 1e-12) {
          dist[v] = nd;
          days[v] = days[u] + (sea ? arcDays[a] * seaDays : arcDays[a]);
          prevArc[v] = a;
          push(nd, v);
        }
      }
    }
    return {
      src, dist, days, prevArc, order: order.subarray(0, nOrder),
      cost: id => { const i = idx.get(id); return (i === undefined || dist[i] === Infinity) ? undefined : dist[i]; },
      daysTo: id => { const i = idx.get(id); return i === undefined ? undefined : days[i]; },
    };
  };

  // Sum per-destination tonnages back up a shortest-path tree onto edges.
  // list: [[node index, tonnes], ...]. add(edgeIndex, tonnes) is called once per
  // arc carrying flow. Uses one scratch buffer, cleared afterwards.
  let scratch = null;
  Graph.accumulate = function (tree, list, add) {
    if (!scratch || scratch.length !== N) scratch = new Float64Array(N);
    const load = scratch;
    for (const [i, t] of list) load[i] += t;
    const o = tree.order;
    for (let k = o.length - 1; k > 0; k--) {
      const v = o[k], t = load[v];
      if (t <= 0) continue;
      const a = tree.prevArc[v];
      add(arcEdge[a], t);
      load[arcFrom[a]] += t;
    }
    load.fill(0);
  };

  // Arcs from the tree's source to a destination node id, source first.
  Graph.pathArcs = function (tree, dstId) {
    let v = idx.get(dstId);
    if (v === undefined || tree.dist[v] === Infinity) return null;
    const out = [];
    while (v !== tree.src) {
      const a = tree.prevArc[v];
      out.push(a);
      v = arcFrom[a];
    }
    return out.reverse();
  };

  // Latlngs along a path of arcs, following road geometry where there is some.
  Graph.pathLatLngs = function (arcs) {
    const pts = [];
    (arcs || []).forEach(a => {
      const seg = Graph.edgeLatLngs(arcEdge[a], arcRev[a] === 1);
      if (pts.length) seg.shift();
      for (const p of seg) pts.push(p);
    });
    return pts;
  };

  // Latlngs of one edge, s→t (or t→s when reversed).
  Graph.edgeLatLngs = function (k, reversed) {
    const e = edges[k];
    let pts;
    if (e.g && e.g.length >= 4) {
      pts = [];
      for (let i = 0; i < e.g.length; i += 2) pts.push([e.g[i + 1], e.g[i]]);
    } else {
      const s = idx.get(e.s), t = idx.get(e.t);
      pts = [[lat[s], lon[s]], [lat[t], lon[t]]];
    }
    return reversed ? pts.reverse() : pts;
  };

  window.Graph = Graph;
})();
