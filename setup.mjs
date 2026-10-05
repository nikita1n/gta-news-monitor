// One-time setup: asks for the bot token, finds every account that wrote to the bot,
// saves both as Cloudflare Worker secrets and sends a test message. Run it yourself: node setup.mjs

import { execFileSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('.', import.meta.url));
const WRANGLER = fileURLToPath(new URL('./node_modules/wrangler/bin/wrangler.js', import.meta.url));
const rl = createInterface({ input, output });

process.on('uncaughtException', (error) => {
    console.error(`\nОшибка: ${error.message}\n`);
    process.exit(1);
});

async function telegram(token, method, params = {}) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`Telegram ${method}: ${body.description}`);
    return body.result;
}

function putSecret(name, value) {
    // node + wrangler.js directly: spawning npx.cmd on Windows needs a shell
    execFileSync(process.execPath, [WRANGLER, 'secret', 'put', name], { cwd: PROJECT, input: value, stdio: ['pipe', 'inherit', 'inherit'] });
}

const token = (await rl.question('\n1) Вставь токен от BotFather и нажми Enter:\n> ')).trim();
const bot = await telegram(token, 'getMe').catch(() => {
    throw new Error('Telegram не принял токен. Скопируй его из BotFather целиком и запусти setup ещё раз.');
});
console.log(`   Токен рабочий, бот @${bot.username}`);

await rl.question(
    `\n2) С КАЖДОГО аккаунта, который должен получать новости, открой https://t.me/${bot.username}\n` +
        '   и напиши боту что угодно (или нажми «Start»). Потом вернись сюда и нажми Enter.',
);

const chats = new Map();
for (const update of await telegram(token, 'getUpdates')) {
    const chat = update.message?.chat;
    if (chat?.type === 'private') chats.set(chat.id, chat.first_name ?? chat.username ?? '');
}
if (chats.size === 0) throw new Error('Бот не получил ни одного сообщения. Напиши ему что-нибудь и запусти setup ещё раз.');
console.log(`   Нашёл аккаунты: ${[...chats].map(([id, name]) => `${name} (${id})`).join(', ')}`);

console.log('\n3) Сохраняю настройки в Cloudflare...');
putSecret('TELEGRAM_BOT_TOKEN', token);
putSecret('TELEGRAM_CHAT_ID', [...chats.keys()].join(','));

for (const chatId of chats.keys()) {
    await telegram(token, 'sendMessage', { chat_id: chatId, text: '✅ Бот подключён. Новые статьи про GTA будут приходить сюда.' });
}
console.log('\nГотово: на каждый найденный аккаунт должно прийти тестовое сообщение.\n');
rl.close();
