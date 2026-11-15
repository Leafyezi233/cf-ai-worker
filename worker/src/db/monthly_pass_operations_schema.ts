export const MONTHLY_PASS_OPERATIONS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS monthly_pass_operations (
    actor_scope TEXT NOT NULL CHECK(length(actor_scope)>0),
    operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 200),
    action TEXT NOT NULL CHECK(action IN ('issue','renew')),
    target_id TEXT NOT NULL,
    plan_id TEXT,
    candidate_id TEXT NOT NULL,
    ip TEXT,
    created_at INTEGER NOT NULL,
    result_json TEXT,
    error_code TEXT CHECK(error_code IN ('monthly_account_not_found','monthly_plan_not_found','monthly_pass_already_active','monthly_subscription_not_found','monthly_subscription_not_current')),
    PRIMARY KEY(actor_scope,operation_id),
    UNIQUE(operation_id),
    CHECK((action='issue' AND plan_id IS NOT NULL) OR (action='renew' AND plan_id IS NULL)),
    CHECK(result_json IS NULL OR error_code IS NULL)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_monthly_pass_accounts_subscription ON monthly_pass_accounts(subscription_id)",
  `CREATE TRIGGER IF NOT EXISTS monthly_pass_operation_immutable BEFORE UPDATE ON monthly_pass_operations
    WHEN OLD.result_json IS NOT NULL OR OLD.error_code IS NOT NULL BEGIN
    SELECT RAISE(ABORT,'monthly operation evidence is immutable');
  END`,
  `CREATE TRIGGER IF NOT EXISTS monthly_pass_operation_no_delete BEFORE DELETE ON monthly_pass_operations BEGIN
    SELECT RAISE(ABORT,'monthly operation evidence is durable');
  END`,
  `CREATE TRIGGER IF NOT EXISTS monthly_pass_operation_apply AFTER INSERT ON monthly_pass_operations BEGIN
    UPDATE monthly_pass_operations SET error_code=CASE
      WHEN NEW.action='issue' AND NOT EXISTS(SELECT 1 FROM devices WHERE id=NEW.target_id AND revoked_at IS NULL) THEN 'monthly_account_not_found'
      WHEN NEW.action='issue' AND NOT EXISTS(SELECT 1 FROM monthly_pass_plans WHERE id=NEW.plan_id AND enabled=1) THEN 'monthly_plan_not_found'
      WHEN NEW.action='issue' AND EXISTS(SELECT 1 FROM monthly_pass_accounts a JOIN monthly_pass_subscriptions s ON s.id=a.subscription_id WHERE a.device_id=NEW.target_id AND s.enabled=1 AND s.expires_at>NEW.created_at) THEN 'monthly_pass_already_active'
      WHEN NEW.action='renew' AND NOT EXISTS(SELECT 1 FROM monthly_pass_subscriptions WHERE id=NEW.target_id) THEN 'monthly_subscription_not_found'
      WHEN NEW.action='renew' AND NOT EXISTS(SELECT 1 FROM monthly_pass_accounts WHERE subscription_id=NEW.target_id) THEN 'monthly_subscription_not_current'
      ELSE NULL END
      WHERE actor_scope=NEW.actor_scope AND operation_id=NEW.operation_id;

    INSERT INTO monthly_pass_subscriptions(id,device_id,plan_id,plan_name,enabled,limits_json,groups_json,starts_at,expires_at,five_hour_start,created_at,updated_at)
      SELECT NEW.candidate_id,NEW.target_id,p.id,p.name,1,p.limits_json,p.groups_json,NEW.created_at,NEW.created_at+2592000000,NULL,NEW.created_at,NEW.created_at
      FROM monthly_pass_plans p WHERE NEW.action='issue' AND p.id=NEW.plan_id
      AND EXISTS(SELECT 1 FROM monthly_pass_operations WHERE actor_scope=NEW.actor_scope AND operation_id=NEW.operation_id AND error_code IS NULL);
    INSERT INTO monthly_pass_subscriptions(id,device_id,plan_id,plan_name,enabled,limits_json,groups_json,starts_at,expires_at,five_hour_start,created_at,updated_at)
      SELECT NEW.candidate_id,s.device_id,s.plan_id,s.plan_name,1,s.limits_json,s.groups_json,NEW.created_at,NEW.created_at+2592000000,NULL,NEW.created_at,NEW.created_at
      FROM monthly_pass_subscriptions s WHERE NEW.action='renew' AND s.id=NEW.target_id AND s.expires_at<=NEW.created_at
      AND EXISTS(SELECT 1 FROM monthly_pass_operations WHERE actor_scope=NEW.actor_scope AND operation_id=NEW.operation_id AND error_code IS NULL);
    SELECT CASE WHEN NEW.action='renew'
      AND EXISTS(SELECT 1 FROM monthly_pass_operations WHERE actor_scope=NEW.actor_scope AND operation_id=NEW.operation_id AND error_code IS NULL)
      AND EXISTS(SELECT 1 FROM monthly_pass_subscriptions WHERE id=NEW.target_id AND expires_at<=NEW.created_at)
      AND changes()<>1 THEN RAISE(ABORT,'monthly replacement insertion did not confirm') END;
    UPDATE monthly_pass_subscriptions SET expires_at=expires_at+2592000000,enabled=1,updated_at=NEW.created_at
      WHERE NEW.action='renew' AND id=NEW.target_id AND expires_at>NEW.created_at
      AND EXISTS(SELECT 1 FROM monthly_pass_accounts WHERE subscription_id=NEW.target_id)
      AND EXISTS(SELECT 1 FROM monthly_pass_operations WHERE actor_scope=NEW.actor_scope AND operation_id=NEW.operation_id AND error_code IS NULL);
    -- changes() belongs to the immediately preceding conditional UPDATE, not a later audit.
    UPDATE monthly_pass_operations SET error_code='monthly_subscription_not_current'
      WHERE actor_scope=NEW.actor_scope AND operation_id=NEW.operation_id AND error_code IS NULL
      AND NEW.action='renew' AND changes()<>1
      AND EXISTS(SELECT 1 FROM monthly_pass_subscriptions WHERE id=NEW.target_id AND expires_at>NEW.created_at);
    INSERT INTO monthly_pass_accounts(device_id,subscription_id,wallet_fallback)
      SELECT device_id,id,0 FROM monthly_pass_subscriptions WHERE id=NEW.candidate_id
      ON CONFLICT(device_id) DO UPDATE SET subscription_id=excluded.subscription_id;

    UPDATE monthly_pass_operations SET result_json=(
      SELECT json_object('id',s.id,'device_id',s.device_id,'plan_id',s.plan_id,'plan_name',s.plan_name,
        'enabled',s.enabled,'starts_at',s.starts_at,'expires_at',s.expires_at,'five_hour_start',s.five_hour_start,
        'created_at',s.created_at,'updated_at',s.updated_at,'limits',json(s.limits_json),
        'service_group_ids',json(s.groups_json))
      FROM monthly_pass_subscriptions s JOIN monthly_pass_accounts a ON a.subscription_id=s.id
      WHERE s.id=CASE WHEN NEW.action='issue' OR EXISTS(SELECT 1 FROM monthly_pass_subscriptions WHERE id=NEW.target_id AND expires_at<=NEW.created_at) THEN NEW.candidate_id ELSE NEW.target_id END)
      WHERE actor_scope=NEW.actor_scope AND operation_id=NEW.operation_id AND error_code IS NULL;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM monthly_pass_operations WHERE actor_scope=NEW.actor_scope AND operation_id=NEW.operation_id AND error_code IS NULL AND result_json IS NULL)
      THEN RAISE(ABORT,'monthly operation mutation did not confirm') END;
    INSERT INTO audit_logs(actor_type,ip,action,target_type,target_id,summary,details_json,created_at)
      SELECT 'admin',NEW.ip,'monthly_pass.'||NEW.action,'monthly_subscription',json_extract(result_json,'$.id'),'Monthly pass '||NEW.action,
        json_object('operation_id',NEW.operation_id,'actor_scope',NEW.actor_scope,'previous_subscription_id',CASE WHEN NEW.action='renew' THEN NEW.target_id ELSE NULL END,
          'subscription_id',json_extract(result_json,'$.id'),'device_id',json_extract(result_json,'$.device_id'),
          'plan_id',json_extract(result_json,'$.plan_id'),'enabled',json_extract(result_json,'$.enabled'),
          'starts_at',json_extract(result_json,'$.starts_at'),'expires_at',json_extract(result_json,'$.expires_at')),NEW.created_at
      FROM monthly_pass_operations WHERE actor_scope=NEW.actor_scope AND operation_id=NEW.operation_id AND error_code IS NULL;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM monthly_pass_operations WHERE actor_scope=NEW.actor_scope AND operation_id=NEW.operation_id AND error_code IS NULL)
      AND changes()<>1 THEN RAISE(ABORT,'monthly operation audit did not confirm') END;
  END`,
];
