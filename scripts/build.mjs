// Builds README.md from tools.json: every tool, how I use it, and the public projects it is in.
//
// The projects under each tool are found, not typed: the script reads my public repositories (and any other
// public repository a project lists) and matches each tool's `find` rules against what is there:
//   lang      a language that makes up at least 5% of the code     ("Swift")
//   files     a path in the repository, as a regular expression     ("(^|/)vercel\\.json$")
//   deps      a package.json dependency                             ("next")
//   cargo     a Cargo.toml dependency                               ("redis")
//   swiftpm   a Swift package dependency, by repository name        ("GRDB")
//   topics    a repository topic                                    ("swiftui")
//   repoName  the repository's name, as a regular expression        ("^homebrew-")
// `also` adds projects by name where there is no public code to read (a game, a private build).
// Only public repositories are read, so private projects are never named.
//
//   GITHUB_TOKEN=... node scripts/build.mjs          writes README.md
//   GITHUB_TOKEN=... node scripts/build.mjs --check  prints what each tool was matched to

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const LANG_SHARE = 0.05;
const FIND_KEYS = ['lang', 'files', 'deps', 'cargo', 'swiftpm', 'topics', 'repoName'];
const MAX_FEATURED = 17; // the profile shows 17 tools and a "+N more" tile

/** Throws with every problem in tools.json at once, so a bad edit fails with a clear message. */
export function validate(cfg) {
  const problems = [];
  if (!cfg.owner) problems.push('owner is missing');
  if (!Array.isArray(cfg.kinds) || !cfg.kinds.length) problems.push('kinds must be a non-empty list');
  if (!Array.isArray(cfg.tools)) problems.push('tools must be a list');
  const projects = new Set((cfg.projects ?? []).map((p) => p.name));
  const names = new Set();
  for (const [i, t] of (cfg.tools ?? []).entries()) {
    const at = `tools[${i}]${t?.name ? ` (${t.name})` : ''}`;
    if (!t?.name) problems.push(`${at}: name is missing`);
    else if (names.has(t.name)) problems.push(`${at}: duplicate name`);
    names.add(t?.name);
    if (!cfg.kinds?.includes(t?.kind)) problems.push(`${at}: kind "${t?.kind}" is not one of ${JSON.stringify(cfg.kinds)}`);
    if (typeof t?.note !== 'string') problems.push(`${at}: note must be a string (it can be empty)`);
    for (const key of Object.keys(t?.find ?? {})) {
      if (!FIND_KEYS.includes(key)) problems.push(`${at}: unknown find rule "${key}"`);
      for (const re of key === 'files' || key === 'repoName' ? t.find[key] : []) {
        try { new RegExp(re); } catch { problems.push(`${at}: bad pattern ${JSON.stringify(re)}`); }
      }
    }
    for (const name of t?.also ?? []) if (!projects.has(name)) problems.push(`${at}: "also" names "${name}", which is not in projects`);
  }
  const featured = (cfg.tools ?? []).filter((t) => t?.featured).length;
  if (featured > MAX_FEATURED) problems.push(`${featured} tools are featured; the profile shows at most ${MAX_FEATURED}`);
  if (problems.length) throw new Error(`tools.json:\n  ${problems.join('\n  ')}`);
  return cfg;
}

async function gh(url, init = {}) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com/${url}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'armoury-build', ...init.headers },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const graphql = (query, variables) => gh('graphql', { method: 'POST', body: JSON.stringify({ query, variables }) }).then((r) => {
  if (r.errors) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.data;
});

const REPO_FIELDS = `nameWithOwner name isPrivate isArchived defaultBranchRef { name }
  repositoryTopics(first: 20) { nodes { topic { name } } }
  languages(first: 20) { totalSize edges { size node { name } } }`;

