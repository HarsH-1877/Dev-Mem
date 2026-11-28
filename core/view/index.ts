import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GraphStore } from "../graph/index.js";
import type { KnowledgeEdge, KnowledgeNode } from "../graph/types.js";
import { ensureLocalDataDir, getDevMemDir } from "../local-data.js";
import { collectStats } from "../telemetry/index.js";

export interface StaticReportOptions {
  outPath?: string;
}

export interface StaticReportResult {
  path: string;
  nodeCount: number;
  edgeCount: number;
}

function safeInlineJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Generates a self-contained, zero-server static HTML knowledge graph explorer
 * at `.dev-mem/report.html` (or `options.outPath`). Zero external CDN calls.
 */
export function generateStaticReport(
  projectRoot: string,
  options: StaticReportOptions = {},
): StaticReportResult {
  ensureLocalDataDir(projectRoot);
  const outPath = options.outPath
    ? resolve(projectRoot, options.outPath)
    : join(getDevMemDir(projectRoot), "report.html");
  mkdirSync(dirname(outPath), { recursive: true });

  const store = new GraphStore({ projectRoot });
  let nodes: KnowledgeNode[] = [];
  const edgeMap = new Map<string, KnowledgeEdge>();
  try {
    nodes = store.queryAllNodes();
    for (const node of nodes) {
      for (const edge of store.listEdges(node.id)) {
        edgeMap.set(edge.id, edge);
      }
    }
  } finally {
    store.close();
  }

  const edges = [...edgeMap.values()];
  const stats = collectStats(projectRoot);
  const payload = safeInlineJson({
    generatedAt: new Date().toISOString(),
    stats,
    nodes,
    edges,
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Dev-Mem Explorer</title>
<style>
  :root {
    --bg: #0f1419; --panel: #161d24; --border: #26313d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --verified: #3fb950; --active: #58a6ff; --observed: #d29922;
    --stale: #f0883e; --superseded: #6e7681; --danger: #f85149;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 16px 24px; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
  h1 { margin: 0; font-size: 18px; letter-spacing: 0.3px; }
  .meta { color: var(--muted); font-size: 12px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; padding: 16px 24px 0; }
  .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .kpi-val { font-size: 22px; font-weight: 700; }
  .kpi-lbl { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; padding: 16px 24px; }
  input, select { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 13px; }
  input { flex: 1; min-width: 220px; }
  .workspace { display: grid; grid-template-columns: 1.15fr 1fr 0.95fr; gap: 14px; padding: 0 24px 24px; min-height: 520px; }
  @media (max-width: 1080px) { .workspace { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
  .card-hd { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; }
  #graphSvg { width: 100%; height: 480px; background: #0c1015; display: block; }
  .node-list { max-height: 480px; overflow-y: auto; }
  .node-row { padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .node-row:hover, .node-row.sel { background: #1c2631; }
  .badges { display: flex; gap: 6px; font-size: 11px; margin-bottom: 4px; flex-wrap: wrap; }
  .badge { padding: 1px 7px; border-radius: 10px; background: #212a34; border: 1px solid var(--border); }
  .st-verified { color: var(--verified); border-color: var(--verified); }
  .st-active { color: var(--active); border-color: var(--active); }
  .st-observed { color: var(--observed); border-color: var(--observed); }
  .st-stale { color: var(--stale); border-color: var(--stale); }
  .st-superseded { color: var(--superseded); }
  .detail { padding: 14px; overflow-y: auto; max-height: 480px; font-size: 13px; line-height: 1.5; }
  .detail h2 { margin: 0 0 8px; font-size: 16px; }
  .kv { color: var(--muted); font-size: 12px; margin-top: 8px; }
  .kv code { color: var(--text); background: #0c1015; padding: 2px 5px; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>Dev-Mem Explorer</h1>
  <div class="meta" id="genMeta"></div>
</header>
<section class="kpis" id="kpis"></section>
<section class="controls">
  <input id="q" type="search" placeholder="Search titles, contents, files, or symbols..." />
  <select id="typeSel"><option value="">All Types</option></select>
  <select id="stateSel">
    <option value="">All States</option>
    <option value="verified">verified</option>
    <option value="active">active</option>
    <option value="observed">observed</option>
    <option value="stale">stale</option>
    <option value="superseded">superseded</option>
  </select>
</section>
<main class="workspace">
  <div class="card"><div class="card-hd">Knowledge Graph</div><svg id="graphSvg" viewBox="0 0 600 480"></svg></div>
  <div class="card"><div class="card-hd">Nodes (<span id="countLbl">0</span>)</div><div class="node-list" id="nodeList"></div></div>
  <div class="card"><div class="card-hd">Evidence Inspector</div><div class="detail" id="detailPane">Select a node to inspect provenance, files, and graph edges.</div></div>
</main>
<script id="devmem-data" type="application/json">${payload}</script>
<script>
const DATA = JSON.parse(document.getElementById("devmem-data").textContent);
const TYPE_COLORS = {
  Decision: "#58a6ff", Constraint: "#a371f7", Convention: "#3fb950",
  FailedApproach: "#f85149", Discovery: "#39c5cf", OpenIssue: "#d29922"
};
const el = (id) => document.getElementById(id);
el("genMeta").textContent = "Generated " + new Date(DATA.generatedAt).toLocaleString();

const kpiItems = [
  ["Total Nodes", DATA.stats.totalNodes],
  ["Verified / Active", DATA.stats.verifiedNodes + " / " + DATA.stats.activeNodes],
  ["Sessions Assisted", DATA.stats.sessionsAssisted],
  ["Injections Served", DATA.stats.totalInjections],
  ["Warnings Surfaced", DATA.stats.preventedRegressions],
  ["Edges", DATA.edges.length]
];
el("kpis").innerHTML = kpiItems.map(([l,v]) => '<div class="kpi"><div class="kpi-val">' + v + '</div><div class="kpi-lbl">' + l + '</div></div>').join("");

const types = [...new Set(DATA.nodes.map(n => n.type))].sort();
types.forEach(t => { const o = document.createElement("option"); o.value = t; o.textContent = t; el("typeSel").appendChild(o); });

let selectedId = DATA.nodes[0]?.id || null;
function esc(s) { return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function filteredNodes() {
  const q = el("q").value.trim().toLowerCase();
  const t = el("typeSel").value;
  const st = el("stateSel").value;
  return DATA.nodes.filter(n => {
    if (t && n.type !== t) return false;
    if (st && n.lifecycle_state !== st) return false;
    if (!q) return true;
    const hay = [n.id, n.title, n.content, ...(n.evidence?.files || []), ...(n.evidence?.symbols || [])].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function renderGraph(list) {
  const svg = el("graphSvg");
  const W = 600, H = 480, cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.36;
  const pos = new Map();
  list.slice(0, 60).forEach((n, i, arr) => {
    const angle = (2 * Math.PI * i) / Math.max(1, arr.length) - Math.PI / 2;
    pos.set(n.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), node: n });
  });
  let out = "";
  DATA.edges.forEach(e => {
    const a = pos.get(e.from_id), b = pos.get(e.to_id);
    if (a && b) out += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="#3b4856" stroke-width="1.5" />';
  });
  pos.forEach((p, id) => {
    const col = TYPE_COLORS[p.node.type] || "#8b949e";
    const sel = id === selectedId;
    out += '<g style="cursor:pointer" onclick="selectNode(\\'' + id + '\\')">' +
      '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (sel ? 11 : 7) + '" fill="' + col + '" stroke="' + (sel ? "#fff" : "#0c1015") + '" stroke-width="2" />' +
      '<title>' + esc(p.node.type + ": " + p.node.title) + '</title></g>';
  });
  svg.innerHTML = out || '<text x="300" y="240" text-anchor="middle" fill="#8b949e" font-size="13">No matching nodes</text>';
}

function renderDetail(id) {
  const n = DATA.nodes.find(x => x.id === id);
  if (!n) { el("detailPane").textContent = "Select a node to inspect."; return; }
  const relEdges = DATA.edges.filter(e => e.from_id === n.id || e.to_id === n.id);
  el("detailPane").innerHTML =
    '<div class="badges"><span class="badge">' + esc(n.type) + '</span><span class="badge st-' + esc(n.lifecycle_state) + '">' + esc(n.lifecycle_state) + '</span></div>' +
    '<h2>' + esc(n.title) + '</h2>' +
    '<p>' + esc(n.content || "(no details)") + '</p>' +
    '<div class="kv">ID: <code>' + esc(n.id.slice(0, 8)) + '</code> · Confidence: <code>' + esc(n.evidence?.confidence) + '</code> · Agent: <code>' + esc(n.evidence?.agent) + '</code></div>' +
    '<div class="kv">Files: <code>' + esc((n.evidence?.files || []).join(", ")) + '</code></div>' +
    ((n.evidence?.symbols || []).length ? '<div class="kv">Symbols: <code>' + esc(n.evidence.symbols.join(", ")) + '</code></div>' : '') +
    '<div class="kv">Commit: <code>' + esc((n.evidence?.commit || "").slice(0, 10)) + '</code> · Grounded: <code>' + esc(n.evidence?.grounded !== false) + '</code></div>' +
    (relEdges.length ? '<div class="kv">Edges: ' + relEdges.map(e => '<code>' + esc(e.type) + '</code>').join(" ") + '</div>' : '');
}

window.selectNode = (id) => { selectedId = id; renderAll(); };
function renderAll() {
  const list = filteredNodes();
  el("countLbl").textContent = String(list.length);
  el("nodeList").innerHTML = list.map(n =>
    '<div class="node-row' + (n.id === selectedId ? " sel" : "") + '" onclick="selectNode(\\'' + n.id + '\\')">' +
    '<div class="badges"><span class="badge">' + esc(n.id.slice(0, 8)) + '</span><span class="badge">' + esc(n.type) + '</span><span class="badge st-' + esc(n.lifecycle_state) + '">' + esc(n.lifecycle_state) + '</span></div>' +
    '<div>' + esc(n.title) + '</div></div>'
  ).join("") || '<div class="node-row">No matching nodes</div>';
  renderGraph(list);
  renderDetail(selectedId);
}
["q", "typeSel", "stateSel"].forEach(id => el(id).addEventListener("input", renderAll));
renderAll();
</script>
</body>
</html>
`;

  writeFileSync(outPath, html, "utf8");
  return {
    path: outPath,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}
