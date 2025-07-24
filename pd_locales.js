const fs = require('fs');
const path = require('path');

const localeDir = './data/l10n';

// Get all locale files
function processLocaleFiles() {
  if (!fs.existsSync(localeDir)) {
    console.error(`Locale directory ${localeDir} does not exist`);
    return;
  }

  fs.readdir(localeDir, (err, files) => {
    if (err) throw err;

    files.forEach(file => {
      if (!file.endsWith('.json')) return;

      const filePath = path.join(localeDir, file);
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) throw err;

        let content = data;

        // Replace OpenStreetMap references with OSM Sandbox
        content = content.replace(/OpenStreetMap/g, 'OSM Sandbox');

        // Replace GitHub references
        content = content.replace(/\(https:\/\/github\.com\/openstreetmap\/iD\)/g, '(https://github.com/osm-sandbox/sandbox-rapid)');
        content = content.replace(/\(https:\/\/github\.com\/facebook\/rapid\)/g, '(https://github.com/osm-sandbox/sandbox-rapid)');

        // Replace copyright and licensing links
        content = content.replace(/https:\/\/www\.openstreetmap\.org\/copyright/g, 'https://www.publicdomainmap.org/license');
        content = content.replace(/\(https:\/\/www\.openstreetmap\.org\/\)/g, '(https://www.publicdomainmap.org/)');

        // Replace site-specific references
        content = content.replace(/on openstreetmap\.org/g, 'on osmsandbox.us');
        content = content.replace(/History on osm\.org/g, 'History on osmsandbox.us');
        content = content.replace(/openstreetmap\.org/g, 'osmsandbox.us');

        // Replace Rapid-specific references
        content = content.replace(/Rapid/g, 'OSM Sandbox Rapid');
        content = content.replace(/RapiD/g, 'OSM Sandbox Rapid');

        fs.writeFile(filePath, content, (err) => {
          if (err) throw err;
          console.log(`Processed ${file}`);
        });
      });
    });
  });
}

console.log('Processing locale files for OSM Sandbox rebranding...');
processLocaleFiles();
