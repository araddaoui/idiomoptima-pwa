const fs = require('fs');

// Read all JSON files
const academic = JSON.parse(fs.readFileSync('lexical-academic.json', 'utf8'));
const business = JSON.parse(fs.readFileSync('lexical-business.json', 'utf8'));
const creative = JSON.parse(fs.readFileSync('lexical-creative.json', 'utf8'));
const general = JSON.parse(fs.readFileSync('lexical-general.json', 'utf8'));

// Add domain property to each entry
const academicWithDomain = academic.map(entry => ({ ...entry, domain: 'academic' }));
const businessWithDomain = business.map(entry => ({ ...entry, domain: 'business' }));
const creativeWithDomain = creative.map(entry => ({ ...entry, domain: 'creative' }));
const generalWithDomain = general.map(entry => ({ ...entry, domain: 'general' }));

// Combine all entries
const allEntries = [
  ...academicWithDomain,
  ...businessWithDomain,
  ...creativeWithDomain,
  ...generalWithDomain
];

// Create the master database object
const masterDatabase = {
  version: '1.0.0',
  created: new Date().toISOString(),
  totalEntries: allEntries.length,
  entries: allEntries
};

// Write the combined file
fs.writeFileSync('lexical-master.json', JSON.stringify(masterDatabase, null, 2));

console.log(`Combined ${allEntries.length} entries into lexical-master.json`);
console.log(`  - Academic: ${academicWithDomain.length}`);
console.log(`  - Business: ${businessWithDomain.length}`);
console.log(`  - Creative: ${creativeWithDomain.length}`);
console.log(`  - General: ${generalWithDomain.length}`);