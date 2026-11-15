export const SCHEMA_VERSION_TABLE = "cpg_schema_versions";
export const SCHEMA_VERSION_DDL = `CREATE TABLE IF NOT EXISTS cpg_schema_versions (
  id TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  completed INTEGER NOT NULL CHECK(completed IN (0,1)),
  applied_at INTEGER NOT NULL
)`;

export interface SchemaDefinition {
  init: readonly string[];
  migrations: readonly string[];
  extensions?: readonly { id: string; sql: readonly string[] }[];
}
interface Column { table: string; name: string; type: string; notnull: number; pk: number; dflt: string | null; }
interface UniqueKey { table: string; columns: string; }
interface Check { table: string; expression: string; }
interface Stage { id: string; checksum: string; sql: string[]; condition: string; }
interface Plan { stages: Stage[]; columns: Column[]; structure: string; tables: string; data: string; }
interface Version { id: string; checksum: string; completed: number; applied_at: number; }

const normalize = (sql: string) => sql.toLowerCase().replace(/\s+/g, "").replace(/ifnotexists/g, "");
const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const normalizedSql = (s: string) => "replace(replace(replace(replace(lower(" + s + "),' ',''),char(10),''),char(13),''),char(9),'')";
const tableRE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(/i;
const alterRE = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i;
const objectRE = /^CREATE\s+(?:UNIQUE\s+)?(INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+(\w+)/i;
const defaultValue = (sql: string): string | null => /\bDEFAULT\s+('(?:''|[^'])*'|[-+]?\d+(?:\.\d+)?|NULL)/i.exec(sql)?.[1] ?? null;

function definitions(sql: string): string[] {
  const body = sql.replace(/--[^\n]*/g, "");
  const start = body.indexOf("(");
  const end = body.lastIndexOf(")");
  const parts: string[] = [];
  let depth = 0, quoted = false, from = start + 1;
  for (let i = from; i < end; i++) {
    const c = body[i];
    if (c === "'") { if (quoted && body[i + 1] === "'") i++; else quoted = !quoted; }
    if (quoted) continue;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { parts.push(body.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(body.slice(from, end).trim());
  return parts;
}

function schemaRequirements(statements: readonly string[], extension = false) {
  const columns = new Map<string, Column>();
  const uniques = new Map<string, UniqueKey>();
  const checks = new Map<string, Check>();
  const tables = new Set<string>();
  const objects = new Map<string, { name: string; type: string; sql: string }>();
  for (const sql of statements) {
    const table = tableRE.exec(sql.trim());
    if (table) {
      const name = table[1]; tables.add(name);
      const parts = definitions(sql);
      let primary: string[] = [];
      for (const part of parts) {
        const key = /^(PRIMARY\s+KEY|UNIQUE)\s*\(([^)]+)\)/i.exec(part);
        if (key) {
          const names = key[2].split(",").map(s => s.trim());
          uniques.set(name + ":" + names.join(","), { table: name, columns: names.join(",") });
          if (/PRIMARY/i.test(key[1])) primary = names;
          continue;
        }
        if (extension && /^(?:CONSTRAINT\s+\w+\s+)?CHECK\s*\(/i.test(part)) continue;
        const col = /^(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/i.exec(part);
        if (!col) throw new Error("Unclassified core table definition: " + part);
        columns.set(name + "." + col[1], { table: name, name: col[1], type: col[2].toUpperCase(), notnull: /\bNOT\s+NULL\b/i.test(part) ? 1 : 0, pk: /\bPRIMARY\s+KEY\b/i.test(part) ? 1 : 0, dflt: defaultValue(part) });
        if (/\bUNIQUE\b/i.test(part)) uniques.set(name + ":" + col[1], { table: name, columns: col[1] });
      }
      for (const [index, col] of primary.entries()) columns.get(name + "." + col)!.pk = index + 1;
      for (const match of sql.matchAll(/\bCHECK\s*\(/gi)) {
        const start = match.index!; let depth = 1, end = start + match[0].length;
        for (; end < sql.length && depth > 0; end++) { if (sql[end] === "(") depth++; if (sql[end] === ")") depth--; }
        const expression = normalize(sql.slice(start, end));
        checks.set(name + ":" + expression, { table: name, expression });
      }
      continue;
    }
    const alter = alterRE.exec(sql.trim());
    if (alter) {
      const col = /^\s*(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/i.exec(sql.slice(alter[0].length));
      if (!col) throw new Error("Unclassified ALTER: " + sql);
      const key = alter[1] + "." + alter[2];
      if (!columns.has(key)) columns.set(key, { table: alter[1], name: alter[2], type: col[1].toUpperCase(), notnull: /\bNOT\s+NULL\b/i.test(sql) ? 1 : 0, pk: 0, dflt: defaultValue(sql) });
      if (extension) {
        for (const match of sql.matchAll(/\bCHECK\s*\(/gi)) {
          const start = match.index!; let depth = 1, end = start + match[0].length;
          for (; end < sql.length && depth > 0; end++) { if (sql[end] === "(") depth++; if (sql[end] === ")") depth--; }
          const expression = normalize(sql.slice(start, end));
          checks.set(alter[1] + ":" + expression, { table: alter[1], expression });
        }
      }
      continue;
    }
    const obj = objectRE.exec(sql.trim());
    if (obj) objects.set(obj[2], { name: obj[2], type: obj[1].toLowerCase(), sql: normalize(sql) });
  }
  const values = (v: unknown) => "json_each(" + quote(JSON.stringify(v)) + ")";
  const j = (key: string) => "json_extract(e.value,'$." + key + "')";
  const tableCondition = "NOT EXISTS(SELECT 1 FROM " + values([...tables]) + " e WHERE NOT EXISTS(SELECT 1 FROM sqlite_master m WHERE m.type='table' AND m.name=e.value))";
  const columnCondition = "NOT EXISTS(SELECT 1 FROM " + values([...columns.values()]) + " e LEFT JOIN pragma_table_info(" + j("table") + ") p ON p.name=" + j("name") + " WHERE p.name IS NULL OR upper(p.type)<>" + j("type") + " OR p.[notnull]<" + j("notnull") + " OR p.pk<>" + j("pk") + " OR p.dflt_value IS NOT " + j("dflt") + ")";
  const uniqueCondition = "NOT EXISTS(SELECT 1 FROM " + values([...uniques.values()]) + " e WHERE NOT EXISTS(SELECT 1 FROM pragma_index_list(" + j("table") + ") i WHERE i.[unique]=1 AND i.partial=0 AND (SELECT group_concat(name,',') FROM (SELECT name FROM pragma_index_info(i.name) ORDER BY seqno))=" + j("columns") + "))";
  const checkCondition = "NOT EXISTS(SELECT 1 FROM " + values([...checks.values()]) + " e WHERE NOT EXISTS(SELECT 1 FROM sqlite_master m WHERE m.type='table' AND m.name=" + j("table") + " AND instr(" + normalizedSql("m.sql") + "," + j("expression") + ")>0))";
  const objectCondition = "NOT EXISTS(SELECT 1 FROM " + values([...objects.values()]) + " e WHERE NOT EXISTS(SELECT 1 FROM sqlite_master m WHERE m.name=" + j("name") + " AND m.type=" + j("type") + " AND replace(" + normalizedSql("m.sql") + ",'ifnotexists','')=" + j("sql") + "))";
  return { columns: [...columns.values()], tables: tableCondition, columnsCondition: [tableCondition, columnCondition, uniqueCondition, checkCondition].join(" AND "), structure: [tableCondition, columnCondition, uniqueCondition, checkCondition, objectCondition].join(" AND ") };
}

async function checksum(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
}

const plans = new WeakMap<SchemaDefinition, Promise<Plan>>();
async function planFor(definition: SchemaDefinition): Promise<Plan> {
  let pending = plans.get(definition);
  if (!pending) {
    pending = (async () => {
      const all = [...definition.init, ...definition.migrations];
      const requirements = schemaRequirements(all);
      const tables = [...new Set(all.filter(sql => tableRE.test(sql.trim())))];
      const alters = all.filter(sql => alterRE.test(sql.trim()));
      const finish = [...new Set(all.filter(sql => !tableRE.test(sql.trim()) && !alterRE.test(sql.trim())))];
      const data = "NOT EXISTS(SELECT 1 FROM models WHERE pricing_mode='unset' AND (input_price_per_m>0 OR output_price_per_m>0))" +
        " AND NOT EXISTS(SELECT 1 FROM devices d WHERE NOT EXISTS(SELECT 1 FROM device_wallets w WHERE w.device_id=d.id))" +
        " AND NOT EXISTS(SELECT 1 FROM service_group_models s WHERE NOT EXISTS(SELECT 1 FROM public_model_identities p WHERE p.name=s.model_key))" +
        " AND EXISTS(SELECT 1 FROM video_reference_cleanup_backfill WHERE id=1)" +
        " AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_usage_device_id')";
      const specs = [
        { id: "core/0001-tables", sql: tables, condition: requirements.tables },
        { id: "core/0002-columns", sql: alters, condition: requirements.columnsCondition },
        { id: "core/0003-ready", sql: finish, condition: requirements.structure + " AND " + data },
      ];
      const stages = await Promise.all(specs.map(async stage => ({ ...stage, checksum: await checksum({ protocol: 1, ...stage }) })));
      let structure = requirements.structure;
      const ids = new Set(stages.map(stage => stage.id));
      for (const extension of definition.extensions ?? []) {
        if (!extension.id || extension.id.startsWith("core/") || ids.has(extension.id)) throw new Error("Invalid schema extension id: " + extension.id);
        ids.add(extension.id);
        const sql = [...extension.sql];
        const condition = structure + " AND " + schemaRequirements(sql, true).structure;
        const spec = { id: extension.id, sql, condition };
        const predecessors = stages.map(({ id, checksum }) => ({ id, checksum }));
        stages.push({ ...spec, checksum: await checksum({ protocol: 2, ...spec, predecessors }) });
        structure = condition;
      }
      return { stages, columns: requirements.columns, structure, tables: requirements.tables, data };
    })();
    plans.set(definition, pending);
  }
  return pending;
}

export const SCHEMA_MANIFEST_READ_SQL = "SELECT (SELECT sql FROM sqlite_master WHERE type='table' AND name='cpg_schema_versions') AS ddl, " +
  "(SELECT json_group_array(json_object('id',id,'checksum',checksum,'completed',completed,'applied_at',applied_at)) " +
  "FROM (SELECT id,checksum,completed,applied_at FROM cpg_schema_versions WHERE id >= '' ORDER BY id LIMIT 4)) AS versions";

function manifestReadSql(plan: Plan): string {
  if (plan.stages.length === 3) return SCHEMA_MANIFEST_READ_SQL;
  const order = "CASE id " + plan.stages.map((stage, index) => "WHEN " + quote(stage.id) + " THEN " + index).join(" ") + " ELSE " + plan.stages.length + " END,id";
  return SCHEMA_MANIFEST_READ_SQL.replace(
    "FROM (SELECT id,checksum,completed,applied_at FROM cpg_schema_versions WHERE id >= '' ORDER BY id LIMIT 4)",
    "FROM (SELECT * FROM (SELECT id,checksum,completed,applied_at FROM cpg_schema_versions WHERE id >= '' ORDER BY id LIMIT " + (plan.stages.length + 1) + ") ORDER BY " + order + ")",
  );
}

async function readManifest(db: D1Database, plan: Plan): Promise<Version[] | null> {
  let row: { ddl: string; versions: string } | null;
  try { row = await db.prepare(manifestReadSql(plan)).first<typeof row>(); }
  catch (error) {
    if (/\bno such table:\s*(?:main\.)?cpg_schema_versions\b/i.test(String(error))) return null;
    throw error;
  }
  if (!row || typeof row.ddl !== "string" || normalize(row.ddl) !== normalize(SCHEMA_VERSION_DDL) || typeof row.versions !== "string") throw new Error("Malformed core schema manifest");
  const parsed: unknown = JSON.parse(row.versions);
  if (!Array.isArray(parsed) || parsed.length > plan.stages.length) throw new Error("Unknown core schema version");
  for (let i = 0; i < parsed.length; i++) {
    const actual = parsed[i] as Version | null, expected = plan.stages[i];
    if (!actual || actual.id !== expected.id || actual.checksum !== expected.checksum || actual.completed !== 1 || !Number.isSafeInteger(actual.applied_at) || actual.applied_at < 0) throw new Error("Unsafe core schema manifest at " + expected.id + " (id/checksum/completion mismatch)");
  }
  return parsed as Version[];
}

function prepareCondition(db: D1Database, sql: string, trailing: unknown[] = []): D1PreparedStatement {
  const values: string[] = [];
  const template = sql.replace(/json_each\('((?:''|[^'])*)'\)/g, (_match, literal: string) => {
    values.push(literal.replace(/''/g, "'"));
    return "json_each(?)";
  });
  const statement = db.prepare(template);
  return values.length || trailing.length ? statement.bind(...values, ...trailing) : statement;
}

async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const result = await db.batch(statements) as unknown as { success?: boolean; error?: string }[];
  if (!Array.isArray(result) || result.length !== statements.length || result.some(r => !r || r.success !== true || r.error)) throw new Error("Core schema batch did not confirm every statement");
}

export async function migrateVersionedSchema(db: D1Database, definition: SchemaDefinition, audit = false): Promise<void> {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") throw new Error("D1 binding required for core schema readiness");
  const plan = await planFor(definition);
  let manifest = await readManifest(db, plan);
  if (manifest === null) {
    await batch(db, [db.prepare(SCHEMA_VERSION_DDL)]);
    manifest = await readManifest(db, plan);
    if (manifest === null) throw new Error("Core schema manifest creation was not durable");
  }
  if (manifest.length === plan.stages.length) {
    if (audit) {
      const row = await prepareCondition(db, "SELECT CASE WHEN " + plan.structure + " THEN 1 ELSE 0 END AS valid").first<{ valid: number }>();
      if (row?.valid !== 1) throw new Error("Core schema restore audit failed");
    }
    return;
  }
  for (let index = manifest.length; index < plan.stages.length; index++) {
    const stage = plan.stages[index];
    try {
      let sql = stage.sql;
      if (index === 1 || sql.some(s => alterRE.test(s.trim()))) {
        const row = await db.prepare("SELECT json_group_array(m.name || '.' || p.name) AS cols FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '\\_%' ESCAPE '\\'").first<{ cols: string }>();
        const parsed: unknown = row && typeof row.cols === "string" ? JSON.parse(row.cols) : null;
        if (!Array.isArray(parsed) || parsed.some(c => typeof c !== "string")) throw new Error("Malformed core schema column probe");
        const columns = new Set(parsed.map(c => c.toLowerCase()));
        sql = sql.filter(s => { const m = alterRE.exec(s.trim()); return !m || !columns.has((m[1] + "." + m[2]).toLowerCase()); });
      }
      const condition = stage.condition;
      await batch(db, [
        db.prepare("INSERT INTO cpg_schema_versions(id,checksum,completed,applied_at) VALUES(?,?,0,?)").bind(stage.id, stage.checksum, Date.now()),
        ...sql.map(s => db.prepare(s)),
        prepareCondition(db, "UPDATE cpg_schema_versions SET completed=CASE WHEN " + condition + " THEN 1 ELSE NULL END WHERE id=? AND checksum=? AND completed=0", [stage.id, stage.checksum]),
      ]);
    } catch (error) {
      const observed = await readManifest(db, plan);
      if (!observed || observed.length <= index) throw error;
    }
    const observed = await readManifest(db, plan);
    if (!observed || observed.length <= index) throw new Error("Core schema stage completion was not durable: " + stage.id);
  }
}

let ready = new WeakMap<object, { definition: SchemaDefinition; promise: Promise<void> }>();
const auditAfterReset = new WeakSet<object>();
const verifiedGeneration = new WeakMap<object, number>();
let generation = 0;
export function ensureVersionedSchema(db: D1Database, definition: SchemaDefinition): Promise<void> {
  if (!db || typeof db !== "object") return Promise.reject(new Error("D1 binding required for core schema readiness"));
  const entry = ready.get(db);
  let promise = entry?.definition === definition ? entry.promise : undefined;
  if (!promise) {
    const stale = verifiedGeneration.has(db) && verifiedGeneration.get(db) !== generation;
    const startedGeneration = generation;
    promise = migrateVersionedSchema(db, definition, auditAfterReset.has(db) || stale);
    ready.set(db, { definition, promise });
    void promise.then(() => { verifiedGeneration.set(db, startedGeneration); auditAfterReset.delete(db); }, () => { if (ready.get(db)?.promise === promise) ready.delete(db); });
  }
  return promise;
}

export function resetSchemaCache(db?: D1Database): void {
  if (db) { ready.delete(db); auditAfterReset.add(db); }
  else { ready = new WeakMap(); generation++; }
}
