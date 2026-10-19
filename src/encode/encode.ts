import { resolveInside } from '../agent/paths.js';

export type EncodeArtifact = {
    id: string;
    body: string;
    hintLanguage: string | null;
    hintPath: string | null;
};

/**
 * Write each artifact body to its hint path. A bad hint fails before any write.
 * @param {object} input
 * @returns {Promise<{ written: string[] }>}
 */
export async function encodeArtifacts(input: {
    root: string;
    text: string;
    artifacts: EncodeArtifact[];
    workspace: string;
    directoryTree: string;
    writeFile: (file: string, content: string) => Promise<void>;
}): Promise<{ written: string[] }> {
    const accepted: Array<{ path: string; body: string }> = [];
    for (const artifact of input.artifacts) {
        const hint = artifact.hintPath;
        if (typeof hint !== 'string' || !hint.trim()) throw new Error('Нет пути-подсказки для артефакта.');
        const { rel } = await resolveInside(input.root, hint, { forWrite: true, allowRoot: false });
        if (!rel || rel === '.backup' || rel.startsWith('.backup/')) throw new Error(`Путь вне записи: ${hint}`);
        accepted.push({ path: rel, body: artifact.body });
    }
    const written: string[] = [];
    for (const item of accepted) {
        await input.writeFile(item.path, item.body);
        written.push(item.path);
    }
    return { written };
}
