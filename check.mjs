// One check: fetch every source, send new posts to Telegram, update the state object in place.
// Shared by worker.mjs (Cloudflare cron, state in KV) and monitor.mjs (local runs, state in a file).

import {
    addSeen,
    deliver,
    describeError,
    formatAlert,
    formatPost,
    formatRecovery,
    isPermanentTelegramError,
    planSource,
    rockstarItems,
    rssItems,
    trackFailure,
    trackSuccess,
} from './lib.mjs';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) gta-news-monitor';

// a free worker may make 50 subrequests per run: 4 go to the sources, telegram gets the rest with a margin
export const TELEGRAM_CALLS_PER_RUN = 40;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    return rssItems(await res.text());
}

async function loadRockstar() {
    const res = await request('https://graph.rockstargames.com/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: ROCKSTAR_QUERY, variables: { locale: 'en_us', page: 1, limit: 20 } }),
    });
    return rockstarItems(await res.json());
}

// returns send(text), which resolves once every reachable chat got the message
export function telegramSender({ token, chatIds }) {
    async function sendOne(chatId, text) {
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
            if (res.status !== 429) {
                throw Object.assign(new Error(`Telegram: ${body.description}`), { permanent: isPermanentTelegramError(res.status, body.description) });
            }
            await sleep((body.parameters?.retry_after ?? 5) * 1000);
        }
        throw new Error('Telegram: still rate limited after 3 attempts');
    }

    return async (text) => {
        if (!token || chatIds.length === 0) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
        const skipped = await deliver(text, chatIds, sendOne);
        for (const chatId of skipped) console.warn(`Telegram: chat ${chatId} cannot be reached (bot blocked?), skipped`);
    };
}

// state: { [sourceId]: { seen, failures, alerted } }, changed in place
// returns false when a message could not be sent; unsent posts stay unseen and go out next run
export async function runCheck({ state, send, maxMessages = Infinity }) {
    const results = await Promise.allSettled(SOURCES.map((source) => source.load()));
    const outbox = []; // { text, onSent? } — onSent updates state only after telegram accepted the message

    SOURCES.forEach((source, index) => {
        const entry = (state[source.id] ??= {});
        const result = results[index];

        if (result.status === 'rejected') {
            const message = describeError(result.reason);
            const { failures, alert } = trackFailure(entry);
            entry.failures = failures;
            console.warn(`${source.name}: ${message} (${failures} failed checks in a row)`);
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

    if (outbox.length > maxMessages) console.log(`${outbox.length - maxMessages} messages wait for the next run`);
    for (const { text, onSent } of outbox.slice(0, maxMessages)) {
        try {
            await send(text);
            onSent?.();
        } catch (error) {
            console.error(describeError(error));
            return false;
        }
    }
    return true;
}
