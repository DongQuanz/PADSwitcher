'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { atomicWrite, renameRetry } = require('../src/core/files.cjs');

test('rename waits out a file Windows briefly keeps locked',async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'pad-files-')); t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const target = path.join(directory,'connection.json'); await fs.writeFile(target,'old');
  const original = fs.rename; let failures = 0;
  fs.rename = async (...args) => { if (failures < 3) { failures++; throw Object.assign(new Error('locked'),{code:'EPERM'}); } return original(...args); };
  try { await atomicWrite(target,'new'); } finally { fs.rename = original; }
  assert.equal(failures,3); assert.equal(await fs.readFile(target,'utf8'),'new');
});
test('rename gives up on a permanent error and reports the original code',async () => {
  const original = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('missing'),{code:'ENOENT'}); };
  try { await assert.rejects(renameRetry('a','b',{delay:1}),{code:'ENOENT'}); } finally { fs.rename = original; }
});
test('rename stops retrying a lock that never clears',async () => {
  const original = fs.rename; let calls = 0;
  fs.rename = async () => { calls++; throw Object.assign(new Error('locked'),{code:'EBUSY'}); };
  try { await assert.rejects(renameRetry('a','b',{attempts:4,delay:1}),{code:'EBUSY'}); } finally { fs.rename = original; }
  assert.equal(calls,4);
});
