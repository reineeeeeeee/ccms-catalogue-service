import { OutboxEvent, RateLimitHit } from 'ccms-shared';
import { EntitySchema } from 'typeorm';

// ---- Catalogue ----

export const CatalogueSettings = new EntitySchema({
  name: 'CatalogueSettings', tableName: 'catalogue_settings',
  columns: {
    id: { type: 'smallint', primary: true, default: 1 },
    institutionCode: { name: 'institution_code', type: 'text', nullable: true },
    appliesToEnabled: { name: 'applies_to_enabled', type: 'boolean', default: false },
  },
});

export const ServiceCodeSequence = new EntitySchema({
  name: 'ServiceCodeSequence', tableName: 'service_code_sequences',
  columns: {
    officeId: { name: 'office_id', type: 'uuid', primary: true },
    serviceAbbr: { name: 'service_abbr', type: 'text', primary: true },
    lastSeq: { name: 'last_seq', type: 'int' },
  },
});

// The office list as printed in the Citizen's Charter. Offices are deactivated, never deleted.
export const Office = new EntitySchema({
  name: 'Office',
  tableName: 'offices',
  columns: {
    officeId: { name: 'office_id', type: 'uuid', primary: true },
    officeCode: { name: 'office_code', type: 'text' },
    officeName: { name: 'office_name', type: 'text' },
    isActive: { name: 'is_active', type: 'boolean', default: true },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
    updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
  },
});

// A Citizen's Charter service. Deactivated, never deleted. service_name_key is the normalised name
// (lower-case, single spaces) that the office + name uniqueness index uses.
export const Service = new EntitySchema({
  name: 'Service',
  tableName: 'services',
  columns: {
    serviceId: { name: 'service_id', type: 'uuid', primary: true },
    officeId: { name: 'office_id', type: 'uuid' },
    serviceCode: { name: 'service_code', type: 'text' },
    serviceName: { name: 'service_name', type: 'text' },
    serviceNameKey: { name: 'service_name_key', type: 'text' },
    classification: { name: 'classification', type: 'text' },
    serviceScope: { name: 'service_scope', type: 'text' },
    transactionTypes: { name: 'transaction_types', type: 'text', array: true },
    measurementType: { name: 'measurement_type', type: 'text', default: 'TIMELINESS' },
    processingSteps: { name: 'processing_steps', type: 'text', nullable: true },
    // CC007/CC008 (BR-SRV-001, FR-SRV-001): Charter display-only reference fields.
    fees: { name: 'fees', type: 'text', nullable: true },
    whoMayAvail: { name: 'who_may_avail', type: 'text', nullable: true },
    isActive: { name: 'is_active', type: 'boolean', default: true },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
    updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
  },
  indices: [{ name: 'services_office_idx', columns: ['officeId'] }],
});

// One version of a service's timeliness standard. Dates are Manila calendar dates.
export const ServiceStandard = new EntitySchema({
  name: 'ServiceStandard',
  tableName: 'service_standards',
  columns: {
    standardId: { name: 'standard_id', type: 'uuid', primary: true },
    serviceId: { name: 'service_id', type: 'uuid' },
    versionNo: { name: 'version_no', type: 'int' },
    durationDays: { name: 'duration_days', type: 'int', default: 0 },
    durationHours: { name: 'duration_hours', type: 'int', default: 0 },
    durationMinutes: { name: 'duration_minutes', type: 'int', default: 0 },
    effectiveFrom: { name: 'effective_from', type: 'date' },
    effectiveTo: { name: 'effective_to', type: 'date', nullable: true },
    charterReference: { name: 'charter_reference', type: 'text' },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
  },
  indices: [{ name: 'service_standards_service_idx', columns: ['serviceId'] }],
});

// A checklist item ("what to bring"). Names only: CCMS never stores uploaded documents.
export const RequiredDocument = new EntitySchema({
  name: 'RequiredDocument',
  tableName: 'required_documents',
  columns: {
    documentId: { name: 'document_id', type: 'uuid', primary: true },
    serviceId: { name: 'service_id', type: 'uuid' },
    documentName: { name: 'document_name', type: 'text' },
    documentNameKey: { name: 'document_name_key', type: 'text' },
    isMandatory: { name: 'is_mandatory', type: 'boolean', default: true },
    notes: { name: 'notes', type: 'text', nullable: true },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
    updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
  },
  indices: [{ name: 'required_documents_service_idx', columns: ['serviceId'] }],
});

// ---- Calendar ----


