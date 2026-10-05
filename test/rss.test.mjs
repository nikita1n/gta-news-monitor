import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rssItems } from '../lib.mjs';

// shaped like the real feeds: wordpress (guid ?p=, content:encoded), joomla (&amp; in titles), cdata titles
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
    <title>Site</title>
    <link>https://site.test/</link>
    <atom:link href="https://site.test/feed" rel="self" type="application/rss+xml" />
    <item>
        <title>Sam Houser&#8217;s Interview &amp; More</title>
        <link>https://site.test/interview/</link>
        <pubDate>Fri, 03 Oct 2026 12:27:22 +0000</pubDate>
        <guid isPermaLink="false">https://site.test/?p=43576</guid>
        <description><![CDATA[<p>Teaser with a <link>https://wrong.test/</link> inside</p>]]></description>
        <content:encoded><![CDATA[<title>not this</title><a href="https://wrong.test/">x</a>]]></content:encoded>
    </item>
    <item>
        <title><![CDATA[Vice City <Night> & Heat]]></title>
        <link>
            https://site.test/heat
        </link>
        <pubDate>Thu, 02 Oct 2026 17:48:10 GMT</pubDate>
    </item>
    <item>
        <title>No link here</title>
        <guid>https://site.test/?p=1</guid>
    </item>
    <item>
        <title>Bad date &#x2014; still kept</title>
        <link>https://site.test/bad-date?a=1&amp;b=2</link>
        <pubDate>sometime</pubDate>
    </item>
</channel>
</rss>`;

test('rssItems reads title, link, guid and date of every item with a link', () => {
    assert.deepEqual(rssItems(FEED), [
        { id: 'https://site.test/?p=43576', title: 'Sam Houser’s Interview & More', link: 'https://site.test/interview/', date: new Date('2026-10-03T12:27:22Z') },
        { id: 'https://site.test/heat', title: 'Vice City <Night> & Heat', link: 'https://site.test/heat', date: new Date('2026-10-02T17:48:10Z') },
        { id: 'https://site.test/bad-date?a=1&b=2', title: 'Bad date — still kept', link: 'https://site.test/bad-date?a=1&b=2', date: null },
    ]);
});

test('rssItems returns nothing for a page that is not a feed', () => {
    assert.deepEqual(rssItems('<html><body>Just a moment...</body></html>'), []);
});
