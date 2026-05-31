const fs = require('fs');

console.log('Looking for JSON files...');

const files = [
  'lexical-academic.json',
  'lexical-business.json',
  'lexical-creative.json',
  'lexical-general.json'
];

for (const file of files) {
  if (fs.existsSync(file)) {
    console.log(`Found: ${file}`);
  } else {
    console.log(`Missing: ${file}`);
  }
}

const academic = JSON.parse(fs.readFileSync('lexical-academic.json', 'utf8'));
const business = JSON.parse(fs.readFileSync('lexical-business.json', 'utf8'));
const creative = JSON.parse(fs.readFileSync('lexical-creative.json', 'utf8'));
const general = JSON.parse(fs.readFileSync('lexical-general.json', 'utf8'));

const academicWithDomain = academic.map(entry => ({ ...entry, domain: 'academic' }));
const businessWithDomain = business.map(entry => ({ ...entry, domain: 'business' }));
const creativeWithDomain = creative.map(entry => ({ ...entry, domain: 'creative' }));
const generalWithDomain = general.map(entry => ({ ...entry, domain: 'general' }));

const allEntries = [
  ...academicWithDomain,
  ...businessWithDomain,
  ...creativeWithDomain,
  ...generalWithDomain
];

const masterDatabase = {
  version: '1.0.0',
  created: new Date().toISOString(),
  totalEntries: allEntries.length,
  entries: allEntries
};

fs.writeFileSync('lexical-master.json', JSON.stringify(masterDatabase, null, 2));

console.log(`\n✅ Combined ${allEntries.length} entries into lexical-master.json`);
console.log(`   - Academic: ${academicWithDomain.length}`);
console.log(`   - Business: ${businessWithDomain.length}`);
console.log(`   - Creative: ${creativeWithDomain.length}`);
console.log(`   - General: ${generalWithDomain.length}`);