'use strict';

const axios = require('axios');

const BASE_URL = 'https://api.hubapi.com';
const BATCH_SIZE = 100;
const RETRY_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function token() {
  const value = process.env.HUBSPOT_TOKEN;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Missing required environment variable: HUBSPOT_TOKEN');
  }
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) {
    throw new Error('HUBSPOT_TOKEN must be a single token with no spaces');
  }
  return trimmed;
}

function redact(err, secret) {
  const status = err && err.response ? err.response.status : undefined;
  let detail = '';
  const data = err && err.response ? err.response.data : undefined;
  if (data && typeof data.message === 'string') detail = data.message;
  else if (err && typeof err.message === 'string') detail = err.message;

  if (secret && detail.includes(secret)) detail = 'request failed';
  detail = detail.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  detail = detail.replace(/private_key["']?\s*[:=]\s*["'][^"']+["']/gi, 'private_key=[redacted]');

  if (status) {
    return new Error(`HubSpot request failed (${status}): ${detail.slice(0, 300)}`);
  }
  return new Error(detail.slice(0, 300) || 'HubSpot request failed');
}

function client(secret) {
  return axios.create({
    baseURL: BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    validateStatus: (status) => status >= 200 && status < 300,
    maxContentLength: 5 * 1024 * 1024,
    maxBodyLength: 1024 * 1024,
  });
}

async function request(fn, secret) {
  try {
    return await fn();
  } catch (err) {
    if (err.response && err.response.status === 429) {
      await sleep(RETRY_DELAY_MS);
      try {
        return await fn();
      } catch (retryErr) {
        throw redact(retryErr, secret);
      }
    }
    throw redact(err, secret);
  }
}

function assertNoUnexpectedErrors(payload) {
  const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];
  const fatal = errors.filter((item) => item && item.category !== 'OBJECT_NOT_FOUND');
  if (fatal.length > 0) {
    const first = fatal[0];
    const category = typeof first.category === 'string' ? first.category : 'ERROR';
    const message = typeof first.message === 'string' ? first.message : 'batch request failed';
    throw new Error(`HubSpot batch read failed (${category}): ${message.slice(0, 300)}`);
  }
}

async function readContactsByEmail(emails, properties) {
  const secret = token();
  const http = client(secret);
  const found = new Map();
  const batches = chunk(emails, BATCH_SIZE);

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    console.log(`HubSpot batch read ${i + 1}/${batches.length} (${batch.length} emails)`);
    const response = await request(
      () =>
        http.post('/crm/v3/objects/contacts/batch/read', {
          idProperty: 'email',
          properties,
          inputs: batch.map((id) => ({ id })),
        }),
      secret
    );

    assertNoUnexpectedErrors(response.data);
    const results = response.data && Array.isArray(response.data.results) ? response.data.results : [];
    for (const row of results) {
      const email = row && row.properties && typeof row.properties.email === 'string'
        ? row.properties.email.trim().toLowerCase()
        : '';
      const id = row && row.id != null ? String(row.id) : '';
      if (!email || !/^\d+$/.test(id)) continue;
      found.set(email, {
        id,
        properties: row.properties || {},
      });
    }
  }

  return found;
}

async function updateContacts(inputs) {
  if (inputs.length === 0) return 0;

  const secret = token();
  const http = client(secret);
  const batches = chunk(inputs, BATCH_SIZE);
  let updated = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    console.log(`HubSpot batch update ${i + 1}/${batches.length} (${batch.length} contacts)`);
    await request(
      () =>
        http.post('/crm/v3/objects/contacts/batch/update', {
          inputs: batch,
        }),
      secret
    );
    updated += batch.length;
  }

  return updated;
}

module.exports = {
  readContactsByEmail,
  updateContacts,
  BATCH_SIZE,
};
