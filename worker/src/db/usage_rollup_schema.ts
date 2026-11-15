export const USAGE_HOUR_MS = 3_600_000;
export const USAGE_ROLLUP_DIMENSIONS = [
  "device_id", "sub_token_id", "provider_id", "model", "service_group_id", "provider_name",
] as const;
export const USAGE_ROLLUP_METRICS = [
  "request_count", "input_tokens", "output_tokens", "total_tokens", "cost_usd", "cache_hit_count",
  "cache_read_tokens", "cache_write_tokens", "cost_saved_usd", "pricing_missing_count", "search_calls",
  "image_count", "error_count", "latency_sum", "latency_count",
  "cache_saved_tokens", "cached_latency_sum", "cached_latency_count", "direct_latency_sum", "direct_latency_count",
  "positive_latency_sum", "positive_latency_count", "positive_latency_min", "positive_latency_max", "positive_latency_error_count",
] as const;
export function usageDimensionKey(alias: string): string {
  return "json_array(" + USAGE_ROLLUP_DIMENSIONS.map(c => alias + "." + c).join(",") + ")";
}
export function usageMetricExpressions(alias: string): string[] {
  const c = (name: string) => alias + "." + name;
  return ["1", c("input_tokens"), c("output_tokens"), c("total_tokens"), c("cost_usd"),
    "CASE WHEN " + c("cache_hit") + "=1 THEN 1 ELSE 0 END", c("cache_read_tokens"), c("cache_write_tokens"),
    "CASE WHEN " + c("cache_hit") + "=1 THEN " + c("cost_usd") + " ELSE 0 END",
    "CASE WHEN " + c("pricing_missing") + "=1 THEN 1 ELSE 0 END", c("search_calls"), c("image_count"),
    "CASE WHEN " + c("status_code") + ">=400 THEN 1 ELSE 0 END", "COALESCE(" + c("latency_ms") + ",0)",
    "CASE WHEN " + c("latency_ms") + " IS NOT NULL THEN 1 ELSE 0 END",
    "CASE WHEN " + c("cache_hit") + "=1 THEN " + c("total_tokens") + " ELSE 0 END",
    "CASE WHEN " + c("cache_hit") + "=1 THEN COALESCE(" + c("latency_ms") + ",0) ELSE 0 END",
    "CASE WHEN " + c("cache_hit") + "=1 AND " + c("latency_ms") + " IS NOT NULL THEN 1 ELSE 0 END",
    "CASE WHEN " + c("cache_hit") + "=0 THEN COALESCE(" + c("latency_ms") + ",0) ELSE 0 END",
    "CASE WHEN " + c("cache_hit") + "=0 AND " + c("latency_ms") + " IS NOT NULL THEN 1 ELSE 0 END",
    "CASE WHEN " + c("latency_ms") + ">0 THEN " + c("latency_ms") + " ELSE 0 END",
    "CASE WHEN " + c("latency_ms") + ">0 THEN 1 ELSE 0 END",
    "CASE WHEN " + c("latency_ms") + ">0 THEN " + c("latency_ms") + " ELSE 0 END",
    "CASE WHEN " + c("latency_ms") + ">0 THEN " + c("latency_ms") + " ELSE 0 END",
    "CASE WHEN " + c("latency_ms") + ">0 AND " + c("status_code") + ">=400 THEN 1 ELSE 0 END"];
}
const dimensionColumns = USAGE_ROLLUP_DIMENSIONS.map(c => c + " TEXT").join(",");
const metricColumns = USAGE_ROLLUP_METRICS.map(c => c + " " + (c === "cost_usd" || c === "cost_saved_usd" ? "REAL" : "INTEGER") + " NOT NULL DEFAULT 0").join(",");
export const USAGE_ROLLUP_TABLES = [
  `CREATE TABLE IF NOT EXISTS usage_rollup_receipts (
    id INTEGER PRIMARY KEY, request_id TEXT, device_id TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS usage_hourly_rollups (
    hour_start INTEGER NOT NULL, dimension_key TEXT NOT NULL, ${dimensionColumns}, ${metricColumns},
    PRIMARY KEY(hour_start,dimension_key)
  )`,
  `CREATE TABLE IF NOT EXISTS usage_monthly_rollups (
    month_start INTEGER NOT NULL, dimension_key TEXT NOT NULL, ${dimensionColumns}, ${metricColumns},
    PRIMARY KEY(month_start,dimension_key)
  )`,
  "CREATE TABLE IF NOT EXISTS usage_rollup_archived_hours (hour_start INTEGER PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS usage_rollup_write_context (id INTEGER PRIMARY KEY CHECK(id=1), usage_id INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS usage_rollup_cleanup_context (id INTEGER PRIMARY KEY CHECK(id=1), before_ms INTEGER NOT NULL, batch_limit INTEGER NOT NULL CHECK(batch_limit BETWEEN 1 AND 1000))",
  "CREATE TABLE IF NOT EXISTS usage_rollup_cleanup_permits (usage_id INTEGER PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS usage_rollup_cleanup_operations (operation_id TEXT PRIMARY KEY, params_json TEXT NOT NULL, nonce TEXT NOT NULL, result_json TEXT)",
] as const;

