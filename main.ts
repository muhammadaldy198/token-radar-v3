// Token Radar v3 — entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, scores every pre-token protocol with the model
// in lib/model.ts, writes the ranked board to /output/board.json, the
// dashboard's data to /output/data.js, copies dashboard/ and screenshots/ to
// /output, and writes /output/dossier.json with the vendored make.fun
// library. The run fails loudly — exit 1, no partial output claimed — when
// the board is invalid, a screenshot breaks its cap, or the dossier's text
// was truncated.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DOSSIER_MAX_BYTES = 1_572_864; // 1.5 MiB
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

/** Stop the run with a message on stderr and a non-zero exit. */
function fail(message: string): never {
  process.stderr.write(`token radar v3: ${message}\n`);
  process.exit(1);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start
 *  with a dot; returns the copied names. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3 or 4, the board, a detail view and a filtered view`);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
  }
  const size = statSync(join(out, 'screenshots', name)).size;
  if (size > SCREENSHOT_CAPS.max_bytes) {
    fail(`screenshots/${name} is ${size} bytes, over the ${SCREENSHOT_CAPS.max_bytes} cap: re-export it smaller`);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and
// compares bytes.
const dossierBytes = buildDossier(out, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: SCREENSHOT_CAPS,
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
writeFileSync(join(out, 'dossier.json'), dossierBytes);

// Read the dossier back: fail loudly when the dashboard text was truncated
// (the "[Cut at" marker) or the dossier broke the 1.5 MiB hard cap, instead
// of handing in an entry the judge can only half-read.
const dossierText = new TextDecoder().decode(dossierBytes);
if (dossierText.includes('[Cut at')) {
  fail('the dashboard text was cut to fit 65,536 bytes: shrink dashboard/ before submitting');
}
if (dossierBytes.length > DOSSIER_MAX_BYTES) {
  fail(`dossier.json is ${dossierBytes.length} bytes, over the 1.5 MiB cap`);
}
const dossierTextLen = (JSON.parse(dossierText) as { text?: string }).text?.length ?? 0;

process.stdout.write(
  `token radar v3: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored ` +
    `(${radar.early_size} early, ${radar.off_list_size} off-list, ${radar.live_total} live set aside)\n` +
    `token radar v3: dossier.json ${dossierBytes.length.toLocaleString()} bytes ` +
    `(${(dossierBytes.length / DOSSIER_MAX_BYTES * 100).toFixed(0)}% of the 1.5 MiB cap), ` +
    `dashboard text ${dossierTextLen.toLocaleString()} bytes of the 65,536 cap\n` +
    `token radar v3: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} ` +
    `(${dashFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
