import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    FAIL_ALERT_AFTER,
    SEEN_LIMIT,
    addSeen,
    describeError,
    deliver,
    isPermanentTelegramError,
    parseChatIds,
    formatAlert,
    formatPost,
    parseRockstarDate,
    planSource,
    rockstarItems,
    trackFailure,
    trackSuccess,
} from '../lib.mjs';

const item = (id, date = null) => ({ id, title: `t${id}`, link: `https://x/${id}`, date });

test('first run seeds every item as seen and sends nothing', () => {
    const plan = planSource(undefined, [item('b'), item('a')]);
    assert.deepEqual(plan.toSend, []);
    assert.deepEqual(plan.seen, ['b', 'a']);
});

test('a source that only ever failed is still treated as a first run', () => {
    const plan = planSource({ failures: 2 }, [item('a')]);
    assert.deepEqual(plan.toSend, []);
    assert.deepEqual(plan.seen, ['a']);
});

test('later runs send only unseen items', () => {
    const plan = planSource({ seen: ['a'] }, [item('b'), item('a')]);
    assert.deepEqual(plan.toSend.map((i) => i.id), ['b']);
    assert.deepEqual(plan.seen, ['a']);
});

test('an id listed twice in one feed is sent once', () => {
    // gtabase's feed points an old article at another article's url, so two entries share one guid
    const items = [item('dup', new Date('2026-09-21')), item('x', new Date('2026-09-10')), item('dup', new Date('2026-09-06'))];
    const plan = planSource({ seen: [] }, items);
    assert.deepEqual(plan.toSend.map((i) => i.id), ['x', 'dup']);
});

test('unseen items go out oldest first when every item has a date', () => {
    // rockstar keeps pinned posts on top, so feed order is not date order
    const items = [item('pinned', new Date('2026-09-01')), item('new', new Date('2026-10-02')), item('mid', new Date('2026-09-20'))];
    const plan = planSource({ seen: [] }, items);
    assert.deepEqual(plan.toSend.map((i) => i.id), ['pinned', 'mid', 'new']);
});

test('unseen items fall back to reversed feed order when a date is missing', () => {
    const items = [item('c', new Date('2026-10-02')), item('b'), item('a', new Date('2026-09-01'))];
    const plan = planSource({ seen: [] }, items);
    assert.deepEqual(plan.toSend.map((i) => i.id), ['a', 'b', 'c']);
});

test('addSeen puts new ids first, drops duplicates and caps the list', () => {
    assert.deepEqual(addSeen(['a', 'b'], ['c', 'a']), ['c', 'a', 'b']);
    const long = Array.from({ length: SEEN_LIMIT }, (_, i) => `old${i}`);
    const result = addSeen(long, ['new']);
    assert.equal(result.length, SEEN_LIMIT);
    assert.equal(result[0], 'new');
    assert.equal(result.at(-1), `old${SEEN_LIMIT - 2}`);
});

test('a failing source asks for an alert from the threshold on', () => {
    assert.deepEqual(trackFailure({}), { failures: 1, alert: false });
    assert.deepEqual(trackFailure({ failures: FAIL_ALERT_AFTER - 2 }), { failures: FAIL_ALERT_AFTER - 1, alert: false });
    assert.deepEqual(trackFailure({ failures: FAIL_ALERT_AFTER - 1 }), { failures: FAIL_ALERT_AFTER, alert: true });
});

test('the alert is asked for again until one is delivered, then never', () => {
    // the previous alert failed to send, so `alerted` was never set
    assert.equal(trackFailure({ failures: FAIL_ALERT_AFTER + 4 }).alert, true);
    assert.equal(trackFailure({ failures: FAIL_ALERT_AFTER + 4, alerted: true }).alert, false);
});

test('recovery is reported only when an alert was delivered', () => {
    assert.deepEqual(trackSuccess({ failures: FAIL_ALERT_AFTER - 1 }), { failures: 0, recovered: false });
    assert.deepEqual(trackSuccess({ failures: FAIL_ALERT_AFTER + 1, alerted: true }), { failures: 0, recovered: true });
    assert.deepEqual(trackSuccess(undefined), { failures: 0, recovered: false });
});