export const USAGE_CLEANUP_ELIGIBLE_SQL = `
  EXISTS (SELECT 1 FROM usage_rollup_receipts r WHERE r.id=u.id AND r.request_id IS u.request_id
    AND r.device_id IS u.device_id AND r.created_at IS u.created_at)
  AND u.request_id IS NOT NULL
  AND u.created_at < CAST(strftime('%s','now') AS INTEGER)*1000-3600000
  AND NOT EXISTS (SELECT 1 FROM reserve_holds h WHERE h.request_id=u.request_id)
  AND NOT EXISTS (SELECT 1 FROM monthly_pass_funding f WHERE f.request_id=u.request_id AND (f.released<>1 OR f.settled<>1))
  AND (
    EXISTS (SELECT 1 FROM billing_requests b WHERE b.request_id=u.request_id AND b.device_id IS u.device_id
      AND b.billing_state='settled' AND b.settled_at IS NOT NULL AND b.hold_released_at IS NOT NULL
      AND b.known_cost_usd IS NOT NULL AND b.terminal_snapshot_json IS NOT NULL
      AND b.outcome IS NOT NULL AND b.outcome NOT IN ('unknown','not_dispatched'))
    OR (NOT EXISTS (SELECT 1 FROM billing_requests b WHERE b.request_id=u.request_id)
      AND EXISTS (SELECT 1 FROM video_tasks v WHERE v.id=u.request_id AND v.device_id IS u.device_id
        AND v.status IN ('succeeded','failed') AND v.settlement_claim IS NOT NULL
        AND EXISTS (SELECT 1 FROM wallet_ledger l WHERE l.request_id=v.id AND l.device_id=v.device_id
          AND l.reason='usage' AND l.note=v.settlement_claim)))
    OR (NOT EXISTS (SELECT 1 FROM billing_requests b WHERE b.request_id=u.request_id)
      AND NOT EXISTS (SELECT 1 FROM video_tasks v WHERE v.id=u.request_id)
      AND EXISTS (SELECT 1 FROM wallet_ledger l WHERE l.request_id=u.request_id AND l.device_id IS u.device_id
        AND l.reason='usage'))
  )`;

const dims = USAGE_ROLLUP_DIMENSIONS.join(",");
const metrics = USAGE_ROLLUP_METRICS.join(",");
export function usageMetricAggregate(metric: string, expression: string): string {
  if (metric === "positive_latency_min") return "COALESCE(MIN(NULLIF(" + expression + ",0)),0)";
  if (metric === "positive_latency_max") return "MAX(" + expression + ")";
  return "SUM(" + expression + ")";
}
const sums = (alias: string) => USAGE_ROLLUP_METRICS.map(c => usageMetricAggregate(c,alias + "." + c) + " AS " + c).join(",");
const unequal = (a: string, b: string) => USAGE_ROLLUP_METRICS.map(c =>
  c === "cost_usd" || c === "cost_saved_usd"
    ? "ABS(COALESCE(" + a + "." + c + ",0)-COALESCE(" + b + "." + c + ",0)) > 0.00000001 * MAX(1,ABS(COALESCE(" + a + "." + c + ",0)),ABS(COALESCE(" + b + "." + c + ",0)))"
    : "COALESCE(" + a + "." + c + ",0)<>COALESCE(" + b + "." + c + ",0)"
).join(" OR ");

