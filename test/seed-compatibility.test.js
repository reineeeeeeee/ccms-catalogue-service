import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  parseServiceFields,
  parseStandardFields,
  standardText,
} from '../src/lib/catalogue/catalogue-rules.js';
import { parseDocumentInput } from '../src/lib/catalogue/documents.js';

const seedFiles = [
  ['CCMS_SEED_CAMPADMIN_10062026.json', 36, 80],
  ['CCMS_SEED_CAMPACAD_10062026.json', 10, 21],
  ['CCMS_SEED_CAMPSAS_10062026.json', 20, 98],
  ['CCMS_SEED_CAMPACCT_10062026.json', 3, 9],
];

const loadSeed = (name) => JSON.parse(readFileSync(new URL(`../seed/${name}`, import.meta.url), 'utf8'));

describe('seeding compatibility rules', () => {
  it('formats each non-zero duration part in Charter order', () => {
    assert.equal(standardText(0, 0, 1), '1 minute');
    assert.equal(standardText(0, 4, 0), '4 hours');
    assert.equal(standardText(1, 1, 1), '1 working day, 1 hour, 1 minute');
    assert.equal(standardText(2, 5, 30), '2 working days, 5 hours, 30 minutes');
  });

  it('enforces service names, scope and a non-empty unique transaction type list', () => {
    const valid = {
      office_id: 'office',
      service_code: 'CODE',
      service_name: 'x'.repeat(200),
      classification: 'SIMPLE',
      service_scope: 'INTERNAL',
      transaction_types: ['G2C', 'G2G'],
    };
    const validDetails = {};
    const parsed = parseServiceFields(valid, validDetails);
    assert.deepEqual(validDetails, {});
    assert.deepEqual(parsed.transactionTypes, ['G2C', 'G2G']);

    for (const [change, field] of [
      [{ service_name: 'x'.repeat(201) }, 'service_name'],
      [{ service_scope: 'PUBLIC' }, 'service_scope'],
      [{ transaction_types: [] }, 'transaction_types'],
      [{ transaction_types: ['G2C', 'B2B'] }, 'transaction_types'],
      [{ transaction_types: ['G2C', 'G2C'] }, 'transaction_types'],
    ]) {
      const details = {};
      parseServiceFields({ ...valid, ...change }, details);
      assert.ok(details[field], `${field} should be invalid`);
    }
  });

  it('requires three non-negative whole-number duration parts and at least one positive part', () => {
    const base = {
      duration_days: 2,
      duration_hours: 5,
      duration_minutes: 30,
      effective_from: '2025-01-01',
      charter_reference: 'Charter p. 1',
    };
    const details = {};
    assert.deepEqual(parseStandardFields(base, details), {
      durationDays: 2,
      durationHours: 5,
      durationMinutes: 30,
      effectiveFrom: '2025-01-01',
      charterReference: 'Charter p. 1',
    });
    assert.deepEqual(details, {});

    const zeroDetails = {};
    parseStandardFields({ ...base, duration_days: 0, duration_hours: 0, duration_minutes: 0 }, zeroDetails);
    assert.ok(zeroDetails.duration);
    const invalidDetails = {};
    parseStandardFields({ ...base, duration_days: -1, duration_hours: 1.5, duration_minutes: 'x' }, invalidDetails);
    for (const field of ['duration_days', 'duration_hours', 'duration_minutes']) assert.ok(invalidDetails[field]);
  });

  it('accepts document names through 250 characters and notes through 1000', () => {
    assert.equal(parseDocumentInput({ document_name: 'n'.repeat(250), notes: 'x'.repeat(1000) }).notes.length, 1000);
    assert.throws(
      () => parseDocumentInput({ document_name: 'n'.repeat(251) }),
      (error) => /250/.test(error.details.document_name),
    );
    assert.throws(
      () => parseDocumentInput({ document_name: 'Document', notes: 'x'.repeat(1001) }),
      (error) => /1000/.test(error.details.notes),
    );
  });
});

describe('supplied Charter seed files', () => {
  it('contain the expected 69 services and 208 documents and pass the current input rules', () => {
    let services = 0;
    let documents = 0;
    let internal = 0;
    let external = 0;
    let multipleTypes = 0;
    const serviceCodes = new Set();

    for (const [name, expectedServices, expectedDocuments] of seedFiles) {
      const seed = loadSeed(name);
      assert.equal(seed.offices.length, 1, name);
      assert.equal(seed.services.length, expectedServices, name);
      assert.equal(seed.services.reduce((sum, service) => sum + (service.documents?.length ?? 0), 0), expectedDocuments, name);

      for (const service of seed.services) {
        assert.ok(!('transaction_type' in service), `${service.service_code} has obsolete transaction_type`);
        assert.ok(!('duration_value' in service.standard), `${service.service_code} has obsolete duration_value`);
        assert.ok(!('duration_unit' in service.standard), `${service.service_code} has obsolete duration_unit`);
        assert.ok(!serviceCodes.has(service.service_code), `duplicate code ${service.service_code}`);
        serviceCodes.add(service.service_code);

        const serviceDetails = {};
        parseServiceFields({ ...service, office_id: 'seed-office' }, serviceDetails);
        assert.deepEqual(serviceDetails, {}, `${service.service_code}: ${JSON.stringify(serviceDetails)}`);
        const standardDetails = {};
        parseStandardFields(service.standard, standardDetails, 'standard.');
        assert.deepEqual(standardDetails, {}, `${service.service_code}: ${JSON.stringify(standardDetails)}`);
        for (const document of service.documents ?? []) assert.doesNotThrow(() => parseDocumentInput(document), service.service_code);

        services += 1;
        documents += service.documents?.length ?? 0;
        if (service.service_scope === 'INTERNAL') internal += 1;
        if (service.service_scope === 'EXTERNAL') external += 1;
        if (service.transaction_types.length > 1) multipleTypes += 1;
      }
    }

    assert.deepEqual({ services, documents, internal, external, multipleTypes }, {
      services: 69,
      documents: 208,
      internal: 13,
      external: 56,
      multipleTypes: 8,
    });
    assert.ok(!serviceCodes.has('CAMP-OSAS-CRD-005'), 'held CAMP-OSAS EXT.18 must remain absent');
  });
});
