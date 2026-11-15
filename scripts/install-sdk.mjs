import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv.slice(2).filter(value => value !== '--')[0];
if (!source) throw new Error('Usage: pnpm sdk:install -- <SDK artifact directory>');
const result = spawnSync(process.execPath, [path.resolve(source, 'install-sdk.mjs'), path.resolve(source), root], {stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