async function publicRepos(owner, extra) {
  const data = await graphql(`query($owner: String!) { user(login: $owner) {
    repositories(first: 100, privacy: PUBLIC, ownerAffiliations: OWNER, isFork: false) { nodes { ${REPO_FIELDS} } } } }`, { owner });
  const repos = data.user.repositories.nodes;
  for (const full of extra) {
    if (repos.some((r) => r.nameWithOwner === full)) continue;
    const [o, n] = full.split('/');
    const r = await graphql(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { ${REPO_FIELDS} } }`, { o, n });
    if (r.repository && !r.repository.isPrivate) repos.push(r.repository);
  }
  return repos.filter((r) => !r.isArchived && r.defaultBranchRef);
}

// What a repository holds: its paths, languages, topics and declared dependencies.
async function inspect(repo) {
  const branch = repo.defaultBranchRef.name;
  const tree = await gh(`repos/${repo.nameWithOwner}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (tree.truncated) console.warn(`${repo.nameWithOwner}: GitHub returned only part of the file list, so some tools may be missed.`);
  const paths = tree.tree.filter((n) => n.type === 'blob').map((n) => n.path).filter((p) => !/(^|\/)(node_modules|vendor|\.build)\//.test(p));
  const raw = (p) => fetch(`https://raw.githubusercontent.com/${repo.nameWithOwner}/${branch}/${p}`).then((r) => (r.ok ? r.text() : ''));
  const deps = new Set(), cargo = new Set(), swiftpm = new Set();
  for (const p of paths.filter((p) => /(^|\/)package\.json$/.test(p))) {
    try {
      const j = JSON.parse(await raw(p));
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) for (const d of Object.keys(j[k] ?? {})) deps.add(d);
    } catch { /* not JSON we can read: skip it */ }
  }
  for (const p of paths.filter((p) => /(^|\/)Cargo\.toml$/.test(p))) {
    let section = '';
    for (const line of (await raw(p)).split('\n')) {
      const s = line.match(/^\s*\[([^\]]+)\]/);
      if (s) { section = s[1]; continue; }
      const d = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
      if (d && /dependencies$/.test(section)) cargo.add(d[1]);
    }
  }
  for (const p of paths.filter((p) => /(^|\/)Package\.swift$/.test(p))) {
    for (const m of (await raw(p)).matchAll(/url:\s*"[^"]*\/([^/"]+?)(?:\.git)?"/g)) swiftpm.add(m[1].replace(/\.swift$/i, ''));
  }
  const total = repo.languages.totalSize || 1;
  const lang = new Set(repo.languages.edges.filter((e) => e.size / total >= LANG_SHARE).map((e) => e.node.name));
  const topics = new Set(repo.repositoryTopics.nodes.map((n) => n.topic.name));
  return { name: repo.nameWithOwner, short: repo.name, paths, lang, topics, deps, cargo, swiftpm };
}

/** Whether a repository (as `inspect` describes it) meets any of a tool's `find` rules. */
export function matches(find, r) {
  if (!find) return false;
  const any = (list, test) => (list ?? []).some(test);
  return any(find.lang, (l) => r.lang.has(l))
    || any(find.topics, (t) => r.topics.has(t))
    || any(find.deps, (d) => r.deps.has(d))
    || any(find.cargo, (d) => r.cargo.has(d))
    || any(find.swiftpm, (d) => [...r.swiftpm].some((s) => s.toLowerCase() === d.toLowerCase()))
    || any(find.files, (re) => r.paths.some((p) => new RegExp(re).test(p)))
    || any(find.repoName, (re) => new RegExp(re).test(r.short));
}

const esc = (s) => String(s).replace(/\|/g, '\\|');

async function main() {
  if (!TOKEN) throw new Error('Set GITHUB_TOKEN (any token that can read public repositories).');
  const cfg = validate(JSON.parse(await readFile(path.join(ROOT, 'tools.json'), 'utf8')));
  const listed = cfg.projects.flatMap((p) => p.repos ?? []);
  const repos = await publicRepos(cfg.owner, listed.filter((r) => !r.startsWith(`${cfg.owner}/`)));
  const seen = await Promise.all(repos.map(inspect));
  // A repository belongs to the project that lists it; any other public repository is a project of its own.
  const projectOf = (repoName) => cfg.projects.find((p) => (p.repos ?? []).includes(repoName))
    ?? { name: repoName.split('/')[1], url: `https://github.com/${repoName}` };
  const order = (p) => { const i = cfg.projects.findIndex((q) => q.name === p.name); return i < 0 ? 999 : i; };

  const rows = cfg.tools.map((tool) => {
    const found = new Map();
    for (const r of seen) if (matches(tool.find, r)) { const p = projectOf(r.name); found.set(p.name, p); }
    for (const name of tool.also ?? []) { const p = cfg.projects.find((q) => q.name === name); if (p) found.set(p.name, p); }
    return { tool, projects: [...found.values()].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)) };
  });

  if (process.argv.includes('--check')) {
    for (const { tool, projects } of rows) console.log(`${tool.name.padEnd(24)} ${projects.map((p) => p.name).join(', ') || '-'}`);
    return;
  }

  const sections = cfg.kinds.map((kind) => {
    const list = rows.filter((r) => r.tool.kind === kind);
    if (!list.length) return '';
    const body = list.map(({ tool, projects }) => `| **${esc(tool.name)}** | ${esc(tool.note || ' ')} | ${projects.map((p) => `[${esc(p.name)}](${p.url})`).join(', ') || ' '} |`).join('\n');
    return `## ${kind[0].toUpperCase()}${kind.slice(1)}\n\n| Tool | How I use it | Public projects |\n| --- | --- | --- |\n${body}\n`;
  }).filter(Boolean);

  const readme = `<!-- Generated by scripts/build.mjs from tools.json. Edit tools.json, not this file. -->

# Armoury

The tools I work with, how I use each one, and the public projects it is in. ${cfg.tools.length} tools in all.
The projects are read from my public repositories every day, so the lists keep up as I build.

${sections.join('\n')}
## How this list is built

[tools.json](tools.json) holds the tools and the notes. Once a day, [scripts/build.mjs](scripts/build.mjs) reads my public
repositories (their languages, files, dependencies and topics), matches each tool to the projects that use it, and
rewrites this page. Private repositories are never read. To run it yourself: \`GITHUB_TOKEN=... node scripts/build.mjs\`.

Spotted something wrong? [Open an issue](https://github.com/${cfg.owner}/armoury/issues).

Tool names and logos belong to their owners; they are named here only to say what I work with.
The code is under the [MIT License](LICENSE).
`;
  await writeFile(path.join(ROOT, 'README.md'), readme);
  console.log(`README.md: ${cfg.tools.length} tools across ${seen.length} public repositories.`);
}

// Run only when executed directly, so the tests can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
