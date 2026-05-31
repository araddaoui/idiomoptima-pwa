const fs = require('fs');

// Define the CSV files and their output paths
const files = [
  { input: 'NativeWrite_Academic_Full_Database.csv', output: 'lexical-academic.json' },
  { input: 'NativeWrite_Business_Full_Database_V2.csv', output: 'lexical-business.json' },
  { input: 'NativeWrite_Creative_Full_Database_500.csv', output: 'lexical-creative.json' },
  { input: 'NativeWrite_General_Full_Database.csv', output: 'lexical-general.json' }
];

function convertCSV(inputFile, outputFile) {
  const content = fs.readFileSync(inputFile, 'utf8');
  const lines = content.split(/\r?\n/);
  const headers = lines[0].split(',');
  
  // Find column indices (support both formats)
  const clunkyIndex = headers.findIndex(h => {
    const trimmed = h.trim();
    return trimmed === 'clunky' || trimmed === 'Clunky Input';
  });
  const nativeIndex = headers.findIndex(h => {
    const trimmed = h.trim();
    return trimmed === 'native' || trimmed === 'Native Output';
  });
  const typeIndex = headers.findIndex(h => {
    const trimmed = h.trim();
    return trimmed === 'type' || trimmed === 'Type';
  });
  
  console.log(`Processing ${inputFile}: clunky index=${clunkyIndex}, native index=${nativeIndex}, type index=${typeIndex}`);
  
  const results = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Simple CSV parsing (handles quoted fields)
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    const clunky = values[clunkyIndex] ? values[clunkyIndex].replace(/^"|"$/g, '') : '';
    const native = values[nativeIndex] ? values[nativeIndex].replace(/^"|"$/g, '') : '';
    const type = values[typeIndex] ? values[typeIndex].replace(/^"|"$/g, '') : '';
    
    if (clunky && native) {
      results.push({
        clunky: clunky,
        native: native,
        type: type || 'general'
      });
    }
  }
  
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`Converted ${inputFile} → ${outputFile} (${results.length} entries)`);
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