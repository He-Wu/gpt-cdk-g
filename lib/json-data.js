const fs = require('fs/promises');
const path = require('path');

async function readJsonFile(dataDir, fileName, fallback) {
  const filePath = path.join(dataDir, fileName);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
    }
    throw err;
  }
}

async function readJsonArray(dataDir, fileName) {
  const parsed = await readJsonFile(dataDir, fileName, []);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path.join(dataDir, fileName)} must contain a JSON array`);
  }
  return parsed;
}

async function readJsonObject(dataDir, fileName) {
  const parsed = await readJsonFile(dataDir, fileName, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path.join(dataDir, fileName)} must contain a JSON object`);
  }
  return parsed;
}

async function readAllJsonData(dataDir) {
  const [cards, records, settings, costRecords] = await Promise.all([
    readJsonArray(dataDir, 'cards.json'),
    readJsonArray(dataDir, 'records.json'),
    readJsonObject(dataDir, 'settings.json'),
    readJsonArray(dataDir, 'cost-records.json')
  ]);
  return { cards, records, settings, costRecords };
}

module.exports = {
  readAllJsonData,
  readJsonArray,
  readJsonFile,
  readJsonObject
};
