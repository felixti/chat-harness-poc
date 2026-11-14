import { createRequire } from "node:module";
import { rmSync, mkdirSync } from "node:fs";
const pkg = process.argv[2], dir = process.argv[3], N = Number(process.argv[4]);
const { Database } = createRequire(pkg + "/")("@relate/relate");
let db, c;
if (process.argv[5] === "read") { const t0 = performance.now(); db = Database.open(dir); c = db.connect(); const n = c.query("MATCH ()-[r:REL]->() RETURN count(r) AS n", {}).rows[0]; console.log(JSON.stringify({ reopen_ms: +(performance.now() - t0).toFixed(0), count: n })); process.exit(0); }
rmSync(dir, { recursive: true, force: true });
db = Database.open(dir); c = db.connect();
const ents = Array.from({ length: Math.round(N / 6) }, (_, i) => ({ id: `e${i}`, name: `n${i}` }));
const ev = Array.from({ length: N }, (_, i) => ({ s: `e${i % ents.length}`, o: `e${(i * 7 + 3) % ents.length}`, at: i }));
c.query("CREATE INDEX ent_id IF NOT EXISTS FOR (e:Entity) ON (e.id)", {});
for (let i = 0; i < ents.length; i += 500) c.query("UNWIND $rows AS r CREATE (:Entity {id: r.id, name: r.name})", { rows: ents.slice(i, i + 500) });
for (let i = 0; i < ev.length; i += 500) c.query("UNWIND $rows AS r MATCH (a:Entity {id: r.s}), (b:Entity {id: r.o}) CREATE (a)-[:REL {at: r.at}]->(b)", { rows: ev.slice(i, i + 500) });
if (process.argv[5] !== "read") { db.checkpoint(); console.log("written"); process.exit(0); }
const t = performance.now();
db = Database.open(dir); c = db.connect();
const n = c.query("MATCH ()-[r:REL]->() RETURN count(r) AS n", {}).rows[0];
console.log(JSON.stringify({ events: N, reopen_ms: +(performance.now() - t).toFixed(0), count: n }));
