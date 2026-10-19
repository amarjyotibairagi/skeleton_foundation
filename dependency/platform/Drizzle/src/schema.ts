// SQL migrations are authoritative. This model mirrors the platform tables
// for Drizzle typing; migrations, function ACLs and RLS remain in SQL.
import { sql } from 'drizzle-orm'
import { bigint, boolean, check, customType, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, unique, uniqueIndex, uuid, varchar, type AnyPgColumn } from 'drizzle-orm/pg-core'

export const platformSchema = pgSchema('platform')
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const configDefinition = platformSchema.table('config_definition', {
  configKey: text('config_key').primaryKey(),
  kind: text('kind').notNull(),
  valueType: text('value_type').notNull(),
  label: text('label').notNull(),
  description: text('description').notNull().default(sql.raw("''::text")),
  category: text('category').notNull().default(sql.raw("'general'::text")),
  moduleCode: text('module_code'),
  defaultValue: jsonb('default_value').notNull(),
  minValue: numeric('min_value'),
  maxValue: numeric('max_value'),
  maxLength: integer('max_length'),
  allowedValues: jsonb('allowed_values'),
  scopes: text('scopes').array().notNull().default(sql.raw("ARRAY['platform'::text, 'plan'::text, 'tenant'::text]")),
  tenantEditable: boolean('tenant_editable').notNull().default(sql.raw("false")),
  isPublic: boolean('is_public').notNull().default(sql.raw("false")),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
}, (_table) => [
  check("config_definition_allowed_values_check", sql.raw("(allowed_values IS NULL OR jsonb_typeof(allowed_values) = 'array'::text)")),
  check("config_definition_category_check", sql.raw("(category ~ '^[a-z][a-z0-9_]{0,40}$'::text)")),
  check("config_definition_check", sql.raw("(kind <> 'feature'::text OR value_type = 'boolean'::text)")),
  check("config_definition_check1", sql.raw("(kind <> 'limit'::text OR value_type = 'integer'::text)")),
  check("config_definition_check2", sql.raw("(min_value IS NULL OR max_value IS NULL OR min_value <= max_value)")),
  check("config_definition_check3", sql.raw("(NOT tenant_editable OR ('tenant'::text = ANY (scopes)))")),
  check("config_definition_config_key_check", sql.raw("(config_key ~ '^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$'::text AND length(config_key) <= 96)")),
  check("config_definition_kind_check", sql.raw("(kind = ANY (ARRAY['feature'::text, 'limit'::text, 'setting'::text]))")),
  check("config_definition_label_check", sql.raw("(length(btrim(label)) >= 1 AND length(btrim(label)) <= 120)")),
  check("config_definition_max_length_check", sql.raw("(max_length IS NULL OR max_length >= 1 AND max_length <= 10000)")),
  check("config_definition_module_code_check", sql.raw("(module_code IS NULL OR module_code ~ '^[a-z][a-z0-9_]{1,40}$'::text)")),
  check("config_definition_scopes_check", sql.raw("(scopes <@ ARRAY['platform'::text, 'plan'::text, 'tenant'::text] AND cardinality(scopes) >= 1)")),
  check("config_definition_value_type_check", sql.raw("(value_type = ANY (ARRAY['boolean'::text, 'integer'::text, 'string'::text, 'string_list'::text]))")),
])

export type ConfigDefinition = typeof configDefinition.$inferSelect
export type NewConfigDefinition = typeof configDefinition.$inferInsert

