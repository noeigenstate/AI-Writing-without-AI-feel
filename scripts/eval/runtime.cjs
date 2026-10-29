// Optional workaround for Windows managed runners whose account lookup fails.
// Only the tsx temporary-cache username needs a fallback; no credentials are read.
const os = require('node:os');
const original = os.userInfo;
os.userInfo = function (...args) {
  try { return original.apply(os, args); }
  catch (e) {
    if (process.platform !== 'win32' || e?.info?.syscall !== 'uv_os_get_passwd') throw e;
    return { username: 'evalpilot', homedir: os.homedir(), shell: null, uid: -1, gid: -1 };
  }
};

// The existing DOCX regression hardcodes a private root/test fixture and output.
// Opt-in redirection lets the unchanged acceptance script use a public synthetic
// fixture without ever opening or writing the prohibited directory.
if (process.env.EVALPILOT_CHECK_FIXTURES) {
  const path = require('node:path');
  const fsPromises = require('node:fs/promises');
  const { syncBuiltinESMExports } = require('node:module');
  const root = path.resolve(__dirname, '../..');
  const fixtureDir = path.resolve(process.env.EVALPILOT_CHECK_FIXTURES);
  if (!fixtureDir.startsWith(path.join(root, 'data/eval') + path.sep)) throw new Error('Check fixtures must stay under data/eval');
  const redirects = new Map(['AI替你炒股_紧凑版.docx', '_roundtrip_out.docx'].map(name => [path.join(root, 'test', name).toLowerCase(), path.join(fixtureDir, name)]));
  const redirect = file => typeof file === 'string' ? redirects.get(path.resolve(file).toLowerCase()) ?? file : file;
  for (const name of ['readFile', 'writeFile']) {
    const originalFs = fsPromises[name];
    fsPromises[name] = function (file, ...args) { return originalFs.call(fsPromises, redirect(file), ...args); };
  }
  syncBuiltinESMExports();
}
