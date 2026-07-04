/**
 * Vibe 1099 — Drizzle schema (data model per build plan).
 *
 * Conventions:
 *  - money: integer cents (ADR-001)
 *  - TINs/JWKs: AES-256-GCM envelope ciphertext strings (ADR-002); tin_hash =
 *    HMAC-SHA256(TIN, install key) enables lookup without decryption
 *  - audit_log is append-only
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  customType,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// ---------------------------------------------------------------------------

export const firms = pgTable('firms', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ein: text('ein').notNull(), // firm EIN (not payee-facing; stored plain)
  address: jsonb('address').notNull().$type<Record<string, string>>(),
  phone: text('phone').notNull().default(''),
  // IRIS credentials — firm is the Transmitter (LOCKED decision #4)
  irisTcc: text('iris_tcc').notNull().default(''),
  irisApiClientId: text('iris_api_client_id').notNull().default(''),
  irisJwkEncrypted: text('iris_jwk_encrypted'), // private JWK, envelope-encrypted
  irisJwkPublic: jsonb('iris_jwk_public').$type<Record<string, unknown>>(),
  irisEnvironment: text('iris_environment').notNull().default('ATS'), // ATS | PROD
  // filing backend: 'iris' (firm is transmitter, needs TCC) | 'tax1099' (Zenwork
  // files on the payer's behalf, no TCC). Default provider for the firm's payers.
  filingProvider: text('filing_provider').notNull().default('iris').$type<'iris' | 'tax1099' | 'taxbandits'>(),
  tax1099ApiKeyEncrypted: text('tax1099_api_key_encrypted'), // Tax1099 app key, envelope-encrypted
  tax1099Environment: text('tax1099_environment').notNull().default('sandbox').$type<'sandbox' | 'production'>(),
  tax1099Mailing: boolean('tax1099_mailing').notNull().default(false), // let Tax1099 USPS-mail recipient copies
  // §7216 auxiliary-services disclosure acknowledgment. Sending payee TINs to
  // Zenwork (Tax1099) is a third-party disclosure; an admin must acknowledge it
  // once before any Tax1099 call is permitted (gated in loadTax1099Config).
  tax1099DisclosureAckAt: timestamp('tax1099_disclosure_ack_at', { withTimezone: true }),
  tax1099DisclosureAckBy: uuid('tax1099_disclosure_ack_by'),
  // TaxBandits (SPAN Enterprises) managed-filing backend — optional contingency
  // provider (TCC-pending). Off unless enabled per-firm AND the feature flag is on.
  taxbanditsEnabled: boolean('taxbandits_enabled').notNull().default(false),
  taxbanditsClientIdEncrypted: text('taxbandits_client_id_encrypted'),
  taxbanditsClientSecretEncrypted: text('taxbandits_client_secret_encrypted'),
  taxbanditsUserTokenEncrypted: text('taxbandits_user_token_encrypted'),
  taxbanditsEnvironment: text('taxbandits_environment').notNull().default('sandbox').$type<'sandbox' | 'production'>(),
  taxbanditsPostalMailing: boolean('taxbandits_postal_mailing').notNull().default(false),
  taxbanditsOnlineAccess: boolean('taxbandits_online_access').notNull().default(false),
  taxbanditsLowCreditCents: integer('taxbandits_low_credit_cents').notNull().default(2500),
  taxbanditsDisclosureAckAt: timestamp('taxbandits_disclosure_ack_at', { withTimezone: true }),
  taxbanditsDisclosureAckBy: uuid('taxbandits_disclosure_ack_by'),
  // Missouri
  moWithholdingId: text('mo_withholding_id').notNull().default(''),
  // delivery config
  smtpOverride: jsonb('smtp_override').$type<Record<string, string>>(),
  smsOverride: jsonb('sms_override').$type<Record<string, string>>(),
  // pressure-seal calibration (points, ±1/16" steps stored as 1/16" units)
  impositionOffsetX16: integer('imposition_offset_x16').notNull().default(0),
  impositionOffsetY16: integer('imposition_offset_y16').notNull().default(0),
  // licensing
  licenseKey: text('license_key').notNull().default(''),
  licenseTier: text('license_tier').notNull().default('internal'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(), // argon2id
    role: text('role').notNull().$type<'admin' | 'preparer' | 'reviewer'>(),
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    active: boolean('active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.firmId, t.email)],
);

export const passwordResets = pgTable('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const payers = pgTable('payers', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id')
    .notNull()
    .references(() => firms.id),
  legalName: text('legal_name').notNull(),
  dbaName: text('dba_name').notNull().default(''),
  // external firm/practice-management identifier + individual name parts (for
  // sole-proprietor / individual payers). legalName remains the name-of-record.
  clientId: text('client_id'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  tinEncrypted: text('tin_encrypted').notNull(), // payer EIN/SSN, encrypted at rest
  tinType: text('tin_type').notNull().$type<'SSN' | 'EIN'>(),
  tinLast4: text('tin_last4').notNull(),
  address: jsonb('address').notNull().$type<Record<string, string>>(),
  phone: text('phone').notNull().default(''),
  contactEmail: text('contact_email'),
  contactMobile: text('contact_mobile'),
  moWithholdingId: text('mo_withholding_id'), // nullable
  // per-payer override of the firm's default filing backend (null = inherit firm)
  filingProviderOverride: text('filing_provider_override').$type<'iris' | 'tax1099' | 'taxbandits'>(),
  moSourceDefault: boolean('mo_source_default').notNull().default(false),
  defaultFormTypes: jsonb('default_form_types').notNull().default(['NEC']).$type<string[]>(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clientInvites = pgTable(
  'client_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    payerId: uuid('payer_id')
      .notNull()
      .references(() => payers.id),
    taxYear: integer('tax_year').notNull(),
    formTypes: jsonb('form_types').notNull().$type<string[]>(), // staff-enabled types
    tokenHash: text('token_hash').notNull(), // magic-link token, hashed
    email: text('email'),
    mobile: text('mobile'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }), // client hit Submit
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    draftState: jsonb('draft_state').$type<Record<string, unknown>>(), // client save-and-return
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('client_invites_payer_idx').on(t.payerId, t.taxYear)],
);

export const recipients = pgTable(
  'recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    tinEncrypted: text('tin_encrypted').notNull(),
    tinHash: text('tin_hash').notNull(), // HMAC-SHA256(TIN, install key)
    tinType: text('tin_type').notNull().$type<'SSN' | 'EIN'>(),
    tinLast4: text('tin_last4').notNull(), // recipient-portal challenge; masked display
    isItin: boolean('is_itin').notNull().default(false),
    name1: text('name1').notNull(),
    name2: text('name2').notNull().default(''),
    address: jsonb('address').notNull().$type<Record<string, string>>(),
    email: text('email'),
    mobile: text('mobile'),
    smsOptOut: boolean('sms_opt_out').notNull().default(false),
    w9Status: text('w9_status').notNull().default('none').$type<'none' | 'requested' | 'on_file' | 'stale'>(),
    w9CompletedAt: timestamp('w9_completed_at', { withTimezone: true }),
    backupWithholding: boolean('backup_withholding').notNull().default(false),
    createdFrom: text('created_from').notNull().default('staff').$type<'staff' | 'client' | 'w9' | 'import'>(),
    mergedIntoId: uuid('merged_into_id'), // set when merged as duplicate
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // unique TIN per firm — but merged-away rows keep their hash; enforce in service layer for active rows.
    index('recipients_tin_hash_idx').on(t.firmId, t.tinHash),
    index('recipients_name_idx').on(t.firmId, t.name1),
  ],
);

export const recipientAddressHistory = pgTable('recipient_address_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  recipientId: uuid('recipient_id')
    .notNull()
    .references(() => recipients.id),
  name1: text('name1').notNull(),
  name2: text('name2').notNull().default(''),
  address: jsonb('address').notNull().$type<Record<string, string>>(),
  source: text('source').notNull().$type<'staff' | 'client' | 'w9' | 'import' | 'merge'>(),
  changedBy: uuid('changed_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const formRecords = pgTable(
  'form_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    payerId: uuid('payer_id')
      .notNull()
      .references(() => payers.id),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => recipients.id),
    taxYear: integer('tax_year').notNull(),
    formType: text('form_type').notNull().$type<'NEC' | 'MISC' | 'INT' | 'DIV' | '1098'>(),
    boxValues: jsonb('box_values').notNull().$type<Record<string, number | boolean | string | null>>(), // cents
    accountNumber: text('account_number').notNull().default(''),
    secondTinNotice: boolean('second_tin_notice').notNull().default(false),
    moSource: boolean('mo_source').notNull().default(false),
    status: text('status')
      .notNull()
      .default('draft')
      .$type<
        'draft' | 'ready' | 'queued' | 'transmitted' | 'accepted' | 'accepted_with_errors' | 'rejected' | 'corrected'
      >(),
    clientSubmitted: boolean('client_submitted').notNull().default(false),
    clientInviteId: uuid('client_invite_id').references(() => clientInvites.id),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    // as-filed snapshot (immutable copy at transmit; corrections diff against this)
    filedSnapshot: jsonb('filed_snapshot').$type<Record<string, unknown>>(),
    // corrections lineage
    correctsId: uuid('corrects_id'), // self-ref FK added in SQL migration
    correctionSeq: integer('correction_seq').notNull().default(0), // corrected(n)
    correctionType: text('correction_type').$type<'one_transaction' | 'two_transaction_zero' | 'two_transaction_new' | 'void'>(),
    correctionReason: text('correction_reason'),
    // transmission linkage + errors
    transmissionId: uuid('transmission_id'),
    recordErrors: jsonb('record_errors').$type<Array<{ code: string; message: string; translated?: string }>>(),
    notes: text('notes').notNull().default(''),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('form_records_payer_idx').on(t.payerId, t.taxYear, t.formType),
    index('form_records_recipient_idx').on(t.recipientId, t.taxYear),
    index('form_records_status_idx').on(t.firmId, t.taxYear, t.status),
  ],
);

export const transmissions = pgTable('transmissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id')
    .notNull()
    .references(() => firms.id),
  taxYear: integer('tax_year').notNull(),
  environment: text('environment').notNull().$type<'ATS' | 'PROD'>(),
  // filing backend that owns this transmission (worker dispatches accordingly)
  provider: text('provider').notNull().default('iris').$type<'iris' | 'tax1099' | 'taxbandits'>(),
  utid: text('utid').notNull(), // unique transmission id / submission ref (idempotency guard)
  receiptId: text('receipt_id'), // IRIS Receipt ID or Tax1099 submission id
  status: text('status')
    .notNull()
    .default('building')
    .$type<'building' | 'transmitting' | 'transmitted' | 'polling' | 'accepted' | 'accepted_with_errors' | 'rejected' | 'failed'>(),
  isCorrection: boolean('is_correction').notNull().default(false),
  recordCount: integer('record_count').notNull().default(0),
  xmlBlobId: uuid('xml_blob_id'),
  ackBlobId: uuid('ack_blob_id'),
  ackPayload: jsonb('ack_payload').$type<Record<string, unknown>>(),
  errorDetails: jsonb('error_details').$type<Array<Record<string, unknown>>>(),
  cfsfStates: jsonb('cfsf_states').$type<string[]>(), // CF/SF election states in this submission
  transmittedAt: timestamp('transmitted_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('transmissions_utid_uq').on(t.utid)]);

export const stateFiles = pgTable('state_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id')
    .notNull()
    .references(() => firms.id),
  state: text('state').notNull().default('MO'),
  taxYear: integer('tax_year').notNull(),
  payerIds: jsonb('payer_ids').notNull().$type<string[]>(),
  recordCount: integer('record_count').notNull().default(0),
  kRecordTotals: jsonb('k_record_totals').$type<Record<string, number>>(), // cents
  fileBlobId: uuid('file_blob_id'),
  filename: text('filename').notNull().default(''),
  status: text('status')
    .notNull()
    .default('generated')
    .$type<'generated' | 'uploaded' | 'accepted' | 'rejected' | 'superseded'>(),
  statusNotes: text('status_notes').notNull().default(''),
  formRecordIds: jsonb('form_record_ids').notNull().$type<string[]>(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- TaxBandits (SPAN Enterprises) provider tables --------------------------

/** Prepaid-credit cost ledger. Attributes each billable TaxBandits event to
 *  firm → payer → transmission → form so firms can rebill clients. Integer cents. */
