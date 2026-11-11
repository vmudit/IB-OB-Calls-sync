'use strict';

const fs = require('fs');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');

const SQL_PATH = path.join(__dirname, '..', 'sql', 'calls.sql');
const JOB_TIMEOUT_MS = 8 * 60 * 1000;

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function loadCredentials() {
  const raw = requiredEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON');
  if (!raw.startsWith('{')) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS_JSON must be the service-account JSON object, not a file path'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON must be a JSON object');
  }
  if (parsed.type !== 'service_account') {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON must be a service account key');
  }
  if (typeof parsed.client_email !== 'string' || !parsed.client_email.includes('@')) {
    throw new Error('Service account JSON is missing client_email');
  }
  if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('PRIVATE KEY')) {
    throw new Error('Service account JSON is missing private_key');
  }

  return parsed;
}

function projectId() {
  const value = requiredEnv('BQ_PROJECT_ID');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) {
    throw new Error('BQ_PROJECT_ID is not a valid GCP project id');
  }
  return value;
}

function location() {
  const value = process.env.BQ_LOCATION;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(trimmed)) {
    throw new Error('BQ_LOCATION contains unsupported characters');
  }
  return trimmed;
}

function assertConfig() {
  projectId();
  location();
  loadCredentials();
}

async function fetchCallRows() {
  const credentials = loadCredentials();
  const bigquery = new BigQuery({
    projectId: projectId(),
    credentials,
  });

  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const query = {
    query: sql,
    useLegacySql: false,
    jobTimeoutMs: JOB_TIMEOUT_MS,
  };
  const queryLocation = location();
  if (queryLocation) query.location = queryLocation;

  const [rows] = await bigquery.query(query);
  return rows;
}

module.exports = {
  assertConfig,
  fetchCallRows,
};