export const USAGE_ROLLUP_VERIFY_SQL = `WITH
 raw_expected AS (
   SELECT (u.created_at/3600000)*3600000 AS hour_start, ${usageDimensionKey("u")} AS dimension_key,
     ${usageMetricExpressions("u").map((e,i) => usageMetricAggregate(USAGE_ROLLUP_METRICS[i],e) + " AS " + USAGE_ROLLUP_METRICS[i]).join(",")}
   FROM usage u JOIN usage_rollup_receipts r ON r.id=u.id
   WHERE NOT EXISTS (SELECT 1 FROM usage_rollup_archived_hours a WHERE a.hour_start=(u.created_at/3600000)*3600000)
   GROUP BY hour_start,dimension_key
 ), hourly_keys AS (
   SELECT hour_start,dimension_key FROM raw_expected UNION
   SELECT hour_start,dimension_key FROM usage_hourly_rollups h
   WHERE NOT EXISTS (SELECT 1 FROM usage_rollup_archived_hours a WHERE a.hour_start=h.hour_start)
 ), month_expected AS (
   SELECT CAST(strftime('%s',h.hour_start/1000,'unixepoch','+480 minutes','start of month','-480 minutes') AS INTEGER)*1000 AS month_start,
     dimension_key, ${sums("h")} FROM usage_hourly_rollups h GROUP BY month_start,dimension_key
 ), month_keys AS (
   SELECT month_start,dimension_key FROM month_expected UNION SELECT month_start,dimension_key FROM usage_monthly_rollups
 ), represented AS (
   SELECT strftime('%Y-%m-%d',h.hour_start/1000,'unixepoch','+480 minutes') AS date,
     COALESCE(device_id,'') AS device_id,COALESCE(provider_id,'') AS provider_id,COALESCE(model,'') AS model,request_count,input_tokens,output_tokens,total_tokens,cost_usd FROM usage_hourly_rollups h
   UNION ALL
   SELECT strftime('%Y-%m-%d',u.created_at/1000,'unixepoch','+480 minutes'),
     COALESCE(device_id,''),COALESCE(provider_id,''),COALESCE(model,''),1,input_tokens,output_tokens,total_tokens,cost_usd FROM usage u
   WHERE NOT EXISTS (SELECT 1 FROM usage_rollup_receipts r WHERE r.id=u.id)
 ), represented_days AS (
   SELECT date,device_id,provider_id,model,SUM(request_count) AS request_count,
     SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,
     SUM(total_tokens) AS total_tokens,SUM(cost_usd) AS cost_usd
   FROM represented GROUP BY date,device_id,provider_id,model
 ), legacy_days AS (
   SELECT date,COALESCE(device_id,'') AS device_id,COALESCE(provider_id,'') AS provider_id,COALESCE(model,'') AS model,SUM(request_count) AS request_count,
     SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,
     SUM(total_tokens) AS total_tokens,SUM(cost_usd) AS cost_usd
   FROM daily_stats GROUP BY date,COALESCE(device_id,''),COALESCE(provider_id,''),COALESCE(model,'')
 )
 SELECT
   (SELECT COUNT(*) FROM usage u WHERE NOT EXISTS (SELECT 1 FROM usage_rollup_receipts r WHERE r.id=u.id)) AS unprocessed,
   (SELECT COUNT(*) FROM usage WHERE created_at IS NULL OR created_at<0 OR typeof(created_at)<>'integer') AS invalid_timestamps,
   (SELECT COUNT(*) FROM usage_rollup_receipts r LEFT JOIN usage u ON u.id=r.id
     WHERE (u.id IS NOT NULL AND (r.request_id IS NOT u.request_id OR r.device_id IS NOT u.device_id OR r.created_at IS NOT u.created_at))
       OR (u.id IS NULL AND NOT EXISTS (SELECT 1 FROM usage_rollup_archived_hours a WHERE a.hour_start=(r.created_at/3600000)*3600000))) AS receipt_mismatches,
   (SELECT COUNT(*) FROM hourly_keys k LEFT JOIN raw_expected e USING(hour_start,dimension_key)
     LEFT JOIN usage_hourly_rollups h USING(hour_start,dimension_key)
     WHERE e.hour_start IS NULL OR h.hour_start IS NULL OR ${unequal("e","h")}) AS hourly_mismatches,
   (SELECT COUNT(*) FROM month_keys k LEFT JOIN month_expected e USING(month_start,dimension_key)
     LEFT JOIN usage_monthly_rollups h USING(month_start,dimension_key)
     WHERE e.month_start IS NULL OR h.month_start IS NULL OR ${unequal("e","h")}) AS monthly_mismatches,
   (SELECT COUNT(*) FROM (
     SELECT hour_start,SUM(n) AS delta FROM (
       SELECT (created_at/3600000)*3600000 AS hour_start,COUNT(*) AS n FROM usage_rollup_receipts GROUP BY hour_start
       UNION ALL SELECT hour_start,-SUM(request_count) FROM usage_hourly_rollups GROUP BY hour_start
     ) GROUP BY hour_start HAVING SUM(n)<>0
   )) AS receipt_count_mismatches,
   (SELECT COUNT(*) FROM legacy_days d LEFT JOIN represented_days r
     ON r.date=d.date AND r.device_id IS d.device_id AND r.provider_id IS d.provider_id AND r.model IS d.model
     WHERE d.request_count>COALESCE(r.request_count,0) OR d.input_tokens>COALESCE(r.input_tokens,0)
       OR d.output_tokens>COALESCE(r.output_tokens,0) OR d.total_tokens>COALESCE(r.total_tokens,0)
       OR d.cost_usd>COALESCE(r.cost_usd,0)+0.00000001*MAX(1,ABS(d.cost_usd),ABS(COALESCE(r.cost_usd,0)))) AS missing_history
`;
export const USAGE_ROLLUP_VERIFICATION_FAILURE_SQL = "EXISTS (SELECT 1 FROM (" + USAGE_ROLLUP_VERIFY_SQL +
  ") v WHERE v.unprocessed<>0 OR v.invalid_timestamps<>0 OR v.receipt_mismatches<>0 OR v.hourly_mismatches<>0 OR v.monthly_mismatches<>0 OR v.receipt_count_mismatches<>0 OR v.missing_history<>0)";