export const taxbanditsCostLedger = pgTable(
  'taxbandits_cost_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    payerId: uuid('payer_id'),
    transmissionId: uuid('transmission_id'),
    formRecordId: uuid('form_record_id'),
    eventType: text('event_type').notNull().$type<'efile' | 'correction' | 'void' | 'state_filing' | 'tin_match' | 'postal' | 'online_access'>(),
    amountCents: integer('amount_cents').notNull().default(0),
    balanceAfterCents: integer('balance_after_cents'), // when the API reports it
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tb_cost_ledger_firm_idx').on(t.firmId, t.createdAt)],
);

/** Provider-tagged TIN matching results (TaxBandits or future native IRS TIN
 *  matching). Invalidated on name/TIN change (staleness handled in the service). */
export const tinMatchResults = pgTable(
  'tin_match_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => recipients.id),
    provider: text('provider').notNull().$type<'taxbandits' | 'irs'>(),
    status: text('status').notNull().$type<'match' | 'mismatch' | 'pending' | 'error'>(),
    code: text('code').notNull().default(''),
    message: text('message').notNull().default(''),
    // async TaxBandits TIN matching: the submission + record refs used to poll the verdict
    submissionRef: text('submission_ref'),
    recordRef: text('record_ref'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    stale: boolean('stale').notNull().default(false),
  },
  (t) => [index('tin_match_recipient_idx').on(t.recipientId, t.checkedAt)],
);