// The campus-wide weekly schedule: always seven rows, one per weekday (0 = Sunday ... 6 = Saturday).
// Times are 24-hour 'HH:MM' text; both are empty on a non-working day.
export const WorkingHours = new EntitySchema({
  name: 'WorkingHours',
  tableName: 'working_hours',
  columns: {
    dayOfWeek: { name: 'day_of_week', type: 'int', primary: true },
    isWorking: { name: 'is_working', type: 'boolean', default: false },
    openingTime: { name: 'opening_time', type: 'text', nullable: true },
    closingTime: { name: 'closing_time', type: 'text', nullable: true },
    updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
  },
});

// A holiday or suspension. office_id null = campus-wide; suspended_from null = the whole day.
// exception_date is a Manila calendar date. One entry per date per scope (unique index in after-sync).
export const CalendarException = new EntitySchema({
  name: 'CalendarException',
  tableName: 'calendar_exceptions',
  columns: {
    exceptionId: { name: 'exception_id', type: 'uuid', primary: true },
    exceptionDate: { name: 'exception_date', type: 'date' },
    exceptionType: { name: 'exception_type', type: 'text' },
    appliesTo: { name: 'applies_to', type: 'text', default: 'BOTH' },
    classMode: { name: 'class_mode', type: 'text', nullable: true, default: 'SUSPENDED' },
    description: { name: 'description', type: 'text', default: '' },
    officeId: { name: 'office_id', type: 'uuid', nullable: true },
    suspendedFrom: { name: 'suspended_from', type: 'text', nullable: true },
    // EB4: end of a part-day suspension (HH:MM, Asia/Manila). Empty on a whole-day entry. An old entry that has only
    // suspended_from keeps its old effect (suspended until closing time) but cannot be sent until an end is set.
    suspendedUntil: { name: 'suspended_until', type: 'text', nullable: true },
    // EB3: starts at 1 and goes up by 1 on every change; a removal raises it too and keeps the row (tombstone).
    revision: { name: 'revision', type: 'int', default: 1 },
    removedAt: { name: 'removed_at', type: 'timestamptz', nullable: true },
    isRecurring: { name: 'is_recurring', type: 'boolean', default: false },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
    updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
  },
  indices: [{ name: 'calendar_exceptions_date_idx', columns: ['exceptionDate'] }],
});

// An academic term. Term dates never affect CCMS's own compliance math; Audit uses them.
export const TermDate = new EntitySchema({
  name: 'TermDate',
  tableName: 'term_dates',
  columns: {
    termId: { name: 'term_id', type: 'uuid', primary: true },
    termName: { name: 'term_name', type: 'text' },
    startDate: { name: 'start_date', type: 'date' },
    endDate: { name: 'end_date', type: 'date' },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
    updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
  },
});

// One outward push (to FMS or to Audit) for one change. Created in the same transaction as the
// change; the dispatcher sends it and retries it. status: PENDING (not sent yet) -> SENT | FAILED,
// and ACKNOWLEDGED once Audit confirms through POST /sync/ack. FMS rows end SENT or FAILED.
export const SyncLog = new EntitySchema({
  name: 'SyncLog',
  tableName: 'sync_log',
  columns: {
    syncId: { name: 'sync_id', type: 'uuid', primary: true },
    consumerSystem: { name: 'consumer_system', type: 'text' },
    eventType: { name: 'event_type', type: 'text' },
    entityType: { name: 'entity_type', type: 'text' },
    entityId: { name: 'entity_id', type: 'text', nullable: true },
    payload: { name: 'payload', type: 'jsonb' },
    status: { name: 'status', type: 'text', default: 'PENDING' },
    attempts: { name: 'attempts', type: 'int', default: 0 },
    lastError: { name: 'last_error', type: 'text', nullable: true },
    lastAttemptAt: { name: 'last_attempt_at', type: 'timestamptz', nullable: true },
    lastSyncedAt: { name: 'last_synced_at', type: 'timestamptz', nullable: true },
    nextAttemptAt: { name: 'next_attempt_at', type: 'timestamptz', default: () => 'now()' },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
  },
  indices: [
    { name: 'sync_log_created_idx', columns: ['createdAt'] },
    { name: 'sync_log_due_idx', columns: ['nextAttemptAt'], where: "\"status\" IN ('PENDING', 'FAILED')" },
  ],
});

// One database, one audit outbox (OutboxEvent): Catalogue and Calendar both write their audit events to it.
export const entities = [
  CatalogueSettings,
  ServiceCodeSequence,
  Office,
  Service,
  ServiceStandard,
  RequiredDocument,
  WorkingHours,
  CalendarException,
  TermDate,
  SyncLog,
  OutboxEvent,
  RateLimitHit,
];
