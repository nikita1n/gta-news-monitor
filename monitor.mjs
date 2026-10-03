// One check: fetch every source, send new posts to Telegram, save state.json.
// Run by .github/workflows/monitor.yml on a schedule; `--dry-run` prints messages and saves nothing.

import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseFeed } from '@rowanmanning/feed-parser';

import { addSeen, describeError, feedItems, formatAlert, formatPost, formatRecovery, planSource, rockstarItems, trackFailure, trackSuccess } from './lib.mjs';

const STATE_FILE = new URL('./state.json', import.meta.url);
const DRY_RUN = process.argv.includes('--dry-run');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) gta-news-monitor';

// the newswire page renders client-side; this is the same graphql query the RSSHub route uses
// (github.com/DIYgod/RSSHub, lib/routes/rockstargames/newswire.ts), trimmed to the list fields
const ROCKSTAR_QUERY = `query NewswireList($locale: String!, $page: Int!, $limit: Int) {
    posts(page: $page, locale: $locale, limit: $limit) { results { id: id_hash url title created } }
}`;

const SOURCES = [
    { id: 'rockstar', name: 'Rockstar Newswire', load: loadRockstar },
    { id: 'rockstarintel', name: 'Rockstar Intel', load: () => loadFeed('https://rockstarintel.com/feed') },
    // gtabase runs Joomla, which serves any category as RSS with ?format=feed
    { id: 'gtabase', name: 'GTABase', load: () => loadFeed('https://www.gtabase.com/news/?format=feed&type=rss') },
    { id: 'gtaboom', name: 'GTA BOOM', load: () => loadFeed('https://www.gtaboom.com/feed') },
];

async function request(url, init = {}) {
    const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': USER_AGENT, ...init.headers },
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res;
}

async function loadFeed(url) {
    const res = await request(url);
    return feedItems(parseFeed(await res.text()));
}

async function loadRockstar() {
    const res = await request('https://graph.rockstargames.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: ROCKSTAR_QUERY, variables: { locale: 'en_us', page: 1, limit: 20 } }),
    });
    return rockstarItems(await res.json());
}

async function sendTelegram(text) {
    if (DRY_RUN) {
        console.log(`--- would send:\n${text}\n`);
        return;
    }
    const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = process.env;
    if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');

    for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
            signal: AbortSignal.timeout(20_000),
        });
        const body = await res.json();
        if (body.ok) {
            await sleep(1100); // telegram allows about one message per second per chat
            return;
        }
        if (res.status !== 429) throw new Error(`Telegram: ${body.description}`);
        await sleep((body.parameters?.retry_after ?? 5) * 1000);
    }
    throw new Error('Telegram: still rate limited after 3 attempts');
}

async function readState() {
    try {
        return JSON.parse(await readFile(STATE_FILE, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

const state = await readState();
const results = await Promise.allSettled(SOURCES.map((source) => source.load()));
const outbox = []; // { text, onSent? } — onSent updates state only after telegram accepted the message

SOURCES.forEach((source, index) => {
    const entry = (state[source.id] ??= {});
    const result = results[index];

    if (result.status === 'rejected') {
        const message = describeError(result.reason);
        const { failures, alert } = trackFailure(entry);
        entry.failures = failures;
        console.log(`::warning::${source.name}: ${message} (${failures} failed checks in a row)`);
        if (alert) outbox.push({ text: formatAlert(source.name, message), onSent: () => (entry.alerted = true) });
        return;
    }

    const { failures, recovered } = trackSuccess(entry);
    entry.failures = failures;
    if (recovered) outbox.push({ text: formatRecovery(source.name), onSent: () => delete entry.alerted });

    const firstRun = !Array.isArray(entry.seen);
    const { toSend, seen } = planSource(entry, result.value);
    entry.seen = seen;
    console.log(`${source.name}: ${result.value.length} items, ${firstRun ? 'first run, all remembered' : `${toSend.length} new`}`);
    for (const item of toSend) {
        outbox.push({ text: formatPost(source.name, item), onSent: () => (entry.seen = addSeen(entry.seen, [item.id])) });
    }
});

for (const { text, onSent } of outbox) {
    try {
        await sendTelegram(text);
        onSent?.();
    } catch (error) {
        // stop here: unsent posts stay unseen and go out on the next run
        console.log(`::error::${describeError(error)}`);
        process.exitCode = 1;
        break;
    }
}

if (!DRY_RUN) await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