/** Raw TaxBandits webhook events with a dedupe key, for at-least-once tolerant
 *  idempotent ingestion. */
export const taxbanditsWebhookEvents = pgTable(
  'taxbandits_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dedupeKey: text('dedupe_key').notNull(),
    eventType: text('event_type').notNull(),
    submissionId: text('submission_id'),
    recordId: text('record_id'),
    status: text('status'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tb_webhook_dedupe_uq').on(t.dedupeKey)],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    formRecordId: uuid('form_record_id')
      .notNull()
      .references(() => formRecords.id),
    channel: text('channel').notNull().$type<'paper' | 'email' | 'sms'>(),
    tokenHash: text('token_hash'), // recipient portal token (email/sms)
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    tokenRevokedAt: timestamp('token_revoked_at', { withTimezone: true }),
    isCorrected: boolean('is_corrected').notNull().default(false),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }),
    downloadedAt: timestamp('downloaded_at', { withTimezone: true }),
    failReason: text('fail_reason'),
    paperBatchId: uuid('paper_batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('deliveries_record_idx').on(t.formRecordId)],
);

export const paperBatches = pgTable('paper_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id')
    .notNull()
    .references(() => firms.id),
  taxYear: integer('tax_year').notNull(),
  label: text('label').notNull().default(''),
  pdfBlobId: uuid('pdf_blob_id'),
  pageCount: integer('page_count').notNull().default(0),
  formCount: integer('form_count').notNull().default(0),
  formRecordIds: jsonb('form_record_ids').notNull().$type<string[]>(),
  status: text('status').notNull().default('building').$type<'building' | 'built' | 'printed' | 'delivered' | 'failed'>(),
  printedAt: timestamp('printed_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const w9Requests = pgTable('w9_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id')
    .notNull()
    .references(() => firms.id),
  recipientId: uuid('recipient_id').references(() => recipients.id), // null until matched/created
  payerId: uuid('payer_id').references(() => payers.id), // requesting context
  requestedName: text('requested_name').notNull().default(''),
  email: text('email'),
  mobile: text('mobile'),
  tokenHash: text('token_hash').notNull(),
  status: text('status').notNull().default('sent').$type<'sent' | 'opened' | 'completed' | 'expired' | 'revoked'>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  remindersSent: integer('reminders_sent').notNull().default(0),
  lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
  pdfBlobId: uuid('pdf_blob_id'), // completed W-9 PDF (encrypted blob)
  esignMeta: jsonb('esign_meta').$type<Record<string, unknown>>(), // IP, UTC ts, UA, typed/drawn
  tinMismatch: boolean('tin_mismatch').notNull().default(false), // vault had different TIN — staff review
  submittedData: jsonb('submitted_data').$type<Record<string, unknown>>(), // non-TIN fields for review
  requestedBy: uuid('requested_by'),
  requestedVia: text('requested_via').notNull().default('staff').$type<'staff' | 'client'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    firmId: uuid('firm_id'),
    actorType: text('actor_type').notNull().$type<'staff' | 'client' | 'recipient' | 'system'>(),
    actorId: text('actor_id'), // user id / invite id / delivery id
    action: text('action').notNull(), // e.g. recipient.update, form.transmit, tin.reveal
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_entity_idx').on(t.entityType, t.entityId), index('audit_log_time_idx').on(t.createdAt)],
);