test('formatPost escapes html in the title and the link', () => {
    const text = formatPost('GTABase', { title: 'Cars <new> & bikes', link: 'https://x/?a=1&b=2' });
    assert.equal(text, '<b>Cars &lt;new&gt; &amp; bikes</b>\nGTABase · https://x/?a=1&amp;b=2');
});

test('describeError adds the low-level cause that fetch hides behind "fetch failed"', () => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) });
    assert.equal(describeError(error), 'fetch failed: getaddrinfo ENOTFOUND x');
    assert.equal(describeError(new Error('HTTP 403 https://x')), 'HTTP 403 https://x');
    assert.equal(describeError('plain string'), 'plain string');
});

test('formatAlert names the source and escapes the error text', () => {
    const text = formatAlert('GTA BOOM', 'HTTP 403 <cloudflare>');
    assert.match(text, /<b>GTA BOOM<\/b>/);
    assert.match(text, /<code>HTTP 403 &lt;cloudflare&gt;<\/code>/);
});

test('parseRockstarDate reads the newswire timestamp, including 12 AM and 12 PM', () => {
    assert.equal(parseRockstarDate('9/24/26, 11:00 AM').toISOString(), '2026-09-24T11:00:00.000Z');
    assert.equal(parseRockstarDate('10/1/26, 12:05 PM').toISOString(), '2026-10-01T12:05:00.000Z');
    assert.equal(parseRockstarDate('10/1/26, 12:05 AM').toISOString(), '2026-10-01T00:05:00.000Z');
    assert.equal(parseRockstarDate('10/1/26, 3:30 PM').toISOString(), '2026-10-01T15:30:00.000Z');
    assert.equal(parseRockstarDate('yesterday'), null);
});

test('rockstarItems maps graphql posts to items with absolute links', () => {
    const json = {
        data: { posts: { results: [{ id: '9k2a', url: '/newswire/article/9k2a/slug', title: 'Pre-Order', created: '9/24/26, 11:00 AM' }] } },
        errors: null,
    };
    assert.deepEqual(rockstarItems(json), [
        { id: '9k2a', title: 'Pre-Order', link: 'https://www.rockstargames.com/newswire/article/9k2a/slug', date: new Date('2026-09-24T11:00:00Z') },
    ]);
});

test('rockstarItems throws the graphql error message when data is null', () => {
    assert.throws(() => rockstarItems({ data: null, errors: [{ message: 'Unknown field' }] }), /Unknown field/);
    assert.throws(() => rockstarItems({}), /empty GraphQL response/);
});

test('parseChatIds splits a comma list, trims and drops blanks and repeats', () => {
    assert.deepEqual(parseChatIds(' 8150577206, 42 ,,42,'), ['8150577206', '42']);
    assert.deepEqual(parseChatIds(undefined), []);
});

test('telegram errors for a blocked bot or a missing chat are permanent, others are not', () => {
    assert.equal(isPermanentTelegramError(403, 'Forbidden: bot was blocked by the user'), true);
    assert.equal(isPermanentTelegramError(400, 'Bad Request: chat not found'), true);
    assert.equal(isPermanentTelegramError(400, "Bad Request: can't parse entities"), false);
    assert.equal(isPermanentTelegramError(502, 'Bad Gateway'), false);
});

test('deliver sends to every chat and skips one that blocked the bot', async () => {
    const sent = [];
    const skipped = await deliver('hi', ['a', 'b', 'c'], async (chat) => {
        if (chat === 'b') throw Object.assign(new Error('blocked'), { permanent: true });
        sent.push(chat);
    });
    assert.deepEqual(sent, ['a', 'c']);
    assert.deepEqual(skipped, ['b']);
});

test('deliver stops on a temporary error so the post is retried next run', async () => {
    await assert.rejects(
        deliver('hi', ['a', 'b'], async (chat) => {
            if (chat === 'a') throw new Error('Bad Gateway');
        }),
        /Bad Gateway/,
    );
});
