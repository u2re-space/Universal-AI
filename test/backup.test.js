import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeTextFile, deleteFile } from '../src/agent/fs-tools.js';
import { listProjectBackups, restoreProjectBackup } from '../src/agent/project-backup.js';

test('an overwrite keeps the previous bytes and restore puts them back', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-backup-'));
    try {
        await writeTextFile({ root, file: 'src/app.js', content: 'one\n', backupSlot: 's01-surface' });
        const changed = await writeTextFile({ root, file: 'src/app.js', content: 'two\n', backupSlot: 's01-body' });
        assert.equal(changed.projectBackup.slot, 's01-body');
        assert.equal(changed.projectBackup.path, 'src/app.js');
        const listed = await listProjectBackups({ root, file: 'src/app.js' });
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, changed.projectBackup.id);
        await writeTextFile({ root, file: 'src/app.js', content: 'lost\n', backupSlot: 's02-body' });
        const restored = await restoreProjectBackup({ root, id: changed.projectBackup.id, file: 'src/app.js' });
        assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'one\n');
        assert.equal(restored.slot, 's01-body');
        assert.ok(restored.replaced);
        const after = await listProjectBackups({ root, file: 'src/app.js' });
        assert.equal(after.at(-1).slot, `before-${changed.projectBackup.id}`);
        await assert.rejects(() => restoreProjectBackup({ root, id: changed.projectBackup.id, file: 'other.js' }), /не other\.js/);
        await assert.rejects(() => restoreProjectBackup({ root, id: 'missing' }), /не найден/);
        const removed = await deleteFile({ root, file: 'src/app.js', backupSlot: 's03-body' });
        assert.equal(removed.projectBackup.path, 'src/app.js');
        await restoreProjectBackup({ root, id: removed.projectBackup.id });
        assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'one\n');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
