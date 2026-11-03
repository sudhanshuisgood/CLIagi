#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`Local Dost needs Node.js 18 or newer (you have ${process.versions.node}).`);
  console.error('Get it from https://nodejs.org');
  process.exit(1);
}

const { main } = await import('../src/cli.js');
main(process.argv.slice(2)).catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
