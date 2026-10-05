// Cloudflare Worker: runs one check on every cron tick (see wrangler.jsonc), keeps state in KV.

import { TELEGRAM_CALLS_PER_RUN, runCheck, telegramSender } from './check.mjs';
import { parseChatIds } from './lib.mjs';

export default {
    async scheduled(controller, env) {
        const saved = await env.STATE.get('state');
        const state = saved ? JSON.parse(saved) : {};
        const chatIds = parseChatIds(env.TELEGRAM_CHAT_ID);

        const delivered = await runCheck({
            state,
            send: telegramSender({ token: env.TELEGRAM_BOT_TOKEN, chatIds }),
            maxMessages: Math.floor(TELEGRAM_CALLS_PER_RUN / Math.max(chatIds.length, 1)),
        });

        // free KV allows 1000 writes a day, so write only when something changed
        const next = JSON.stringify(state);
        if (next !== saved) await env.STATE.put('state', next);

        // shows the run as failed in the dashboard; unsent posts are retried on the next tick
        if (!delivered) throw new Error('some messages were not sent');
    },
};
