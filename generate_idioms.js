const https = require('https');
const url = 'https://www.theidioms.com/common-idioms/';
https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    console.log('STATUS', res.statusCode);
    console.log('CONTENT_START', data.slice(0, 1000));
  });
}).on('error', (err) => {
  console.error('ERROR', err.message);
});