function aggregateInsert(table: string, timeColumn: string, timeExpression: string): string {
  return "INSERT INTO " + table + " (" + timeColumn + ",dimension_key," + dims + "," + metrics + ") SELECT " +
    timeExpression + "," + usageDimensionKey("u") + "," + USAGE_ROLLUP_DIMENSIONS.map(c => "u." + c).join(",") + "," +
    usageMetricExpressions("u").join(",") + " FROM usage u WHERE u.id=NEW.id ON CONFLICT(" + timeColumn +
    ",dimension_key) DO UPDATE SET " + USAGE_ROLLUP_METRICS.map(c => c + "=" + (c === "positive_latency_min" ? "CASE WHEN " + table + "." + c + "=0 THEN excluded." + c + " WHEN excluded." + c + "=0 THEN " + table + "." + c + " ELSE MIN(" + table + "." + c + ",excluded." + c + ") END" : c === "positive_latency_max" ? "MAX(" + table + "." + c + ",excluded." + c + ")" : table + "." + c + "+excluded." + c)).join(",") + ";";
}
const immutable = (table: string) => ["UPDATE", "DELETE"].map(action =>
  "CREATE TRIGGER IF NOT EXISTS " + table + "_no_" + action.toLowerCase() + " BEFORE " + action + " ON " + table +
  " BEGIN SELECT RAISE(ABORT,'usage_rollup_immutable'); END");
