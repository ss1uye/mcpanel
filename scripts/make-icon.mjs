import fs from 'node:fs';
import pngToIco from 'png-to-ico';

const png = fs.readFileSync('packaging/icon.png');
fs.writeFileSync('packaging/icon.ico', await pngToIco(png));
console.log('packaging/icon.ico written');
