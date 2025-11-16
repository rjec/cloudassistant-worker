const fs = require('fs');
const path = require('path');
const arg = process.argv[2] || '';
if(!arg){
  console.error('Usage: node scripts/set-worker-base.js <worker-base-url>');
  process.exit(1);
}
const file = path.join(__dirname, '..', 'public', 'worker-config.json');
const config = { workerBase: arg };
fs.writeFileSync(file, JSON.stringify(config, null, 2));
console.log('Updated', file, '->', arg);
