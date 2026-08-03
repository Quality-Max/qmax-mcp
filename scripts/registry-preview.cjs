#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'server.json'), 'utf8'));
const npmPackage = manifest.packages.find((entry) => entry.registryType === 'npm');

console.log(JSON.stringify({
  name: manifest.name,
  title: manifest.title,
  description: manifest.description,
  version: manifest.version,
  repository: manifest.repository,
  package: npmPackage,
  invocation: `npx -y ${npmPackage.identifier}`,
}, null, 2));