export const blobs = pgTable('blobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id'),
  kind: text('kind').notNull(), // form_pdf | batch_pdf | w9_pdf | iris_xml | iris_ack | mo_txt | report_pdf
  contentType: text('content_type').notNull(),
  filename: text('filename').notNull().default(''),
  bytes: bytea('bytes').notNull(),
  encrypted: boolean('encrypted').notNull().default(false), // envelope-encrypted payloads (W-9 PDFs)
  size: integer('size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const errorTranslations = pgTable('error_translations', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull().default('IRIS'),
  code: text('code').notNull(),
  officialText: text('official_text').notNull().default(''),
  plainEnglish: text('plain_english').notNull(),
  suggestedFix: text('suggested_fix').notNull().default(''),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('error_translations_uq').on(t.source, t.code)]);

/** State direct-file config stub (MO row live; schema ready for expansion). */
export const statesConfig = pgTable('states_config', {
  state: text('state').primaryKey(),
  participatesCfsf: boolean('participates_cfsf').notNull().default(false),
  directRequired: boolean('direct_required').notNull().default(false),
  thresholdCents: integer('threshold_cents').notNull().default(0),
  format: text('format').notNull().default(''), // e.g. pub1220
  portalUrl: text('portal_url').notNull().default(''),
  notes: text('notes').notNull().default(''),
});

