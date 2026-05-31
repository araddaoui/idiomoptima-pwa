const fs = require('fs');
const academic = JSON.parse(fs.readFileSync('lexical-academic.json', 'utf8'));
const business = JSON.parse(fs.readFileSync('lexical-business.json', 'utf8'));
const creative = JSON.parse(fs.readFileSync('lexical-creative.json', 'utf8'));
const general = JSON.parse(fs.readFileSync('lexical-general.json', 'utf8'));
const all = [...academic, ...business, ...creative, ...general];
const db = { version: '1.0', entries: all };
fs.writeFileSync('lexical-master.json', JSON.stringify(db, null, 2));
console.log('Done:', all.length + ' entries');
