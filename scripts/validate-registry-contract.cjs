#!/usr/bin/env node

const fs = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'server.json');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 10_000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(fetchJson(new URL(response.headers.location, url).toString()));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Registry schema request returned HTTP ${response.statusCode}.`));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Registry schema response was not valid JSON.'));
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('Registry schema request timed out.')));
    request.on('error', (error) => reject(error));
  });
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (typeof manifest.$schema !== 'string' || !manifest.$schema.startsWith('https://static.modelcontextprotocol.io/')) {
    throw new Error('server.json must declare an official static.modelcontextprotocol.io schema URL.');
  }

  const schema = await fetchJson(manifest.$schema);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  if (!validate(manifest)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new Error(`server.json does not satisfy the MCP Registry schema: ${errors}`);
  }

  console.log(`Registry schema validation passed: ${manifest.$schema}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
