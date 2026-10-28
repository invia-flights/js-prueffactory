import { readFileSync } from 'node:fs';

export const own = readFileSync(new URL(import.meta.url), 'utf8').length;