export const yearLocks = pgTable('year_locks', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: uuid('firm_id')
    .notNull()
    .references(() => firms.id),
  taxYear: integer('tax_year').notNull(),
  lockedBy: uuid('locked_by').references(() => users.id),
  lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('year_locks_uq').on(t.firmId, t.taxYear)]);

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(), // message templates, reminder schedule, retention, etc.
  value: jsonb('value').notNull().$type<unknown>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Filing Run — a bulk fleet operation with dry-run preview, progress, per-item result. */
export const filingRuns = pgTable(
  'filing_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    kind: text('kind').notNull().$type<'transmit' | 'mo_file' | 'paper_batch' | 'summary_zip' | 'invite' | 'w9'>(),
    taxYear: integer('tax_year').notNull(),
    status: text('status').notNull().default('preview').$type<'preview' | 'running' | 'completed' | 'partial' | 'failed'>(),
    scope: jsonb('scope').notNull().$type<Record<string, unknown>>(),
    total: integer('total').notNull().default(0),
    succeeded: integer('succeeded').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    items: jsonb('items').$type<Array<{ payerId?: string; label: string; ok: boolean; message?: string; refId?: string }>>(),
    resultBlobId: uuid('result_blob_id'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('filing_runs_firm_idx').on(t.firmId, t.taxYear, t.createdAt)],
);

/** Notifications — persistent async job completions + alerts. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    userId: uuid('user_id').references(() => users.id), // null = all staff
    kind: text('kind').notNull(),
    severity: text('severity').notNull().default('info').$type<'info' | 'success' | 'warning' | 'error'>(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    link: text('link').notNull().default(''),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_firm_idx').on(t.firmId, t.createdAt)],
);

/** Saved views — per-user named filter/sort presets for list screens. */
export const savedViews = pgTable(
  'saved_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    screen: text('screen').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('saved_views_user_idx').on(t.firmId, t.userId, t.screen)],
);
