'use strict';

const { assertConfig, fetchCallRows } = require('../lib/bigquery');
const { readContactsByEmail, updateContacts } = require('../lib/hubspot');

const LIVE_CONFIRMATION = 'yes-really-run-live';
const DIFF_LOG_LIMIT = 100;
const SAMPLE_LIMIT = 20;

function propertyName(envName) {
  const raw = process.env[envName];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`Missing required environment variable: ${envName}`);
  }
  const value = raw.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(value)) {
    throw new Error(`${envName} is not a valid HubSpot contact property name`);
  }
  return value;
}

function normalizeEmail(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

function isUsableEmail(email) {
  return (
    email.length <= 320 &&
    !/[\u0000-\u001F]/.test(email) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function primitive(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (typeof value.valueOf === 'function') {
    const unwrapped = value.valueOf();
    if (unwrapped !== value && (typeof unwrapped !== 'object' || unwrapped === null)) {
      return primitive(unwrapped);
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'value')) return primitive(value.value);
  return null;
}

function normalizeFlag(value) {
  const raw = primitive(value);
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  if (text === 'true' || text === 'yes') return 'true';
  if (text === 'false' || text === 'no') return 'false';
  return null;
}

function field(row, names) {
  for (const name of names) {
    if (row[name] != null) return row[name];
  }
  return null;
}

function companyRank(value) {
  const raw = primitive(value);
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : Number.NEGATIVE_INFINITY;
}

function indexRows(rows) {
  const byEmail = new Map();
  let skipped = 0;
  let duplicates = 0;
  const duplicateSample = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      skipped += 1;
      continue;
    }

    const email = normalizeEmail(field(row, ['email', 'Email']));
    if (!isUsableEmail(email)) {
      skipped += 1;
      continue;
    }

    const ib = normalizeFlag(field(row, ['IBC_flag', 'ibc_flag']));
    const ob = normalizeFlag(field(row, ['OBC_flag', 'obc_flag']));
    if (ib == null && ob == null) {
      skipped += 1;
      continue;
    }

    const companyid = primitive(field(row, ['companyid', 'companyId', 'company_id']));
    const next = {
      email,
      companyid: companyid == null ? '' : String(companyid),
      ib,
      ob,
    };

    const existing = byEmail.get(email);
    if (existing) {
      duplicates += 1;
      if (duplicateSample.length < SAMPLE_LIMIT) duplicateSample.push(email);
      if (companyRank(next.companyid) <= companyRank(existing.companyid)) continue;
    }
    byEmail.set(email, next);
  }

  return { byEmail, skipped, duplicates, duplicateSample };
}

function valuesDiffer(current, next) {
  if (next == null) return false;
  const nextFlag = normalizeFlag(next);
  if (nextFlag != null) return normalizeFlag(current) !== nextFlag;
  if (current == null || String(current).trim() === '') return true;
  return String(current).trim() !== String(next).trim();
}

function planUpdates(byEmail, contacts, ibProperty, obProperty) {
  const updates = [];
  let missing = 0;
  let unchanged = 0;
  const missingSample = [];

  for (const [email, row] of byEmail) {
    const contact = contacts.get(email);
    if (!contact) {
      missing += 1;
      if (missingSample.length < SAMPLE_LIMIT) missingSample.push(email);
      continue;
    }
    if (!/^\d+$/.test(contact.id)) {
      throw new Error('HubSpot returned a contact id that is not numeric');
    }

    const properties = {};
    const diffs = [];
    const candidates = [
      [ibProperty, row.ib],
      [obProperty, row.ob],
    ];
    for (const [prop, next] of candidates) {
      if (next == null) continue;
      const current = contact.properties ? contact.properties[prop] : undefined;
      if (!valuesDiffer(current, next)) continue;
      properties[prop] = next;
      diffs.push({
        prop,
        from: current == null || String(current).trim() === '' ? '(empty)' : String(current).trim(),
        to: next,
      });
    }

    if (Object.keys(properties).length === 0) {
      unchanged += 1;
      continue;
    }

    updates.push({
      id: contact.id,
      properties,
      email,
      companyid: row.companyid,
      diffs,
    });
  }

  return { updates, missing, unchanged, missingSample };
}

function publicError(err) {
  const message = err && typeof err.message === 'string' ? err.message : 'Sync failed';
  if (/-----BEGIN |Bearer\s+[A-Za-z0-9._-]{8,}/i.test(message)) {
    return 'Sync failed. Check the Railway variables. Credential details were omitted from this log.';
  }
  return message.slice(0, 800);
}

function logSamples(label, updates) {
  const shown = updates.slice(0, DIFF_LOG_LIMIT);
  for (const item of shown) {
    const changes = item.diffs.map((diff) => `${diff.prop} ${diff.from} -> ${diff.to}`).join('; ');
    const company = item.companyid || 'unknown';
    console.log(`[${label}] company=${company} ${item.email} ${changes}`);
  }
  if (updates.length > shown.length) {
    console.log(`... ${updates.length - shown.length} more contacts`);
  }
}

async function main() {
  const started = Date.now();
  const liveFlag = process.argv.includes('--live');
  const confirmed = (process.env.CONFIRM_LIVE_RUN || '').trim() === LIVE_CONFIRMATION;
  const write = liveFlag && confirmed;

  const missing = [
    'HUBSPOT_TOKEN',
    'BQ_PROJECT_ID',
    'GOOGLE_APPLICATION_CREDENTIALS_JSON',
    'HUBSPOT_IB_PROPERTY',
    'HUBSPOT_OB_PROPERTY',
  ].filter((name) => typeof process.env[name] !== 'string' || process.env[name].trim() === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const ibProperty = propertyName('HUBSPOT_IB_PROPERTY');
  const obProperty = propertyName('HUBSPOT_OB_PROPERTY');
  if (ibProperty === obProperty) {
    throw new Error('HUBSPOT_IB_PROPERTY and HUBSPOT_OB_PROPERTY must be different');
  }

  assertConfig();

  console.log(`BigQuery project ${process.env.BQ_PROJECT_ID.trim()}`);
  console.log(`HubSpot contact properties ${ibProperty}, ${obProperty}`);
  if (write) {
    console.log('Mode: live. Changed contacts will be updated.');
  } else if (liveFlag) {
    console.log('Mode: dry run. --live is set, but CONFIRM_LIVE_RUN is not yes-really-run-live.');
  } else {
    console.log('Mode: dry run. The start command must include --live before any write.');
  }

  const rows = await fetchCallRows();
  const indexed = indexRows(rows);
  console.log(
    `BigQuery rows ${rows.length}; usable emails ${indexed.byEmail.size}; skipped ${indexed.skipped}; duplicate emails ${indexed.duplicates}`
  );
  if (indexed.duplicateSample.length > 0) {
    console.log(`Duplicate email sample (kept highest company id): ${indexed.duplicateSample.join(', ')}`);
  }

  const contacts = await readContactsByEmail([...indexed.byEmail.keys()].sort(), [
    'email',
    ibProperty,
    obProperty,
  ]);
  const plan = planUpdates(indexed.byEmail, contacts, ibProperty, obProperty);

  console.log(
    `HubSpot found ${contacts.size}; missing ${plan.missing}; unchanged ${plan.unchanged}; to update ${plan.updates.length}`
  );
  if (plan.missingSample.length > 0) {
    console.log(`Missing contact sample: ${plan.missingSample.join(', ')}`);
  }

  logSamples(write ? 'update' : 'dry-run', plan.updates);

  let updated = 0;
  if (write) {
    updated = await updateContacts(plan.updates.map((item) => ({ id: item.id, properties: item.properties })));
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `Finished in ${seconds}s. Rows ${rows.length}, to update ${plan.updates.length}, updated ${updated}, writes ${write ? 'yes' : 'no'}.`
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(publicError(err));
      process.exit(1);
    });
}

module.exports = {
  normalizeFlag,
  valuesDiffer,
  indexRows,
  planUpdates,
};
