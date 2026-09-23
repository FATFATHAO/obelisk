// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Integration test for the caller-side watcher filter in indexer-service:
// the adaptive-watcher package is domain-agnostic (ADR-0009), so the caller
// must forward DeepSeek Harness transcripts (.jsonl.zstd) and directory-level
// events (renames arrive as bare paths) — a provider-side filter can never
// fix events dropped here.

import { test, mock } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const SERVICE_URL = new URL('../app/src/main/indexer-service.ts', import.meta.url);
const WATCHER_URL = new URL('../../../packages/adaptive-watcher/src/index.ts', SERVICE_URL).href;

function manualTimers() {
  const pending = new Set();
  return {
    setTimeout: (fn) => { pending.add(fn); return fn; },
    clearTimeout: (fn) => pending.delete(fn),
    flush: () => { for (const fn of [...pending]) fn(); pending.clear(); },
  };
}

test('caller routes provider-declared exact files regardless of suffix', async () => {
  let captured = null;
  const ctx = mock.module(WATCHER_URL, {
    namedExports: {
      createAdaptiveWatcher: (opts) => {
        captured = opts;
        return { stop() {}, ready: Promise.resolve() };
      },
    },
  });
  try {
    const { createIndexerService } = await import(`../app/src/main/indexer-service.ts?watcher-filter=${Date.now()}`);
    const timers = manualTimers();
    const builds = [];
    const dir = mkdtempSync(join(tmpdir(), 'obelisk-wf-'));
    const sourceDb = join(dir, 'db.sqlite');
    const pinnedTranscript = join(dir, 'history.jsonl');
    writeFileSync(sourceDb, 'sqlite fixture');
    writeFileSync(pinnedTranscript, '');
    const service = createIndexerService({
      buildIndex: async (args) => builds.push(args),
      watchTargets: [
        { kind: 'tree', path: dir },
        { kind: 'file', path: sourceDb },
        { kind: 'file', path: pinnedTranscript },
      ],
      writeHeartbeat: () => {},
      timers,
      stabilityMs: 0,
    });
    service.start({ buildOnStart: false });

    // Only transcripts discovered under a tree join the hot overlay.
    assert.equal(captured.shouldPromote(join(dir, 'session.jsonl.zstd')), true, '.jsonl.zstd promotes');
    assert.equal(captured.shouldPromote(join(dir, 'session.jsonl')), true);
    assert.equal(captured.shouldPromote(join(dir, 'notes.txt')), false);
    assert.equal(captured.shouldPromote(pinnedTranscript), false, 'pinned .jsonl stays out of the hot overlay');

    mkdirSync(join(dir, 'repo.v2')); // dotted directory name
    writeFileSync(join(dir, 'notes.txt'), 'x'); // plain non-transcript file
    const unrelatedDb = join(dir, 'unrelated.sqlite');
    writeFileSync(unrelatedDb, 'not a provider target');

    // Transcripts forward synchronously.
    captured.onInvalidate({ type: 'paths', paths: [join(dir, 'sid', 'session.jsonl.zstd')] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(builds.map((b) => b.changedPaths ?? []), [[join(dir, 'sid', 'session.jsonl.zstd')]]);

    // Exact file targets are provider-declared sources. Their suffix is not a
    // caller-side concern, and they are already pinned in the file poller.
    captured.onInvalidate({ type: 'paths', paths: [sourceDb] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(builds.at(-1).changedPaths, [sourceDb], 'exact file update reaches the indexer');

    // Non-transcripts resolve asynchronously: real directories and missing
    // paths (rename sources) forward; real stray files are dropped.
    captured.onInvalidate({
      type: 'paths',
      paths: [join(dir, 'repo.v2'), join(dir, 'notes.txt'), unrelatedDb, join(dir, 'renamed-away')],
    });
    const forwarded = await (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        timers.flush();
        const all = builds.flatMap((b) => b.changedPaths ?? []);
        if (all.some((p) => p.endsWith('repo.v2')) && all.some((p) => p.endsWith('renamed-away'))) return all;
      }
      return builds.flatMap((b) => b.changedPaths ?? []);
    })();
    assert.ok(forwarded.some((p) => p.endsWith('repo.v2')), 'dotted directory forwarded');
    assert.ok(forwarded.some((p) => p.endsWith('renamed-away')), 'missing rename source forwarded');
    assert.ok(!forwarded.some((p) => p.endsWith('notes.txt')), 'real stray file dropped');
    assert.ok(!forwarded.includes(unrelatedDb), 'non-target SQLite file dropped');
    service.stop();
  } finally {
    ctx.restore();
    mock.reset();
  }
});

// Owner's third review: the hermes adapter's own watchTargets() has to put each profile store in
// front of this caller as an exact file target. A `.db` file under the tree target is dropped by
// the transcript filter below, so a profile write that is not declared exactly waits for the
// periodic reconcile — this drives the real provider's list, not a hand-written stand-in.
test('a hermes profile store is declared exactly and reaches the indexer', async () => {
  let captured = null;
  const ctx = mock.module(WATCHER_URL, {
    namedExports: {
      createAdaptiveWatcher: (opts) => {
        captured = opts;
        return { stop() {}, ready: Promise.resolve() };
      },
    },
  });
  try {
    const { createHermesProvider } = await import('../packages/core/src/providers/hermes.ts');
    const { createIndexerService } = await import(`../app/src/main/indexer-service.ts?watcher-hermes=${Date.now()}`);
    const home = mkdtempSync(join(tmpdir(), 'obelisk-hermes-wf-'));
    const profileStore = join(home, 'profiles', 'coder', 'state.db');
    mkdirSync(join(home, 'profiles', 'coder'), { recursive: true });
    writeFileSync(profileStore, 'sqlite fixture');
    writeFileSync(`${profileStore}-wal`, '');

    const provider = createHermesProvider({
      rootDir: home,
      openStore: () => { throw new Error('the watcher filter must not open a store'); },
    });
    const targets = provider.watchTargets(home);
    assert.ok(
      targets.some((target) => target.kind === 'file' && target.path === profileStore),
      'the real watchTargets() output names the profile store exactly',
    );

    const timers = manualTimers();
    const builds = [];
    const service = createIndexerService({
      buildIndex: async (args) => builds.push(args),
      watchTargets: targets,
      writeHeartbeat: () => {},
      timers,
      stabilityMs: 0,
    });
    service.start({ buildOnStart: false });

    // A declared exact file forwards on the event, suffix or not, and stays out of the hot
    // overlay because the file poller already pins it.
    captured.onInvalidate({ type: 'paths', paths: [`${profileStore}-wal`] });
    timers.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      builds.at(-1).changedPaths,
      [`${profileStore}-wal`],
      'a profile store update reaches the indexer',
    );
    assert.equal(captured.shouldPromote(profileStore), false, 'a pinned exact file stays out of the hot overlay');

    // Contrast: a profile that appeared after the target list was computed is only a `.db` file
    // under the tree, and the caller still filters those (the suffix filter is not switched off).
    const lateStore = join(home, 'profiles', 'late', 'state.db');
    mkdirSync(join(home, 'profiles', 'late'), { recursive: true });
    writeFileSync(lateStore, 'sqlite fixture');
    captured.onInvalidate({ type: 'paths', paths: [lateStore] });
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      timers.flush();
    }
    assert.equal(
      builds.flatMap((build) => build.changedPaths ?? []).includes(lateStore),
      false,
      'an undeclared database file under the tree is still filtered out',
    );
    service.stop();
  } finally {
    ctx.restore();
    mock.reset();
  }
});