export const USAGE_ROLLUP_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS usage_daily_rebuild_history_guard BEFORE DELETE ON daily_stats BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM (SELECT SUM(request_count) AS request_count,
      SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(total_tokens) AS total_tokens,SUM(cost_usd) AS cost_usd
      FROM (SELECT h.request_count,h.input_tokens,h.output_tokens,h.total_tokens,h.cost_usd FROM usage_hourly_rollups h
        WHERE h.hour_start>=CAST(strftime('%s',OLD.date,'-480 minutes') AS INTEGER)*1000
          AND h.hour_start<CAST(strftime('%s',OLD.date,'-480 minutes') AS INTEGER)*1000+86400000
          AND (h.device_id=COALESCE(OLD.device_id,'') OR (h.device_id IS NULL AND COALESCE(OLD.device_id,'')='')) AND COALESCE(h.provider_id,'')=COALESCE(OLD.provider_id,'') AND COALESCE(h.model,'')=COALESCE(OLD.model,'')
        UNION ALL SELECT 1,u.input_tokens,u.output_tokens,u.total_tokens,u.cost_usd FROM usage u
        WHERE u.created_at>=CAST(strftime('%s',OLD.date,'-480 minutes') AS INTEGER)*1000
          AND u.created_at<CAST(strftime('%s',OLD.date,'-480 minutes') AS INTEGER)*1000+86400000
          AND (u.device_id=COALESCE(OLD.device_id,'') OR (u.device_id IS NULL AND COALESCE(OLD.device_id,'')='')) AND COALESCE(u.provider_id,'')=COALESCE(OLD.provider_id,'') AND COALESCE(u.model,'')=COALESCE(OLD.model,'')
          AND NOT EXISTS(SELECT 1 FROM usage_rollup_receipts r WHERE r.id=u.id))) r
      WHERE COALESCE(OLD.request_count,0)>COALESCE(r.request_count,0) OR COALESCE(OLD.input_tokens,0)>COALESCE(r.input_tokens,0)
        OR COALESCE(OLD.output_tokens,0)>COALESCE(r.output_tokens,0) OR COALESCE(OLD.total_tokens,0)>COALESCE(r.total_tokens,0)
        OR COALESCE(OLD.cost_usd,0)>COALESCE(r.cost_usd,0)+0.00000001*MAX(1,ABS(COALESCE(OLD.cost_usd,0)),ABS(COALESCE(r.cost_usd,0))))
      THEN RAISE(ABORT,'usage_history_missing') END;
  END`,

  "CREATE INDEX IF NOT EXISTS idx_usage_rollup_receipt_request ON usage_rollup_receipts(request_id)",
  "CREATE INDEX IF NOT EXISTS idx_usage_rollup_receipt_created ON usage_rollup_receipts(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_usage_rollup_cleanup_page ON usage(created_at,id)",
  "CREATE INDEX IF NOT EXISTS idx_usage_hourly_device ON usage_hourly_rollups(device_id,hour_start)",
  "CREATE INDEX IF NOT EXISTS idx_usage_monthly_device ON usage_monthly_rollups(device_id,month_start)",
  ...immutable("usage_rollup_receipts"), ...immutable("usage_rollup_archived_hours"),
  "CREATE TRIGGER IF NOT EXISTS usage_cleanup_operation_conflict BEFORE INSERT ON usage_rollup_cleanup_operations WHEN EXISTS(SELECT 1 FROM usage_rollup_cleanup_operations WHERE operation_id=NEW.operation_id AND params_json<>NEW.params_json) BEGIN SELECT RAISE(ABORT,'usage_cleanup_operation_conflict'); END",
  "CREATE TRIGGER IF NOT EXISTS usage_cleanup_operation_no_delete BEFORE DELETE ON usage_rollup_cleanup_operations BEGIN SELECT RAISE(ABORT,'usage_rollup_immutable'); END",
  "CREATE TRIGGER IF NOT EXISTS usage_cleanup_operation_no_replace BEFORE INSERT ON usage_rollup_cleanup_operations WHEN EXISTS(SELECT 1 FROM usage_rollup_cleanup_operations WHERE operation_id=NEW.operation_id) AND NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'usage_rollup_immutable'); END",
  "CREATE TRIGGER IF NOT EXISTS usage_cleanup_operation_finish_guard BEFORE UPDATE ON usage_rollup_cleanup_operations WHEN OLD.result_json IS NOT NULL OR NEW.result_json IS NULL OR OLD.operation_id IS NOT NEW.operation_id OR OLD.params_json IS NOT NEW.params_json OR OLD.nonce IS NOT NEW.nonce OR NOT EXISTS(SELECT 1 FROM usage_rollup_cleanup_context WHERE id=1) BEGIN SELECT RAISE(ABORT,'usage_rollup_immutable'); END",
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_receipt_insert_guard BEFORE INSERT ON usage_rollup_receipts BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM usage_rollup_receipts WHERE id=NEW.id)
      OR NOT EXISTS(SELECT 1 FROM usage u WHERE u.id=NEW.id AND u.request_id IS NEW.request_id
        AND u.device_id IS NEW.device_id AND u.created_at IS NEW.created_at AND u.created_at>=0 AND typeof(u.created_at)='integer')
      THEN RAISE(ABORT,'usage_rollup_invalid_receipt') END;
    INSERT INTO usage_rollup_write_context(id,usage_id) VALUES(1,NEW.id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_write_context_guard BEFORE INSERT ON usage_rollup_write_context BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM usage_rollup_receipts WHERE id=NEW.usage_id)
      OR NOT EXISTS(SELECT 1 FROM usage WHERE id=NEW.usage_id)
      THEN RAISE(ABORT,'usage_rollup_invalid_write_context') END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_write_context_no_update BEFORE UPDATE ON usage_rollup_write_context
    BEGIN SELECT RAISE(ABORT,'usage_rollup_immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_receipt_aggregate AFTER INSERT ON usage_rollup_receipts BEGIN
    ${aggregateInsert("usage_hourly_rollups","hour_start","(u.created_at/3600000)*3600000")}
    ${aggregateInsert("usage_monthly_rollups","month_start","CAST(strftime('%s',u.created_at/1000,'unixepoch','+480 minutes','start of month','-480 minutes') AS INTEGER)*1000")}
    DELETE FROM usage_rollup_write_context WHERE id=1;
  END`,
  ...["usage_hourly_rollups","usage_monthly_rollups"].flatMap(table => [
    ...["INSERT","UPDATE"].map(action => "CREATE TRIGGER IF NOT EXISTS " + table + "_guard_" + action.toLowerCase() +
      " BEFORE " + action + " ON " + table + " WHEN NOT EXISTS(SELECT 1 FROM usage_rollup_write_context c JOIN usage_rollup_receipts r ON r.id=c.usage_id WHERE c.id=1) BEGIN SELECT RAISE(ABORT,'usage_rollup_immutable'); END"),
    "CREATE TRIGGER IF NOT EXISTS " + table + "_guard_delete BEFORE DELETE ON " + table + " BEGIN SELECT RAISE(ABORT,'usage_rollup_immutable'); END",
  ]),
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_raw_insert_guard BEFORE INSERT ON usage BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM usage_rollup_receipts r WHERE r.id=NEW.id)
      OR EXISTS(SELECT 1 FROM usage_rollup_receipts r WHERE r.request_id=NEW.request_id
        AND NOT EXISTS(SELECT 1 FROM usage u WHERE u.id=r.id))
      THEN RAISE(ABORT,'usage_request_id_archived') END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_raw_insert AFTER INSERT ON usage BEGIN
    INSERT INTO usage_rollup_receipts(id,request_id,device_id,created_at) VALUES(NEW.id,NEW.request_id,NEW.device_id,NEW.created_at);
  END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_raw_update_guard BEFORE UPDATE ON usage
    WHEN EXISTS(SELECT 1 FROM usage_rollup_receipts r WHERE r.id=OLD.id OR r.id=NEW.id)
      OR EXISTS(SELECT 1 FROM usage_rollup_receipts r WHERE r.request_id=NEW.request_id AND NOT EXISTS(SELECT 1 FROM usage u WHERE u.id=r.id))
    BEGIN SELECT RAISE(ABORT,'usage_rollup_immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_cleanup_context_guard BEFORE INSERT ON usage_rollup_cleanup_context BEGIN
    SELECT CASE WHEN NEW.before_ms<=0 OR NEW.before_ms%3600000<>0 OR ${USAGE_ROLLUP_VERIFICATION_FAILURE_SQL}
      THEN RAISE(ABORT,'usage_rollup_verification_required') END;
  END`,
  ...["UPDATE"].map(action => "CREATE TRIGGER IF NOT EXISTS usage_rollup_cleanup_context_no_update BEFORE " + action +
    " ON usage_rollup_cleanup_context BEGIN SELECT RAISE(ABORT,'usage_rollup_immutable'); END"),
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_cleanup_context_close BEFORE DELETE ON usage_rollup_cleanup_context
    WHEN EXISTS(SELECT 1 FROM usage_rollup_cleanup_permits) BEGIN SELECT RAISE(ABORT,'usage_cleanup_incomplete'); END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_cleanup_permit_guard BEFORE INSERT ON usage_rollup_cleanup_permits BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM usage u CROSS JOIN usage_rollup_cleanup_context c
      WHERE c.id=1 AND u.id=NEW.usage_id AND u.created_at<c.before_ms AND ${USAGE_CLEANUP_ELIGIBLE_SQL}
      AND (SELECT COUNT(*) FROM usage_rollup_cleanup_permits)<c.batch_limit)
      THEN RAISE(ABORT,'usage_cleanup_not_authorized') END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_raw_delete_guard BEFORE DELETE ON usage BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM usage u CROSS JOIN usage_rollup_cleanup_context c
      JOIN usage_rollup_cleanup_permits p ON p.usage_id=u.id
      WHERE u.id=OLD.id AND c.id=1 AND u.created_at<c.before_ms AND ${USAGE_CLEANUP_ELIGIBLE_SQL})
      THEN RAISE(ABORT,'usage_cleanup_not_authorized') END;
    INSERT INTO usage_rollup_archived_hours(hour_start) SELECT (OLD.created_at/3600000)*3600000
      WHERE NOT EXISTS(SELECT 1 FROM usage_rollup_archived_hours WHERE hour_start=(OLD.created_at/3600000)*3600000);
  END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_cleanup_permit_no_update BEFORE UPDATE ON usage_rollup_cleanup_permits
    BEGIN SELECT RAISE(ABORT,'usage_rollup_immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_cleanup_permit_close BEFORE DELETE ON usage_rollup_cleanup_permits
    WHEN EXISTS(SELECT 1 FROM usage WHERE id=OLD.usage_id) BEGIN SELECT RAISE(ABORT,'usage_cleanup_incomplete'); END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_archived_hour_guard BEFORE INSERT ON usage_rollup_archived_hours BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM usage_rollup_archived_hours WHERE hour_start=NEW.hour_start)
      OR NOT EXISTS(SELECT 1 FROM usage_rollup_cleanup_permits p JOIN usage u ON u.id=p.usage_id
        JOIN usage_rollup_cleanup_context c ON c.id=1 WHERE (u.created_at/3600000)*3600000=NEW.hour_start
          AND u.created_at<c.before_ms AND ${USAGE_CLEANUP_ELIGIBLE_SQL})
      THEN RAISE(ABORT,'usage_cleanup_not_authorized') END;
  END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_raw_deleted AFTER DELETE ON usage BEGIN
    DELETE FROM usage_rollup_cleanup_permits WHERE usage_id=OLD.id;
  END`,
] as const;
