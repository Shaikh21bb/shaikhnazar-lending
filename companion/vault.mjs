import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const IGNORED = new Set(['.obsidian', '.git', '.trash', '.DS_Store', 'node_modules']);
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru');
const tokens = value => new Set(normalize(value).match(/[\p{L}\p{N}]{3,}/gu) || []);

export async function discoverVaults(configPath = path.join(os.homedir(), 'Library/Application Support/obsidian/obsidian.json')) {
    let config;
    try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Не удалось прочитать список баз Obsidian.'); }
    const result = [];
    for (const entry of Object.values(config.vaults || {})) {
        if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) continue;
        try {
            const stat = await fs.stat(entry.path);
            if (stat.isDirectory()) result.push({ name: path.basename(entry.path), path: entry.path, open: Boolean(entry.open) });
        } catch { /* A previously registered vault may no longer exist. */ }
    }
    return result;
}

export function noteFilename(title) {
    const safe = String(title || 'Новая мысль').normalize('NFKC')
        .replace(/[\u0000-\u001f<>:"/\\|?*#^\[\]]/g, ' ')
        .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 100);
    return safe || 'Новая мысль';
}

function within(root, candidate) {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export class LocalVault {
    constructor(directory, { backupDirectory, fsImpl = fs } = {}) {
        this.directory = path.resolve(directory);
        this.backupDirectory = backupDirectory;
        this.fs = fsImpl;
    }

    async initialize() {
        this.root = await this.fs.realpath(this.directory);
        if (!(await this.fs.stat(this.root)).isDirectory()) throw new Error('Выбранная база Obsidian недоступна.');
        return this;
    }

    async safePath(relative, { createParents = false } = {}) {
        if (!this.root) await this.initialize();
        if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) {
            throw new Error('Недопустимый путь заметки.');
        }
        const segments = relative.split('/');
        if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
            throw new Error('Недопустимый путь заметки.');
        }
        const target = path.resolve(this.root, ...segments);
        if (!within(this.root, target) || !target.endsWith('.md')) throw new Error('Разрешены только Markdown-заметки внутри выбранной базы.');
        let current = this.root;
        for (let i = 0; i < segments.length; i++) {
            current = path.join(current, segments[i]);
            try {
                const stat = await this.fs.lstat(current);
                if (stat.isSymbolicLink()) throw new Error('Ссылки на файлы и папки за пределами базы не используются.');
                if (i < segments.length - 1 && !stat.isDirectory()) throw new Error('Папка заметки недоступна.');
                if (i === segments.length - 1 && !stat.isFile()) throw new Error('Заметка должна быть обычным файлом.');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                if (i < segments.length - 1) {
                    if (!createParents) throw new Error('Папка заметки не найдена.');
                    await this.fs.mkdir(current, { mode: 0o700 });
                }
            }
        }
        return target;
    }

    async notes() {
        if (!this.root) await this.initialize();
        const result = [];
        const walk = async (directory, prefix = '') => {
            for (const entry of await this.fs.readdir(directory, { withFileTypes: true })) {
                if (entry.name.startsWith('.') || IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
                const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
                else if (entry.isFile() && entry.name.endsWith('.md')) {
                    const safe = await this.safePath(relative);
                    const stat = await this.fs.stat(safe);
                    // Very large attachments with a .md suffix are excluded from a model prompt.
                    if (stat.size > 2 * 1024 * 1024) continue;
                    result.push({ path: relative, title: path.basename(relative, '.md'), body: await this.fs.readFile(safe, 'utf8') });
                }
            }
        };
        await walk(this.root);
        return result;
    }

    async related(text, { limit = 6, excludePath } = {}) {
        const wanted = tokens(text);
        if (!wanted.size) return [];
        const matches = [];
        for (const note of await this.notes()) {
            if (note.path === excludePath) continue;
            const titleWords = tokens(note.title);
            const bodyWords = tokens(note.body);
            let score = 0;
            for (const word of wanted) score += titleWords.has(word) ? 5 : bodyWords.has(word) ? 1 : 0;
            if (score) matches.push({ ...note, score });
        }
        return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit)
            .map(note => ({ path: note.path, title: note.title, excerpt: note.body.slice(0, 3500) }));
    }

    async write({ title, body, tags = [], links = [], source = 'website', jobId, updatePath, pending = false }) {
        const cleanTitle = noteFilename(title);
        const cleanTags = [...new Set(tags.map(tag => String(tag).replace(/[^\p{L}\p{N}_/-]/gu, '').slice(0, 60)).filter(Boolean))].slice(0, 15);
        const cleanLinks = [...new Set(links.filter(link => typeof link === 'string' && link.endsWith('.md') && !link.includes('..') && !link.includes('[') && !link.includes(']')))].slice(0, 12);
        const marker = createHash('sha256').update(String(jobId)).digest('hex').slice(0, 24);
        // The name cannot depend on a nondeterministic second model response after a crash.
        // Obsidian displays the formatted title as the Markdown heading.
        const relative = updatePath || `SHAIKH Inbox/${marker}.md`;
        const target = await this.safePath(relative, { createParents: !updatePath });
        const now = new Date().toISOString();
        let existing;
        try { existing = await this.fs.readFile(target, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!updatePath && existing) return { title: cleanTitle, path: relative, tags: cleanTags, links: cleanLinks, reused: true };
        if (updatePath && !existing) throw new Error('Исходная заметка для обновления не найдена.');
        const markdown = [
            '---', `shaikh_id: ${JSON.stringify(String(jobId))}`, `created: ${JSON.stringify(now)}`,
            `source: ${JSON.stringify(source)}`, `analysis: ${pending ? 'pending' : 'local'}`,
            `tags: ${JSON.stringify(cleanTags)}`, '---', '', `# ${cleanTitle}`, '', String(body || '').trim(),
            ...(cleanLinks.length ? ['', '## Связанные мысли', '', ...cleanLinks.map(link => `- [[${link.slice(0, -3)}]]`)] : []), '',
        ].join('\n');
        if (existing) await this.backup(relative, existing);
        const temporary = `${target}.${randomUUID()}.tmp`;
        await this.fs.writeFile(temporary, markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        // Recheck symlinks immediately before replacing the destination.
        await this.safePath(relative, { createParents: false });
        await this.fs.rename(temporary, target);
        return { title: cleanTitle, path: relative, tags: cleanTags, links: cleanLinks };
    }

    async backup(relative, body) {
        if (!this.backupDirectory) throw new Error('Для обновления заметок требуется локальная папка резервных копий.');
        await this.fs.mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
        const hash = createHash('sha256').update(relative).digest('hex').slice(0, 20);
        const file = path.join(this.backupDirectory, `${Date.now()}-${hash}-${randomUUID()}.md`);
        await this.fs.writeFile(file, body, { mode: 0o600, flag: 'wx' });
    }
}
