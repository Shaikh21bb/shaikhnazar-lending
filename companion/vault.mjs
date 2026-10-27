import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const IGNORED = new Set(['.obsidian', '.git', '.trash', '.DS_Store', 'node_modules']);
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru');
const tokens = value => new Set(normalize(value).match(/[\p{L}\p{N}]{3,}/gu) || []);

// These are navigation words, not evidence that two private notes discuss the same subject.
const SEARCH_STOP_WORDS = new Set(('а и в во на по с со из к ко у о об от до для при про за же бы ли или но не ни это этого этой этот эти том тут там тот как что какие какой какая каких когда где кто почему зачем сколько мне меня мной мой моя мои моего моих мое моё тебе ты я мы вы он она они его ее её их себя есть был была было были быть будет будут уже ещё еще только тоже пожалуйста да нет ну вот все всё весь всех свои свой свою свои наши наш это так such the a an and or in on at for from to of is are was were be been my me i you your our this that these those it its tell about what which who how when where why please did do does have has had with without more мен менің маған сен және туралы не қандай қай қалай қашан осы сол бар ғой еді керек база базу базы базой базе заметка заметки заметку заметках заметок мысль мысли мыслей мыслях obsidian покажи расскажи найди помнишь вспомни напомни подробнее подробней объясни продолжи писал писала сохранял сохранил записывал думал говорил помню wrote saved remember recent latest последние недавние').split(/\s+/u));

function searchStem(word) {
    const value = normalize(word).replace(/ё/g, 'е');
    if (!/^[а-я]+$/u.test(value) || value.length < 4) return value;
    const stem = value.replace(/(?:иями|ями|ами|иях|ах|ого|его|ому|ему|ыми|ими|ий|ый|ой|ая|яя|ое|ее|ые|ие|ую|юю|ов|ев|ам|ям|ом|ем|ях|ы|и|а|я|у|ю|е|о|ь)$/u, '');
    return stem.length >= 3 ? stem : value;
}

function searchWords(value) {
    return (normalize(value).replace(/ё/g, 'е').match(/[\p{L}\p{N}]{2,}/gu) || [])
        .filter(word => !SEARCH_STOP_WORDS.has(word)).map(searchStem).filter(word => word.length >= 2);
}

function searchNote(note) {
    const frontmatter = note.body.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/u);
    const body = frontmatter ? note.body.slice(frontmatter[0].length) : note.body;
    const heading = body.match(/^#\s+(.+)$/mu)?.[1]?.trim();
    const aliases = frontmatter?.[1].match(/^(?:aliases|alias):[ \t]*(.*(?:\n[ \t]*-[^\n]*)*)/mu)?.[1] || '';
    const created = frontmatter?.[1].match(/^created:\s*["']?([^\n"']+)/mu)?.[1];
    return { ...note, body, title: heading || note.title, aliases, created: Number.isFinite(Date.parse(created || '')) ? Date.parse(created) : 0 };
}

function passage(body, wanted, max = 2600) {
    if (body.length <= max || !wanted.size) return body.slice(0, max);
    const hits = [];
    for (const match of normalize(body).matchAll(/[\p{L}\p{N}]{2,}/gu)) {
        const term = searchStem(match[0]);
        if (wanted.has(term)) hits.push({ position: match.index, term });
    }
    if (!hits.length) return body.slice(0, max);
    const candidates = hits.map(hit => {
        const start = Math.max(0, hit.position - 350);
        const end = Math.min(body.length, start + Math.min(1800, max));
        const covered = new Set(hits.filter(other => other.position >= start && other.position < end).map(other => other.term));
        return { start, end, score: covered.size * 10 + hits.filter(other => other.position >= start && other.position < end).length / 100 };
    }).sort((a, b) => b.score - a.score || a.start - b.start);
    const selected = [candidates[0]];
    const second = candidates.find(candidate => candidate.end <= selected[0].start || candidate.start >= selected[0].end);
    if (second && max - (selected[0].end - selected[0].start) > 300) {
        selected.push({ ...second, end: Math.min(second.end, second.start + max - (selected[0].end - selected[0].start) - 5) });
    }
    return selected.sort((a, b) => a.start - b.start).map(({ start, end }) => `${start ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`).join('\n\n').slice(0, max);
}

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

    async search(text, { limit = 6, history = [], sourcePaths = [] } = {}) {
        const query = String(text || '').trim().slice(0, 20000);
        const wanted = new Set(searchWords(query));
        const followup = /^(?:а|и|ещ[её]|подробнее|продолжи|почему|and|more)(?![\p{L}\p{N}])|(?:^|\s)(?:это|этого|этой|этом|него|не[её]|них|они|там|того|об этом|о н[её]м|that|those|it)(?=\s|[?.!,]|$)/iu.test(query);
        const previous = new Set();
        if (followup) {
            const recent = (Array.isArray(history) ? history : []).filter(item => item?.role === 'user' && typeof item.content === 'string').slice(-2);
            for (const item of recent) for (const word of searchWords(item.content.slice(0, 4000))) previous.add(word);
        }
        const recentSources = new Set(followup && Array.isArray(sourcePaths) ? sourcePaths.slice(-12) : []);
        const recall = /(?:что|о ч[её]м).*(?:писал|сохранял|записывал|думал|помни|говорил)|мои\s+(?:мысли|заметки)|(?:последние|недавние)\s+(?:мысли|заметки)|what.*(?:remember|saved|wrote)|my\s+(?:thoughts|notes)/iu.test(query);
        const matches = [];
        for (const original of await this.notes()) {
            const note = searchNote(original);
            const titleWords = new Set(searchWords(`${note.title} ${note.path}`));
            const aliasWords = new Set(searchWords(note.aliases));
            const bodyWords = new Set(searchWords(note.body));
            let score = 0;
            for (const word of wanted) score += (titleWords.has(word) ? 10 : 0) + (aliasWords.has(word) ? 8 : 0) + (bodyWords.has(word) ? 2 : 0);
            let contextScore = 0;
            for (const word of previous) contextScore += (titleWords.has(word) ? 4 : 0) + (aliasWords.has(word) ? 3 : 0) + (bodyWords.has(word) ? 0.5 : 0);
            if (followup) score += Math.min(contextScore, 20) + (recentSources.has(note.path) ? 15 : 0);
            if (score || (recall && !wanted.size)) matches.push({ ...note, score });
        }
        matches.sort((a, b) => b.score - a.score || b.created - a.created || a.path.localeCompare(b.path));
        const count = Math.max(1, Math.min(8, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 6));
        const terms = new Set([...wanted, ...previous]);
        let remaining = 12000;
        return matches.slice(0, count).map(note => {
            const excerpt = passage(note.body, terms, Math.min(2600, remaining));
            remaining -= excerpt.length;
            return { path: note.path, title: note.title.slice(0, 150), excerpt };
        }).filter(note => note.excerpt.length);
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
