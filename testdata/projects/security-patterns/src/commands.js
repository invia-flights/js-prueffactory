'use strict';

const { exec } = require('child_process');

const dir = process.argv[2];

// Literal commands are fine. Every other line below builds its command from dir.
exec('ls');
exec(`ls`);
exec(`ls ${dir}`);
exec(`ls` + dir);
exec('ls ' + dir);