export const configValue = platformSchema.table('config_value', {
  valueId: uuid('value_id').primaryKey().default(sql.raw("gen_random_uuid()")),
  scopeType: text('scope_type').notNull(),
  planId: uuid('plan_id').references((): AnyPgColumn => planCatalog.planId, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').references((): AnyPgColumn => tenantRegistry.tenantId, { onDelete: 'cascade' }),
  configKey: text('config_key').notNull().references((): AnyPgColumn => configDefinition.configKey, { onDelete: 'cascade' }),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references((): AnyPgColumn => platformUser.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
}, (_table) => [
  check("config_value_check", sql.raw("(scope_type = 'platform'::text AND plan_id IS NULL AND tenant_id IS NULL OR scope_type = 'plan'::text AND plan_id IS NOT NULL AND tenant_id IS NULL OR scope_type = 'tenant'::text AND tenant_id IS NOT NULL AND plan_id IS NULL)")),
  check("config_value_scope_type_check", sql.raw("(scope_type = ANY (ARRAY['platform'::text, 'plan'::text, 'tenant'::text]))")),
  index("config_value_plan_idx").using('btree', sql.raw("plan_id")).where(sql.raw("(plan_id IS NOT NULL)")),
  uniqueIndex("config_value_scope_uidx").using('btree', sql.raw("scope_type, COALESCE(plan_id, tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), config_key")),
  index("config_value_tenant_idx").using('btree', sql.raw("tenant_id")).where(sql.raw("(tenant_id IS NOT NULL)")),
])

export type ConfigValue = typeof configValue.$inferSelect
export type NewConfigValue = typeof configValue.$inferInsert

export const planCatalog = platformSchema.table('plan_catalog', {
  planId: uuid('plan_id').primaryKey().default(sql.raw("gen_random_uuid()")),
  planCode: text('plan_code').notNull(),
  displayName: text('display_name').notNull(),
  audience: text('audience').notNull(),
  entitlements: jsonb('entitlements').notNull().default(sql.raw("'{}'::jsonb")),
  version: integer('version').notNull().default(sql.raw("1")),
  isActive: boolean('is_active').notNull().default(sql.raw("true")),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  description: text('description').notNull().default(sql.raw("''::text")),
  priceMonthly: numeric('price_monthly', { precision: 12, scale: 2 }),
  highlights: jsonb('highlights').notNull().default(sql.raw("'[]'::jsonb")),
  sortOrder: integer('sort_order').notNull().default(sql.raw("100")),
}, (table) => [
  check("plan_catalog_audience_check", sql.raw("(audience = ANY (ARRAY['b2b'::text, 'b2c'::text, 'both'::text]))")),
  check("plan_catalog_entitlements_check", sql.raw("(jsonb_typeof(entitlements) = 'object'::text)")),
  check("plan_catalog_highlights_check", sql.raw("(jsonb_typeof(highlights) = 'array'::text)")),
  check("plan_catalog_plan_code_check", sql.raw("(plan_code ~ '^[a-z][a-z0-9_]{1,62}$'::text)")),
  unique("plan_catalog_plan_code_key").on(table.planCode),
  check("plan_catalog_price_monthly_check", sql.raw("(price_monthly IS NULL OR price_monthly >= 0::numeric)")),
  check("plan_catalog_version_check", sql.raw("(version > 0)")),
])

export type PlanCatalog = typeof planCatalog.$inferSelect
export type NewPlanCatalog = typeof planCatalog.$inferInsert

export const platformAudit = platformSchema.table('platform_audit', {
  id: uuid('id').primaryKey().default(sql.raw("gen_random_uuid()")),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().default(sql.raw("now()")),
  userId: uuid('user_id').references((): AnyPgColumn => platformUser.id, { onDelete: 'set null' }),
  feature: varchar('feature', { length: 100 }).notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  status: varchar('status', { length: 50 }).notNull(),
  tenantId: uuid('tenant_id').references((): AnyPgColumn => tenantRegistry.tenantId, { onDelete: 'set null' }),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  correlationId: uuid('correlation_id'),
  policyDecision: text('policy_decision'),
}, (_table) => [
  index("platform_audit_tenant_timestamp_idx").using('btree', sql.raw("tenant_id, \"timestamp\" DESC")).where(sql.raw("(tenant_id IS NOT NULL)")),
  index("platform_audit_timestamp_idx").using('btree', sql.raw("\"timestamp\" DESC")),
])

export type PlatformAudit = typeof platformAudit.$inferSelect
export type NewPlatformAudit = typeof platformAudit.$inferInsert

export const platformOperatorInvitation = platformSchema.table('platform_operator_invitation', {
  invitationId: uuid('invitation_id').primaryKey().default(sql.raw("gen_random_uuid()")),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => platformUser.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  issuedBy: uuid('issued_by').references((): AnyPgColumn => platformUser.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  check("platform_operator_invitation_check", sql.raw("(expires_at > created_at)")),
  check("platform_operator_invitation_token_hash_check", sql.raw("(token_hash ~ '^[0-9a-f]{64}$'::text)")),
  unique("platform_operator_invitation_token_hash_key").on(table.tokenHash),
])

export type PlatformOperatorInvitation = typeof platformOperatorInvitation.$inferSelect
export type NewPlatformOperatorInvitation = typeof platformOperatorInvitation.$inferInsert

export const platformSession = platformSchema.table('platform_session', {
  id: uuid('id').primaryKey().default(sql.raw("gen_random_uuid()")),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => platformUser.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  csrfHash: text('csrf_hash').notNull(),
  iapSubject: text('iap_subject'),
  iapEmail: text('iap_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
}, (table) => [
  unique("platform_session_token_hash_key").on(table.tokenHash),
  index("platform_session_expires_at_idx").using('btree', sql.raw("expires_at")),
  index("platform_session_user_id_idx").using('btree', sql.raw("user_id")),
])

export type PlatformSession = typeof platformSession.$inferSelect
export type NewPlatformSession = typeof platformSession.$inferInsert

export const platformUser = platformSchema.table('platform_user', {
  id: uuid('id').primaryKey().default(sql.raw("gen_random_uuid()")),
  username: varchar('username', { length: 255 }).notNull(),
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  role: varchar('role', { length: 50 }).notNull(),
  identityProviderSubject: text('identity_provider_subject'),
  emailNormalized: text('email_normalized'),
  displayName: text('display_name'),
  department: text('department'),
  employmentStatus: text('employment_status').notNull().default(sql.raw("'active'::text")),
  lastAuthenticatedAt: timestamp('last_authenticated_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(sql.raw("true")),
}, (table) => [
  check("platform_user_employment_status_check", sql.raw("(employment_status = ANY (ARRAY['invited'::text, 'active'::text, 'suspended'::text, 'departed'::text]))")),
  check("platform_user_password_hash_format_check", sql.raw("(password_hash IS NULL OR password_hash ~~ '$argon2id$%'::text)")),
  check("platform_user_role_check", sql.raw("(role::text = ANY (ARRAY['platform_owner'::character varying, 'platform_admin'::character varying, 'platform_viewer'::character varying]::text[]))")),
  unique("platform_user_username_key").on(table.username),
  uniqueIndex("platform_user_email_uidx").using('btree', sql.raw("lower(email_normalized)")).where(sql.raw("(email_normalized IS NOT NULL)")),
  uniqueIndex("platform_user_idp_subject_uidx").using('btree', sql.raw("identity_provider_subject")).where(sql.raw("(identity_provider_subject IS NOT NULL)")),
])

export type PlatformUser = typeof platformUser.$inferSelect
export type NewPlatformUser = typeof platformUser.$inferInsert

export const platformWebauthnChallenge = platformSchema.table('platform_webauthn_challenge', {
  challengeId: uuid('challenge_id').primaryKey().default(sql.raw("gen_random_uuid()")),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => platformUser.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references((): AnyPgColumn => platformSession.id, { onDelete: 'cascade' }),
  challenge: text('challenge').notNull(),
  purpose: text('purpose').notNull(),
  expectedOrigin: text('expected_origin').notNull(),
  expectedRpId: text('expected_rp_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
}, (_table) => [
  check("platform_webauthn_challenge_purpose_check", sql.raw("(purpose = ANY (ARRAY['registration'::text, 'authentication'::text, 'step_up'::text]))")),
  index("platform_webauthn_challenge_expiry_idx").using('btree', sql.raw("expires_at")),
  index("platform_webauthn_challenge_lookup_idx").using('btree', sql.raw("challenge_id, user_id, purpose, expires_at")).where(sql.raw("(consumed_at IS NULL)")),
])

export type PlatformWebauthnChallenge = typeof platformWebauthnChallenge.$inferSelect
export type NewPlatformWebauthnChallenge = typeof platformWebauthnChallenge.$inferInsert

export const platformWebauthnCredential = platformSchema.table('platform_webauthn_credential', {
  credentialId: text('credential_id').primaryKey(),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => platformUser.id, { onDelete: 'cascade' }),
  publicKey: bytea('public_key').notNull(),
  counter: bigint('counter', { mode: 'bigint' }).notNull().default(sql.raw("0")),
  transports: text('transports').array(),
  aaguid: text('aaguid'),
  isEnabled: boolean('is_enabled').notNull().default(sql.raw("true")),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (_table) => [
  index("platform_webauthn_user_idx").using('btree', sql.raw("user_id, is_enabled")),
])

export type PlatformWebauthnCredential = typeof platformWebauthnCredential.$inferSelect
export type NewPlatformWebauthnCredential = typeof platformWebauthnCredential.$inferInsert

export const platformSchemaMigration = platformSchema.table('schema_migration', {
  migrationKey: text('migration_key').primaryKey(),
  migrationScope: text('migration_scope').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  appliedBy: text('applied_by').notNull().default(sql.raw("SESSION_USER")),
  sourceFile: text('source_file'),
  checksum: text('checksum'),
}, (_table) => [
  check("schema_migration_migration_scope_check", sql.raw("(migration_scope = ANY (ARRAY['platform'::text, 'consumer'::text, 'tenant'::text, 'grants'::text]))")),
])

export type PlatformSchemaMigration = typeof platformSchemaMigration.$inferSelect
export type NewPlatformSchemaMigration = typeof platformSchemaMigration.$inferInsert

export const tenantBranding = platformSchema.table('tenant_branding', {
  tenantId: uuid('tenant_id').primaryKey().references((): AnyPgColumn => tenantRegistry.tenantId, { onDelete: 'cascade' }),
  logoUrl: text('logo_url'),
  primaryColor: text('primary_color').notNull().default(sql.raw("'#2563eb'::text")),
  secondaryColor: text('secondary_color').notNull().default(sql.raw("'#0f172a'::text")),
  loginBackground: text('login_background'),
  loginMessage: text('login_message'),
  defaultLocale: text('default_locale').notNull().default(sql.raw("'en'::text")),
  safeMetadata: jsonb('safe_metadata').notNull().default(sql.raw("'{}'::jsonb")),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
}, (_table) => [
  check("tenant_branding_default_locale_check", sql.raw("(default_locale ~ '^[a-z]{2}(?:-[A-Z]{2})?$'::text)")),
  check("tenant_branding_primary_color_check", sql.raw("(primary_color ~ '^#[0-9A-Fa-f]{6}$'::text)")),
  check("tenant_branding_safe_metadata_check", sql.raw("(jsonb_typeof(safe_metadata) = 'object'::text)")),
  check("tenant_branding_secondary_color_check", sql.raw("(secondary_color ~ '^#[0-9A-Fa-f]{6}$'::text)")),
])

export type TenantBranding = typeof tenantBranding.$inferSelect
export type NewTenantBranding = typeof tenantBranding.$inferInsert

export const tenantDomain = platformSchema.table('tenant_domain', {
  domainId: uuid('domain_id').primaryKey().default(sql.raw("gen_random_uuid()")),
  tenantId: uuid('tenant_id').notNull().references((): AnyPgColumn => tenantRegistry.tenantId, { onDelete: 'restrict' }),
  hostname: text('hostname').notNull(),
  subdomain: text('subdomain').notNull(),
  isPrimary: boolean('is_primary').notNull().default(sql.raw("false")),
  status: text('status').notNull().default(sql.raw("'pending'::text")),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
}, (_table) => [
  check("tenant_domain_hostname_check", sql.raw("(hostname = lower(hostname))")),
  check("tenant_domain_hostname_check1", sql.raw("(hostname ~ '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$'::text)")),
  check("tenant_domain_status_check", sql.raw("(status = ANY (ARRAY['pending'::text, 'active'::text, 'disabled'::text, 'failed'::text]))")),
  check("tenant_domain_subdomain_check", sql.raw("(subdomain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'::text)")),
  uniqueIndex("tenant_domain_hostname_uidx").using('btree', sql.raw("lower(hostname)")),
  uniqueIndex("tenant_domain_one_primary_uidx").using('btree', sql.raw("tenant_id")).where(sql.raw("is_primary")),
  uniqueIndex("tenant_domain_subdomain_uidx").using('btree', sql.raw("lower(subdomain)")),
])

export type TenantDomain = typeof tenantDomain.$inferSelect
export type NewTenantDomain = typeof tenantDomain.$inferInsert

export const tenantIntegration = platformSchema.table('tenant_integration', {
  integrationId: uuid('integration_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references((): AnyPgColumn => tenantRegistry.tenantId, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  provider: text('provider').notNull(),
  displayName: text('display_name').notNull(),
  settings: jsonb('settings').notNull(),
  secretCiphertext: text('secret_ciphertext').notNull(),
  settingsFingerprint: text('settings_fingerprint').notNull(),
  status: text('status').notNull().default(sql.raw("'draft'::text")),
  lastTestAt: timestamp('last_test_at', { withTimezone: true }),
  lastTestOk: boolean('last_test_ok'),
  lastTestReport: jsonb('last_test_report'),
  testedFingerprint: text('tested_fingerprint'),
  createdBy: text('created_by').notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
}, (_table) => [
  check("tenant_integration_check", sql.raw("((kind = 'storage'::text) = (provider = 's3'::text))")),
  check("tenant_integration_display_name_check", sql.raw("(length(btrim(display_name)) >= 1 AND length(btrim(display_name)) <= 120)")),
  check("tenant_integration_kind_check", sql.raw("(kind = ANY (ARRAY['storage'::text, 'database'::text]))")),
  check("tenant_integration_provider_check", sql.raw("(provider = ANY (ARRAY['s3'::text, 'postgresql'::text]))")),
  check("tenant_integration_secret_ciphertext_check", sql.raw("(secret_ciphertext ~~ 'v1.%'::text)")),
  check("tenant_integration_settings_check", sql.raw("(jsonb_typeof(settings) = 'object'::text)")),
  check("tenant_integration_settings_fingerprint_check", sql.raw("(settings_fingerprint ~ '^[0-9a-f]{64}$'::text)")),
  check("tenant_integration_status_check", sql.raw("(status = ANY (ARRAY['draft'::text, 'verified'::text, 'failed'::text, 'active'::text, 'retired'::text]))")),
  uniqueIndex("tenant_integration_one_active_uidx").using('btree', sql.raw("tenant_id, kind")).where(sql.raw("(status = 'active'::text)")),
  index("tenant_integration_tenant_idx").using('btree', sql.raw("tenant_id, kind, created_at DESC")),
])

export type TenantIntegration = typeof tenantIntegration.$inferSelect
export type NewTenantIntegration = typeof tenantIntegration.$inferInsert

export const tenantOwnerInvitation = platformSchema.table('tenant_owner_invitation', {
  invitationId: uuid('invitation_id').primaryKey().default(sql.raw("gen_random_uuid()")),
  tenantId: uuid('tenant_id').notNull().references((): AnyPgColumn => tenantRegistry.tenantId, { onDelete: 'cascade' }),
  emailNormalized: text('email_normalized').notNull(),
  displayName: text('display_name').notNull(),
  tokenHash: text('token_hash').notNull(),
  issuedBy: uuid('issued_by').references((): AnyPgColumn => platformUser.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  check("tenant_owner_invitation_check", sql.raw("(expires_at > created_at)")),
  check("tenant_owner_invitation_check1", sql.raw("(consumed_at IS NULL OR revoked_at IS NULL)")),
  check("tenant_owner_invitation_display_name_check", sql.raw("(length(btrim(display_name)) >= 1 AND length(btrim(display_name)) <= 255)")),
  check("tenant_owner_invitation_email_normalized_check", sql.raw("(email_normalized = lower(email_normalized) AND length(email_normalized) >= 3 AND length(email_normalized) <= 320)")),
  check("tenant_owner_invitation_token_hash_check", sql.raw("(token_hash ~ '^[0-9a-f]{64}$'::text)")),
  unique("tenant_owner_invitation_token_hash_key").on(table.tokenHash),
  index("tenant_owner_invitation_tenant_idx").using('btree', sql.raw("tenant_id, created_at DESC")),
])

export type TenantOwnerInvitation = typeof tenantOwnerInvitation.$inferSelect
export type NewTenantOwnerInvitation = typeof tenantOwnerInvitation.$inferInsert

export const tenantProvisioningJob = platformSchema.table('tenant_provisioning_job', {
  jobId: uuid('job_id').primaryKey().default(sql.raw("gen_random_uuid()")),
  tenantId: uuid('tenant_id').notNull().references((): AnyPgColumn => tenantRegistry.tenantId, { onDelete: 'restrict' }),
  requestedBy: uuid('requested_by').references((): AnyPgColumn => platformUser.id, { onDelete: 'set null' }),
  correlationId: uuid('correlation_id').notNull(),
  status: text('status').notNull().default(sql.raw("'pending'::text")),
  currentStep: text('current_step'),
  attemptCount: integer('attempt_count').notNull().default(sql.raw("0")),
  retryable: boolean('retryable').notNull().default(sql.raw("true")),
  safeErrorCode: text('safe_error_code'),
  safeErrorMessage: text('safe_error_message'),
  workerId: text('worker_id'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  jobType: text('job_type').notNull().default(sql.raw("'provision'::text")),
  jobParams: jsonb('job_params').notNull().default(sql.raw("'{}'::jsonb")),
}, (_table) => [
  check("tenant_provisioning_job_attempt_count_check", sql.raw("(attempt_count >= 0)")),
  check("tenant_provisioning_job_job_params_check", sql.raw("(jsonb_typeof(job_params) = 'object'::text)")),
  check("tenant_provisioning_job_job_type_check", sql.raw("(job_type = ANY (ARRAY['provision'::text, 'deprovision'::text, 'migrate'::text, 'relocate_database'::text, 'relocate_storage'::text]))")),
  check("tenant_provisioning_job_status_check", sql.raw("(status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'retrying'::text, 'rolled_back'::text]))")),
  index("tenant_provisioning_job_queue_idx").using('btree', sql.raw("status, created_at")),
  uniqueIndex("tenant_provisioning_one_open_job_uidx").using('btree', sql.raw("tenant_id")).where(sql.raw("(status = ANY (ARRAY['pending'::text, 'running'::text, 'retrying'::text]))")),
  index("tenant_provisioning_running_lease_idx").using('btree', sql.raw("locked_at")).where(sql.raw("(status = 'running'::text)")),
])

export type TenantProvisioningJob = typeof tenantProvisioningJob.$inferSelect
export type NewTenantProvisioningJob = typeof tenantProvisioningJob.$inferInsert

export const tenantProvisioningStep = platformSchema.table('tenant_provisioning_step', {
  jobId: uuid('job_id').notNull().references((): AnyPgColumn => tenantProvisioningJob.jobId, { onDelete: 'cascade' }),
  stepCode: text('step_code').notNull(),
  stepOrder: integer('step_order').notNull(),
  status: text('status').notNull().default(sql.raw("'pending'::text")),
  displayMessage: text('display_message').notNull(),
  safeErrorMessage: text('safe_error_message'),
  attemptCount: integer('attempt_count').notNull().default(sql.raw("0")),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
}, (table) => [
  primaryKey({ name: "tenant_provisioning_step_pkey", columns: [table.jobId, table.stepCode] }),
  check("tenant_provisioning_step_attempt_count_check", sql.raw("(attempt_count >= 0)")),
  unique("tenant_provisioning_step_job_id_step_order_key").on(table.jobId, table.stepOrder),
  check("tenant_provisioning_step_status_check", sql.raw("(status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text]))")),
  check("tenant_provisioning_step_step_order_check", sql.raw("(step_order > 0)")),
])

export type TenantProvisioningStep = typeof tenantProvisioningStep.$inferSelect
export type NewTenantProvisioningStep = typeof tenantProvisioningStep.$inferInsert

export const tenantRegistry = platformSchema.table('tenant_registry', {
  tenantId: uuid('tenant_id').primaryKey().default(sql.raw("gen_random_uuid()")),
  displayName: text('display_name').notNull(),
  schemaIdentifier: text('schema_identifier').notNull(),
  deploymentModel: text('deployment_model').notNull().default(sql.raw("'shared_cluster_schema'::text")),
  databaseTargetRef: text('database_target_ref'),
  lifecycleStatus: text('lifecycle_status').notNull().default(sql.raw("'provisioning'::text")),
  primaryHostname: text('primary_hostname'),
  region: text('region').notNull(),
  schemaVersion: integer('schema_version').notNull().default(sql.raw("0")),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  tenantKey: text('tenant_key').notNull(),
  legalName: text('legal_name'),
  slug: text('slug'),
  dbRole: text('db_role').notNull(),
  loginRole: text('login_role').notNull(),
  credentialRef: text('credential_ref').notNull(),
  defaultLocale: text('default_locale').notNull().default(sql.raw("'en'::text")),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  identityScheme: text('identity_scheme').notNull().default(sql.raw("'tenant_key_v1'::text")),
  connectionTier: text('connection_tier').notNull().default(sql.raw("'dedicated'::text")),
  storageIntegrationId: uuid('storage_integration_id').references((): AnyPgColumn => tenantIntegration.integrationId),
  dataIntegrationId: uuid('data_integration_id').references((): AnyPgColumn => tenantIntegration.integrationId),
}, (table) => [
  check("tenant_registry_connection_tier_check", sql.raw("(connection_tier = ANY (ARRAY['dedicated'::text, 'pooled'::text]))")),
  check("tenant_registry_database_target_check", sql.raw("(deployment_model = 'shared_cluster_schema'::text AND database_target_ref IS NULL OR deployment_model = 'dedicated_database'::text AND database_target_ref IS NOT NULL)")),
  check("tenant_registry_deployment_model_check", sql.raw("(deployment_model = ANY (ARRAY['shared_cluster_schema'::text, 'dedicated_database'::text]))")),
  check("tenant_registry_identity_scheme_check", sql.raw("(identity_scheme = ANY (ARRAY['legacy'::text, 'tenant_key_v1'::text]))")),
  check("tenant_registry_lifecycle_status_check", sql.raw("(lifecycle_status = ANY (ARRAY['provisioning'::text, 'active'::text, 'suspended'::text, 'migration_failed'::text, 'relocating'::text, 'provisioning_failed'::text, 'deleting'::text, 'deletion_failed'::text, 'deleted'::text]))")),
  check("tenant_registry_schema_identifier_check", sql.raw("(schema_identifier ~ '^tenant_[a-z0-9][a-z0-9_]{2,62}$'::text)")),
  unique("tenant_registry_schema_identifier_key").on(table.schemaIdentifier),
  check("tenant_registry_schema_version_check", sql.raw("(schema_version >= 0)")),
  check("tenant_registry_tenant_key_format_check", sql.raw("(identity_scheme = 'tenant_key_v1'::text AND tenant_key ~ '^T[0-9A-F]{20}$'::text OR identity_scheme = 'legacy'::text AND tenant_key ~ '^T[A-Z0-9]{4,63}$'::text)")),
  uniqueIndex("tenant_registry_db_role_uidx").using('btree', sql.raw("db_role")).where(sql.raw("(db_role IS NOT NULL)")),
  uniqueIndex("tenant_registry_hostname_uidx").using('btree', sql.raw("lower(primary_hostname)")).where(sql.raw("((primary_hostname IS NOT NULL) AND (lifecycle_status <> 'deleted'::text))")),
  uniqueIndex("tenant_registry_login_role_uidx").using('btree', sql.raw("login_role")).where(sql.raw("(login_role IS NOT NULL)")),
  uniqueIndex("tenant_registry_slug_uidx").using('btree', sql.raw("lower(slug)")).where(sql.raw("((slug IS NOT NULL) AND (lifecycle_status <> 'deleted'::text))")),
  index("tenant_registry_status_idx").using('btree', sql.raw("lifecycle_status")),
  uniqueIndex("tenant_registry_tenant_key_uidx").using('btree', sql.raw("tenant_key")).where(sql.raw("(tenant_key IS NOT NULL)")),
])

export type TenantRegistry = typeof tenantRegistry.$inferSelect
export type NewTenantRegistry = typeof tenantRegistry.$inferInsert

export const tenantSubscription = platformSchema.table('tenant_subscription', {
  subscriptionId: uuid('subscription_id').primaryKey().default(sql.raw("gen_random_uuid()")),
  tenantId: uuid('tenant_id').notNull().references((): AnyPgColumn => tenantRegistry.tenantId, { onDelete: 'restrict' }),
  planId: uuid('plan_id').notNull().references((): AnyPgColumn => planCatalog.planId, { onDelete: 'restrict' }),
  status: text('status').notNull(),
  entitlementVersion: integer('entitlement_version').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
}, (_table) => [
  check("tenant_subscription_entitlement_version_check", sql.raw("(entitlement_version > 0)")),
  check("tenant_subscription_period_check", sql.raw("(period_end IS NULL OR period_start IS NULL OR period_end > period_start)")),
  check("tenant_subscription_status_check", sql.raw("(status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'paused'::text, 'cancelled'::text, 'expired'::text]))")),
  uniqueIndex("tenant_subscription_current_uidx").using('btree', sql.raw("tenant_id")).where(sql.raw("(status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'paused'::text]))")),
])

export type TenantSubscription = typeof tenantSubscription.$inferSelect
export type NewTenantSubscription = typeof tenantSubscription.$inferInsert

export const usageAggregate = platformSchema.table('usage_aggregate', {
  aggregateId: uuid('aggregate_id').primaryKey().default(sql.raw("gen_random_uuid()")),
  subjectType: text('subject_type').notNull(),
  tenantId: uuid('tenant_id').references((): AnyPgColumn => tenantRegistry.tenantId, { onDelete: 'restrict' }),
  metricName: text('metric_name').notNull(),
  metricValue: numeric('metric_value', { precision: 30, scale: 6 }).notNull(),
  planCode: text('plan_code'),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
  calculatedAt: timestamp('calculated_at', { withTimezone: true }).notNull().default(sql.raw("now()")),
  sourceVersion: integer('source_version').notNull(),
}, (_table) => [
  check("usage_aggregate_metric_name_check", sql.raw("(metric_name ~ '^[a-z][a-z0-9_]{1,95}$'::text)")),
  check("usage_aggregate_metric_value_check", sql.raw("(metric_value >= 0::numeric)")),
  check("usage_aggregate_plan_code_check", sql.raw("(plan_code IS NULL OR plan_code ~ '^[a-z][a-z0-9_]{1,62}$'::text)")),
  check("usage_aggregate_source_version_check", sql.raw("(source_version > 0)")),
  check("usage_aggregate_subject_check", sql.raw("((subject_type = 'tenant'::text) = (tenant_id IS NOT NULL))")),
  check("usage_aggregate_subject_type_check", sql.raw("(subject_type = ANY (ARRAY['tenant'::text, 'consumer_population'::text, 'platform_total'::text]))")),
  check("usage_aggregate_window_check", sql.raw("(window_end > window_start)")),
  uniqueIndex("usage_aggregate_identity_uidx").using('btree', sql.raw("subject_type, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), metric_name, COALESCE(plan_code, ''::text), window_start, window_end, source_version")),
  index("usage_aggregate_metric_window_idx").using('btree', sql.raw("metric_name, window_end DESC")),
])

export type UsageAggregate = typeof usageAggregate.$inferSelect
export type NewUsageAggregate = typeof usageAggregate.$inferInsert
