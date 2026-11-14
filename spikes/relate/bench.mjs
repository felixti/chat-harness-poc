// Spike: rebuild a per-user facts graph from events each turn, then typed queries.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const pkg = process.argv[2];
const engine = process.argv[3] ?? "wasm";
const N = Number(process.argv[4] ?? 5000);
const req = createRequire(pkg + "/");
const mem0 = process.memoryUsage().rss;
let t = performance.now();
let run;
if (engine === "wasm") {
  const w = await import(pkg + "/node_modules/@relate/relate-wasm/relate.js");
  w.initSync({ module: readFileSync(pkg + "/node_modules/@relate/relate-wasm/relate_bg.wasm") });
  const db = new w.RelateDb();
  run = (q, p) => JSON.parse(db.execute(q, p ? JSON.stringify(p) : null));
} else {
  const { Database } = req("@relate/relate");
  const conn = Database.open(":memory:").connect();
  run = (q, p) => conn.query(q, p ?? {});
}
const init = performance.now() - t;

// Synthetic events: people, projects, topics, decisions with source + time.
const kinds = ["Person", "Project", "Topic", "Company"];
const ents = Array.from({ length: Math.round(N / 6) }, (_, i) => ({ id: `e${i}`, kind: kinds[i % 4], name: `${kinds[i % 4]} ${i}` }));
const rels = ["WORKS_ON", "OWNS", "ABOUT", "DECIDED", "DEPENDS_ON"];
const events = Array.from({ length: N }, (_, i) => ({ s: `e${i % ents.length}`, r: rels[i % 5], o: `e${(i * 7 + 3) % ents.length}`, at: 1_760_000_000_000 + i * 60_000, src: `conv-${i % 300}` }));

t = performance.now();
run("CREATE INDEX ent_id IF NOT EXISTS FOR (e:Entity) ON (e.id)");
for (let i = 0; i < ents.length; i += 500) run("UNWIND $rows AS r CREATE (:Entity {id: r.id, kind: r.kind, name: r.name})", { rows: ents.slice(i, i + 500) });
for (let i = 0; i < events.length; i += 500)
  run("UNWIND $rows AS r MATCH (a:Entity {id: r.s}), (b:Entity {id: r.o}) CREATE (a)-[:REL {type: r.r, at: r.at, src: r.src}]->(b)", { rows: events.slice(i, i + 500) });
const load = performance.now() - t;

t = performance.now();
const q1 = run("MATCH (a:Entity {id: $id})-[r:REL]-(b) RETURN r.type AS rel, b.name AS name, r.at AS at ORDER BY r.at DESC LIMIT 10", { id: "e5" });
const q2 = run("MATCH (a:Entity {id: $id})-[:REL]-()-[:REL]-(c) WHERE c.id <> $id RETURN c.name AS name, count(*) AS n ORDER BY n DESC LIMIT 5", { id: "e5" });
const q3 = run("MATCH (a)-[r:REL {type: 'DECIDED'}]->(b:Entity {id: $id}) RETURN a.name AS who, r.at AS at, r.src AS src ORDER BY r.at DESC LIMIT 1", { id: "e8" });
const q = performance.now() - t;
const rows = (x) => (x.rows ?? x.results?.[0]?.data ?? x.data ?? x).length ?? JSON.stringify(x).slice(0, 80);
console.log(JSON.stringify({ engine, events: N, entities: ents.length, init_ms: +init.toFixed(0), load_ms: +load.toFixed(0), queries3_ms: +q.toFixed(1), rss_mb: +((process.memoryUsage().rss - mem0) / 1e6).toFixed(0), sample: [rows(q1), rows(q2), rows(q3)] }));
if (process.argv[5]) console.log(JSON.stringify(q1).slice(0, 400));
