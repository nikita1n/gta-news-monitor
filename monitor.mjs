// Local run for debugging; the real bot runs on Cloudflare (worker.mjs).
// State lives in state.json next to this file. `--dry-run` prints messages instead of sending and saves nothing.

import { readFile, writeFile } from 'node:fs/promises';

import { runCheck, telegramSender } from './check.mjs';
import { parseChatIds } from './lib.mjs';

const STATE_FILE = new URL('./state.json', import.meta.url);
const DRY_RUN = process.argv.includes('--dry-run');

async function readState() {
    try {
        return JSON.parse(await readFile(STATE_FILE, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

const state = await readState();
const send = DRY_RUN
    ? async (text) => console.log(`--- would send:\n${text}\n`)
    : telegramSender({ token: process.env.TELEGRAM_BOT_TOKEN, chatIds: parseChatIds(process.env.TELEGRAM_CHAT_ID) });

if (!(await runCheck({ state, send }))) process.exitCode = 1;
if (!DRY_RUN) await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
