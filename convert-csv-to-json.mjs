import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define the CSV files and their output paths
const files = [
  { input: 'NativeWrite_Academic_Full_Database.csv', output: 'lexical-academic.json' },
  { input: 'NativeWrite_Business_Full_Database_V2.csv', output: 'lexical-business.json' },
  { input: 'NativeWrite_Creative_Full_Database_500.csv', output: 'lexical-creative.json' },
  { input: 'NativeWrite_General_Full_Database.csv', output: 'lexical-general.json' }
];

// Function to convert a single CSV to JSON
function convertCSV(inputFile, outputFile) {
  const results = [];
  
  fs.createReadStream(inputFile)
    .pipe(csv())
    .on('data', (data) => {
      // Handle different CSV column names
      const clunky = data.clunky || data['Clunky Input'] || data.c || data['Clunky Input (c)'];
      const native = data.native || data['Native Output'] || data.n || data['Native Output (n)'];
      const type = data.type || data.Type;
      
      if (clunky && native) {
        results.push({
          clunky: clunky.trim(),
          native: native.trim(),
          type: type || 'general'
        });
      }
    })
    .on('end', () => {
      fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
      console.log(`Converted ${inputFile} → ${outputFile} (${results.length} entries)`);
    });
}

// Run conversion for all files
files.forEach(file => {
  if (fs.existsSync(file.input)) {
    convertCSV(file.input, file.output);
  } else {
    console.log(`File not found: ${file.input}`);
  }
});

console.log('Conversion complete!');