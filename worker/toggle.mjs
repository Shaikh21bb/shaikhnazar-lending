import { writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const path = resolve(process.env.WHATSAPP_SESSION_DIR || '.wa-session', 'sales-agent.enabled');
if (process.argv[2] === 'on') {
    await writeFile(path, 'enabled\n', { mode: 0o600 });
    console.log('Local Sales Agent switch: ON');
} else if (process.argv[2] === 'off') {
    try {
        await unlink(path);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    console.log('Local Sales Agent switch: OFF');
} else {
    throw new Error('Expected on or off');
}
