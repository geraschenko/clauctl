import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const roots = process.argv.slice(2);
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (p.endsWith(".jsonl")) files.push(p);
  }
};
roots.forEach(walk);
const types = new Map();
for (const f of files) {
  let lines;
  try {
    lines = readFileSync(f, "utf8").split("\n");
  } catch {
    continue;
  }
  for (const line of lines) {
    if (!line.includes('"attachment"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "attachment" || !e.attachment) continue;
    const t = e.attachment.type ?? "?";
    const rec = types.get(t) ?? {
      count: 0,
      keys: new Set(),
      sample: null,
      isMeta: new Set(),
      parentOk: 0,
      files: new Set(),
    };
    rec.count++;
    Object.keys(e.attachment).forEach((k) => rec.keys.add(k));
    rec.isMeta.add(String(e.isMeta));
    if (e.parentUuid) rec.parentOk++;
    rec.files.add(f);
    if (!rec.sample) rec.sample = e.attachment;
    types.set(t, rec);
  }
}
for (const [t, r] of [...types].sort((a, b) => b[1].count - a[1].count)) {
  console.log(
    `\n=== ${t}: ${r.count} in ${r.files.size} files; keys=${[...r.keys].join(",")}; isMeta=${[...r.isMeta]}; withParent=${r.parentOk}`,
  );
  console.log(JSON.stringify(r.sample, null, 1).slice(0, 700));
}
console.log("\nfiles scanned:", files.length);
