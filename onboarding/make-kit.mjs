// Assembles the drop-in onboarding kit for a new client machine: one folder to
// copy onto the machine, whose Claude is then pointed at SETUP.md. The kit is
// GENERATED rather than committed so the watcher twins and the shared skill have
// exactly one source of truth — regenerate after changing either.
//
//   node onboarding/make-kit.mjs [--out <dir>] [--url <bus base url>] [--embed-token]
//
// By default the kit carries NO credentials: it ships bus-config.env.example and the
// setup has the operator fill in a local copy, so the token never passes through a
// chat transcript. --url pre-fills the bus URL only. --embed-token additionally reads
// MCP_API_KEY from this server's service-config.env into the kit — convenient for a
// hand-carried copy, but then the folder is a secret and must be treated as one.
// Default output: <repo>/dist/cross-claude-kit (gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT   = path.resolve(flag('--out', path.join(REPO, 'dist', 'cross-claude-kit')));
const URL   = flag('--url', '');
const EMBED = argv.includes('--embed-token');

function readToken() {
  const cfg = path.join(REPO, 'service-config.env');
  const line = fs.readFileSync(cfg, 'utf8').split(/\r?\n/).find(l => /^MCP_API_KEY=/i.test(l));
  if (!line) throw new Error(`no MCP_API_KEY in ${cfg}`);
  return line.split('=').slice(1).join('=').trim();
}

const COPIES = [
  ['onboarding/SETUP.md', 'SETUP.md'],
  ['onboarding/bus-config.env.example', 'bus-config.env.example'],
  ['onboarding/templates/CLAUDE-md-block.md', 'templates/CLAUDE-md-block.md'],
  ['onboarding/templates/skill-machine-section.md', 'templates/skill-machine-section.md'],
  ['onboarding/templates/memory-cross-claude-bus.md', 'templates/memory-cross-claude-bus.md'],
  ['skill/SKILL.md', 'skill/SKILL.md'],
  ['bus-watch.mjs', 'bus-watch.mjs'],
  ['bus-watch.py', 'bus-watch.py'],
];

fs.rmSync(OUT, { recursive: true, force: true });
for (const [from, to] of COPIES) {
  const dest = path.join(OUT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(REPO, from), dest);
}

// A pre-filled bus-config.env is written only when asked for: without it the kit
// carries nothing secret and the operator fills in their own copy on the target.
let filled = '';
if (URL || EMBED) {
  fs.writeFileSync(path.join(OUT, 'bus-config.env'),
    `# Written by make-kit.mjs. ${EMBED ? 'CONTAINS THE BUS TOKEN — treat this folder as a secret.' : 'Fill in MCP_API_KEY yourself.'}\n` +
    `BUS_URL=${URL}\nMCP_API_KEY=${EMBED ? readToken() : ''}\n`);
  filled = `  bus-config.env   (url=${URL || 'blank'}, token=${EMBED ? 'EMBEDDED' : 'blank'})\n`;
}

console.log(`kit written to ${OUT}`);
console.log(COPIES.map(([, to]) => `  ${to}`).join('\n'));
if (filled) process.stdout.write(filled);
console.log('\nCopy that folder to the new machine, then tell its Claude: "set up cross-claude, read SETUP.md in <folder>".');
if (EMBED) console.log('It carries the bus token: hand-carry it, and delete it from the target when setup is done.');
