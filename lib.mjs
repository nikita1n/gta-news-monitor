// Pure logic: deciding what is new, failure bookkeeping, message text, response parsing.
// No network and no file access here, so all of it is covered by test/lib.test.mjs.

export const FAIL_ALERT_AFTER = 3; // consecutive failed runs before a Telegram warning (~45 min at a 15 min schedule)
export const SEEN_LIMIT = 200; // remembered ids per source; feeds carry at most 30 items

const ROCKSTAR = 'https://www.rockstargames.com';

// item: { id, title, link, date: Date | null }
// entry: the source's saved state, { seen?: string[], failures?: number, alerted?: boolean }
export function planSource(entry, items) {
    if (!Array.isArray(entry?.seen)) {
        // first successful fetch: remember what is there now instead of flooding the chat with old posts
        return { toSend: [], seen: addSeen([], items.map((i) => i.id)) };
    }
    const known = new Set(entry.seen);
    const unseen = [];
    for (const item of items) {
        if (known.has(item.id)) continue;
        known.add(item.id); // gtabase's feed lists one guid twice; send it once
        unseen.push(item);
    }
    return { toSend: oldestFirst(unseen), seen: entry.seen };
}

// feeds list newest first, except rockstar, which keeps pinned posts on top, so sort by date when we can
function oldestFirst(items) {
    if (items.every((i) => i.date instanceof Date && !Number.isNaN(i.date.getTime()))) {
        return items.toSorted((a, b) => a.date - b.date);
    }
    return items.toReversed();
}

export function addSeen(seen, ids) {
    return [...new Set([...ids, ...seen])].slice(0, SEEN_LIMIT);
}

// `alerted` is set only once the warning actually reached Telegram, so a lost warning is retried next run
export function trackFailure(entry) {
    const failures = (entry?.failures ?? 0) + 1;
    return { failures, alert: failures >= FAIL_ALERT_AFTER && !entry?.alerted };
}

export function trackSuccess(entry) {
    return { failures: 0, recovered: Boolean(entry?.alerted) };
}

// node's fetch reports every network problem as "fetch failed" and keeps the reason in `cause`
export function describeError(error) {
    if (!(error instanceof Error)) return String(error);
    return error.cause?.message ? `${error.message}: ${error.cause.message}` : error.message;
}

const escapeHtml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function formatPost(sourceName, item) {
    return `<b>${escapeHtml(item.title)}</b>\n${escapeHtml(sourceName)} · ${escapeHtml(item.link)}`;
}

export function formatAlert(sourceName, error) {
    return `⚠️ <b>${escapeHtml(sourceName)}</b> не отвечает уже ${FAIL_ALERT_AFTER} проверки подряд.\n<code>${escapeHtml(error)}</code>`;
}

export function formatRecovery(sourceName) {
    return `✅ <b>${escapeHtml(sourceName)}</b> снова работает.`;
}

// newswire timestamps look like "9/24/26, 11:00 AM" (New York local time, no zone given).
// They are only used to order posts of the same source, so the zone is left as UTC.
export function parseRockstarDate(text) {
    const m = (text ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}), (\d{1,2}):(\d{2}) (AM|PM)$/);
    if (!m) return null;
    const [, month, day, year, hour, minute, half] = m;
    const h = (Number(hour) % 12) + (half === 'PM' ? 12 : 0);
    return new Date(Date.UTC(2000 + Number(year), Number(month) - 1, Number(day), h, Number(minute)));
}

// graphql reports failures with http 200 and a null `data`, so errors have to be checked explicitly
export function rockstarItems(json) {
    const posts = json?.data?.posts?.results;
    if (!Array.isArray(posts)) {
        throw new Error(json?.errors?.map((e) => e.message).join('; ') || 'empty GraphQL response');
    }
    return posts.map((p) => ({ id: p.id, title: p.title, link: `${ROCKSTAR}${p.url}`, date: parseRockstarDate(p.created) }));
}

// A full XML parser costs ~14 ms of CPU on a cold start for these three feeds, over the 10 ms
// a free Cloudflare Worker gets. Only four short fields per item are needed, so pull them out
// with regexes and skip the article bodies entirely.
const ITEM = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
const BODIES = /<(description|content:encoded)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g; // may contain <link>, <title>
const FIELD = Object.fromEntries(['title', 'link', 'guid', 'pubDate'].map((name) => [name, new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)]));
const CDATA = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

function decodeEntities(text) {
    return text.replace(ENTITY, (match, name) => {
        if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? match;
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return String.fromCodePoint(code);
    });
}

function field(block, name) {
    const raw = block.match(FIELD[name])?.[1];
    if (raw === undefined) return '';
    return decodeEntities(raw.match(CDATA)?.[1] ?? raw).trim();
}

export function rssItems(xml) {
    const items = [];
    for (const [, block] of xml.matchAll(ITEM)) {
        const head = block.replace(BODIES, '');
        const link = field(head, 'link');
        if (!link) continue;
        const date = new Date(field(head, 'pubDate'));
        items.push({
            id: field(head, 'guid') || link,
            title: field(head, 'title') || link,
            link,
            date: Number.isNaN(date.getTime()) ? null : date,
        });
    }
    return items;
}

// TELEGRAM_CHAT_ID may hold several ids: "8150577206,123456789"
export function parseChatIds(value) {
    return [...new Set(String(value ?? '').split(',').map((id) => id.trim()).filter(Boolean))];
}

// the user blocked the bot or the chat is gone: retrying will never help, so skip that chat
export function isPermanentTelegramError(status, description) {
    return status === 403 || (status === 400 && /chat not found/i.test(description));
}

// sendOne(chatId, text) throws an error with `permanent: true` for a chat that can never be reached
export async function deliver(text, chatIds, sendOne) {
    const skipped = [];
    for (const chatId of chatIds) {
        try {
            await sendOne(chatId, text);
        } catch (error) {
            if (!error.permanent) throw error;
            skipped.push(chatId);
        }
    }
    return skipped;
}
