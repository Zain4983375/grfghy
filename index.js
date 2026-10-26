/**
 * 💎 Official JJH TipBot — Modern UI Edition
 * Same logic, fully restyled outputs: branded embeds, avatars & link buttons.
 */
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, SystemProgram, Transaction } = require('@solana/web3.js');
const sqlite3 = require('sqlite3');
const axios = require('axios');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════
// 🎨 JJH UI KIT — one design language for every output
// ═══════════════════════════════════════════════════════════
const BRAND = {
  primary: 0x8B5CF6, // JJH purple
  success: 0x00E5A0, // mint
  error:   0xFF4D6D, // coral red
  gold:    0xF5C518, // VIP gold
  info:    0x38BDF8, // sky
};
const SOLSCAN_TX = (sig) => `https://solscan.io/tx/${sig}`;
const FOOTER = '💎 Official JJH TipBot • Powered by Solana';

function baseEmbed(color = BRAND.primary) {
  return new EmbedBuilder().setColor(color).setTimestamp().setFooter({ text: FOOTER });
}
function okEmbed(title, description = '') {
  return baseEmbed(BRAND.success).setTitle(`✅ ${title}`).setDescription(description);
}
function errEmbed(description) {
  return baseEmbed(BRAND.error).setTitle('❌ Something went wrong').setDescription(description);
}
function infoEmbed(title, description = '') {
  return baseEmbed(BRAND.info).setTitle(title).setDescription(description);
}
function goldEmbed(title, description = '') {
  return baseEmbed(BRAND.gold).setTitle(title).setDescription(description);
}
/** Clickable "View on Solscan" button row */
function solscanRow(signature) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('🔍 View on Solscan')
      .setStyle(ButtonStyle.Link)
      .setURL(SOLSCAN_TX(signature))
  )];
}
/** Standard error reply (auto-deletes like before) */
async function replyError(message, text, delDelay = 10000) {
  const reply = await message.reply({ embeds: [errEmbed(text)] });
  autoDeleteErrorMessage(reply, delDelay);
  autoDeleteErrorMessage(message, delDelay);
  return reply;
}
const shortAddr = (a) => (a ? `\`${a.slice(0, 4)}…${a.slice(-4)}\`` : '`—`');
const fmtUSD = (n) => `$${Number(n).toFixed(2)}`;
const fmtSOL = (n, d = 4) => `${Number(n).toFixed(d)} SOL`;
const avatarOf = (user) => (user?.displayAvatarURL ? user.displayAvatarURL() : null);

// ═══════════════════════════════════════════════════════════
// 🗄️ DATABASE (unchanged)
// ═══════════════════════════════════════════════════════════
// DATA_DIR: Railway par volume mount point (e.g. /data). Local/Pterodactyl par default.
const DATA_DIR = process.env.DATA_DIR || '/home/container/data';
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new sqlite3.Database(`${DATA_DIR}/bot.db`);
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    username TEXT,
    wallet TEXT,
    balance_usd REAL DEFAULT 0,
    total_tipped REAL DEFAULT 0,
    total_received REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT,
    receiver_id TEXT,
    amount_usd REAL,
    amount_sol REAL,
    signature TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS permissions (
    discord_id TEXT PRIMARY KEY,
    can_tip INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pending_tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT,
    receiver_id TEXT,
    amount_usd REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('faucet_enabled', 'true')`);

  db.run(`ALTER TABLE transactions ADD COLUMN amount_sol REAL`, (err) => {
    if (err && err.message.includes('duplicate column name')) {} else if (err) {
      console.error('Error adding amount_sol:', err.message);
    }
  });
});

function dbGet(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbAll(sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function autoDeleteReply(interaction, delay = 15000) {
  setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, delay);
}

async function autoDeleteErrorMessage(message, delay = 10000) {
  setTimeout(() => {
    message.delete().catch(() => {});
  }, delay);
}

// ═══════════════════════════════════════════════════════════
// ⛓️ SOLANA (unchanged)
// ═══════════════════════════════════════════════════════════
const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  'confirmed'
);

let botKeypair = null;
if (process.env.BOT_WALLET_PRIVATE_KEY) {
  try {
    const privateKeyBytes = Buffer.from(process.env.BOT_WALLET_PRIVATE_KEY, 'base64');
    botKeypair = Keypair.fromSecretKey(privateKeyBytes);
    console.log(`Bot wallet loaded: ${botKeypair.publicKey.toString()}`);
  } catch (error) {
    console.error('Failed to load bot wallet:', error);
  }
}

let cachedPrice = null;
let priceCacheTime = 0;

async function getSolPrice() {
  const now = Date.now();
  if (cachedPrice && (now - priceCacheTime) < 30000) {
    return cachedPrice;
  }

  const sources = [
    { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', parse: (data) => data.solana?.usd },
    { name: 'Binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', parse: (data) => parseFloat(data.price) },
    { name: 'Coinbase', url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot', parse: (data) => parseFloat(data.data?.amount) },
    { name: 'Kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=SOLUSD', parse: (data) => { const pair = data.result?.SOLUSD; return pair ? parseFloat(pair.c[0]) : null; } }
  ];

  for (const source of sources) {
    try {
      const response = await axios.get(source.url, { timeout: 3000 });
      const price = source.parse(response.data);
      if (price && price > 0) {
        cachedPrice = price;
        priceCacheTime = now;
        console.log(`✅ SOL Price updated from ${source.name}: $${cachedPrice}`);
        return cachedPrice;
      }
    } catch (error) {
      console.log(`❌ Failed to fetch from ${source.name}:`, error.message);
    }
  }

  if (cachedPrice && (now - priceCacheTime) < 300000) {
    console.log(`⚠️ Using cached SOL price: $${cachedPrice}`);
    return cachedPrice;
  }

  const fallbackPrice = 130;
  console.log(`⚠️ Using fallback SOL price: $${fallbackPrice}`);
  return fallbackPrice;
}

async function getBalance(address) {
  try {
    const pubkey = new PublicKey(address);
    const balance = await connection.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch { return 0; }
}

async function sendSOL(toAddress, amountSOL) {
  if (!botKeypair) {
    return { success: false, error: 'Bot wallet not configured' };
  }

  try {
    const toPublicKey = new PublicKey(toAddress);
    if (toPublicKey.toString() === '11111111111111111111111111111111') {
      return { success: false, error: 'Invalid recipient address' };
    }

    const lamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);
    if (lamports < 5000) {
      return { success: false, error: 'Amount too small. Minimum: 0.000005 SOL' };
    }

    const balance = await connection.getBalance(botKeypair.publicKey);
    const feeBuffer = 10000;

    if (balance < lamports + feeBuffer) {
      const botAddress = botKeypair.publicKey.toString();
      return {
        success: false,
        error: `❌ Bot wallet has insufficient SOL!\nPlease ask <@637927094319579140> or <@235836165716967424> to refill the bot wallet.\nBot Address: ${botAddress}`
      };
    }

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: botKeypair.publicKey,
        toPubkey: toPublicKey,
        lamports: lamports,
      })
    );

    const { blockhash } = await connection.getRecentBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = botKeypair.publicKey;

    const signature = await connection.sendTransaction(transaction, [botKeypair]);
    await connection.confirmTransaction(signature);

    return { success: true, signature, amount: amountSOL };
  } catch (error) {
    console.error('SOL transfer failed:', error);
    const botAddress = botKeypair?.publicKey?.toString() || 'unknown';
    return {
      success: false,
      error: `❌ Bot wallet has insufficient SOL!\nPlease ask <@637927094319579140> or <@235836165716967424> to refill the bot wallet.\nBot Address: ${botAddress}`
    };
  }
}

const OWNER_ID = process.env.OWNER_ID;

function isOwner(userId) {
  return userId === OWNER_ID;
}

async function hasTipPermission(userId) {
  if (isOwner(userId)) return true;
  const result = await dbGet(`SELECT can_tip FROM permissions WHERE discord_id = ?`, [userId]);
  return result ? result.can_tip === 1 : false;
}

async function giveTipPermission(userId) {
  await dbRun(`INSERT OR REPLACE INTO permissions (discord_id, can_tip) VALUES (?, 1)`, [userId]);
}

async function removeTipPermission(userId) {
  await dbRun(`DELETE FROM permissions WHERE discord_id = ?`, [userId]);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

function getArgs(message) {
  const parts = message.content.trim().split(/ +/);
  return parts.slice(1);
}

async function checkOwner(message) {
  if (!isOwner(message.author.id)) {
    await replyError(message, 'Only the bot owner can use this command!', 8000);
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// 💬 COMMAND HANDLERS — modern outputs
// ═══════════════════════════════════════════════════════════

// 1. !wallet — view or set wallet
async function handleMessageWallet(message) {
  const args = getArgs(message);
  const userId = message.author.id;
  const username = message.author.username;

  if (args.length === 0) {
    try {
      const user = await dbGet(`SELECT wallet FROM users WHERE discord_id = ?`, [userId]);
      if (user?.wallet) {
        const embed = infoEmbed('🔗 Linked Wallet', `Your wallet on file:\n\`\`\`${user.wallet}\`\`\``)
          .setThumbnail(avatarOf(message.author));
        await message.reply({ embeds: [embed] });
      } else {
        await replyError(message, 'No wallet linked yet.\nUse `!wallet <address>` to link your Solana wallet.');
      }
    } catch (error) {
      await replyError(message, 'Database error. Try again in a moment.', 8000);
    }
    return;
  }

  const address = args[0];

  try {
    new PublicKey(address);
  } catch {
    await replyError(message, 'That doesn\'t look like a valid Solana wallet address.', 8000);
    return;
  }

  // shared: process queued tips after (re)linking
  async function processPendingTips() {
    const pendingTips = await dbAll(`SELECT * FROM pending_tips WHERE receiver_id = ? AND processed = 0`, [userId]);
    if (!pendingTips.length) return null;

    let totalProcessed = 0;
    const lines = [];
    let firstSig = null;

    for (const tip of pendingTips) {
      const solPrice = await getSolPrice();
      const solAmount = tip.amount_usd / solPrice;
      const result = await sendSOL(address, solAmount);

      if (!result.success) {
        await replyError(message, `Wallet saved, but a pending tip failed:\n${result.error}`, 12000);
        return { failed: true };
      }

      await dbRun(`INSERT INTO transactions (sender_id, receiver_id, amount_usd, amount_sol, signature) VALUES (?, ?, ?, ?, ?)`,
        [tip.sender_id, userId, tip.amount_usd, solAmount, result.signature]);
      await dbRun(`UPDATE users SET balance_usd = balance_usd + ? WHERE discord_id = ?`, [tip.amount_usd, userId]);
      await dbRun(`UPDATE pending_tips SET processed = 1 WHERE id = ?`, [tip.id]);

      totalProcessed += tip.amount_usd;
      if (!firstSig) firstSig = result.signature;
      const sender = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [tip.sender_id]);
      lines.push(`• ${fmtUSD(tip.amount_usd)} from **${sender?.username || 'Unknown'}**`);
    }
    return { count: pendingTips.length, total: totalProcessed, lines, sig: firstSig };
  }

  try {
    const existingUser = await dbGet(`SELECT wallet FROM users WHERE discord_id = ?`, [userId]);

    if (existingUser?.wallet) {
      await dbRun(`UPDATE users SET wallet = ?, username = ? WHERE discord_id = ?`, [address, username, userId]);
      const res = await processPendingTips();
      if (res?.failed) return;

      const embed = okEmbed('Wallet Updated', `Now pointing at:\n\`\`\`${address}\`\`\``)
        .setThumbnail(avatarOf(message.author));
      if (res) {
        embed.addFields(
          { name: '🎁 Pending tips claimed', value: `${res.count} tips • **${fmtUSD(res.total)}**`, inline: false },
          { name: 'Details', value: res.lines.join('\n').slice(0, 1000), inline: false }
        );
        await message.reply({ embeds: [embed], components: solscanRow(res.sig) });
      } else {
        await message.reply({ embeds: [embed] });
      }
      return;
    }

    await dbRun(`INSERT INTO users (discord_id, username, wallet) VALUES (?, ?, ?)`, [userId, username, address]);
    const res = await processPendingTips();
    if (res?.failed) return;

    const embed = okEmbed('Wallet Linked', `Welcome aboard, **${username}**!\n\`\`\`${address}\`\`\``)
      .setThumbnail(avatarOf(message.author));
    if (res) {
      embed.addFields(
        { name: '🎁 Pending tips claimed', value: `${res.count} tips • **${fmtUSD(res.total)}**`, inline: false },
        { name: 'Details', value: res.lines.join('\n').slice(0, 1000), inline: false }
      );
      await message.reply({ embeds: [embed], components: solscanRow(res.sig) });
    } else {
      await message.reply({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Wallet error:', err);
    await replyError(message, 'Database error. Try again in a moment.', 8000);
  }
}

// 2. !bal — wallet balance
async function handleMessageBalance(message) {
  const userId = message.author.id;

  try {
    const row = await dbGet(`SELECT wallet FROM users WHERE discord_id = ?`, [userId]);

    if (!row?.wallet) {
      await replyError(message, 'No wallet linked yet.\nUse `!wallet <address>` to link one first.');
      return;
    }

    const sol = await getBalance(row.wallet);
    const price = await getSolPrice();
    const usdValue = sol * price;

    const embed = baseEmbed(BRAND.primary)
      .setAuthor({ name: `${message.author.username}'s Wallet`, iconURL: avatarOf(message.author) })
      .setTitle('💰 Balance')
      .setDescription(`\`${row.wallet}\``)
      .addFields(
        { name: '◎ SOL', value: `**${sol.toFixed(4)}**`, inline: true },
        { name: '💵 USD Value', value: `**${fmtUSD(usdValue)}**`, inline: true },
        { name: '📈 SOL Price', value: `${fmtUSD(price)}`, inline: true }
      )
      .setThumbnail(avatarOf(message.author));

    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Balance error:', error);
    await replyError(message, 'Couldn\'t fetch your balance right now.', 8000);
  }
}

// 3. !faucet — claim free SOL
async function handleMessageFaucet(message) {
  const settings = await dbGet(`SELECT value FROM settings WHERE key = 'faucet_enabled'`);
  if (settings?.value !== 'true') {
    await replyError(message, 'The faucet is currently **OFF**. Check back later!');
    return;
  }

  const userId = message.author.id;
  const amountSOL = 0.001;

  try {
    const user = await dbGet(`SELECT wallet FROM users WHERE discord_id = ?`, [userId]);

    if (!user?.wallet) {
      await replyError(message, 'Link a wallet first with `!wallet <address>`, then come claim!');
      return;
    }

    if (!botKeypair) {
      await replyError(message, 'Bot wallet isn\'t configured. Contact an admin.', 8000);
      return;
    }

    const botBalance = await getBalance(botKeypair.publicKey.toString());
    if (botBalance < amountSOL) {
      await replyError(message, 'Faucet is dry — the bot wallet needs a refill. Ping an admin!');
      return;
    }

    const claimed = await dbGet(`SELECT * FROM transactions WHERE sender_id = 'faucet' AND receiver_id = ?`, [userId]);
    if (claimed) {
      await replyError(message, 'You\'ve already claimed your free SOL! One per user. 💧');
      return;
    }

    const result = await sendSOL(user.wallet, amountSOL);

    if (!result.success) {
      await replyError(message, `Faucet failed:\n${result.error}`, 12000);
      return;
    }

    await dbRun(`INSERT INTO transactions (sender_id, receiver_id, amount_usd, amount_sol, signature) VALUES (?, ?, ?, ?, ?)`,
      ['faucet', userId, 0, amountSOL, result.signature]);

    const embed = goldEmbed('🎁 Faucet Claimed!',
      `**${fmtSOL(amountSOL, 3)}** is on its way to your wallet, ${message.author.username}!`)
      .setThumbnail(avatarOf(message.author))
      .addFields({ name: 'To', value: shortAddr(user.wallet), inline: true });

    await message.reply({ embeds: [embed], components: solscanRow(result.signature) });
  } catch (error) {
    console.error('Faucet error:', error);
    await replyError(message, 'Faucet failed. Try again in a moment.', 8000);
  }
}

// 4. !history — last 10 transactions
async function handleMessageHistory(message) {
  const userId = message.author.id;

  try {
    const rows = await dbAll(`SELECT * FROM transactions WHERE sender_id = ? OR receiver_id = ? ORDER BY created_at DESC LIMIT 10`, [userId, userId]);

    if (!rows?.length) {
      await replyError(message, 'No transactions yet. Go get tipped! 💸');
      return;
    }

    const lines = [];
    for (const r of rows) {
      const isSender = r.sender_id === userId;
      const otherId = isSender ? r.receiver_id : r.sender_id;
      const other = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [otherId]);
      const icon = r.sender_id === 'faucet' ? '🎁' : (isSender ? '📤' : '📥');
      const dir = isSender ? 'to' : 'from';
      lines.push(`${icon} **${fmtUSD(r.amount_usd || 0)}** ${dir} **${other?.username || 'Unknown'}**`);
    }

    const embed = infoEmbed('📜 Transaction History', lines.join('\n'))
      .setThumbnail(avatarOf(message.author))
      .setFooter({ text: `${FOOTER} • Last ${rows.length}` });

    await message.reply({ embeds: [embed] });
  } catch (error) {
    await replyError(message, 'Couldn\'t fetch your history right now.', 8000);
  }
}

// 5. !help — command center
async function handleMessageHelp(message) {
  const userId = message.author.id;
  const canTip = await hasTipPermission(userId);
  const isOwnerUser = isOwner(userId);

  const embed = baseEmbed(BRAND.primary)
    .setTitle('🤖 JJH TipBot — Command Center')
    .setDescription('Tip SOL across the server in seconds.\nAll commands use the `!` prefix.')
    .setThumbnail(avatarOf(client.user))
    .addFields(
      {
        name: '💎 Wallet & Balance',
        value: '`!wallet <address>` — link your Solana wallet\n`!wallet` — view your linked wallet\n`!bal` — check SOL + USD balance\n`!botbal` — check the bot\'s wallet\n`!faucet` — claim free 0.001 SOL (once)',
        inline: false
      },
      {
        name: '📜 Activity',
        value: '`!history` — your last 10 transactions\n`!help` — this menu',
        inline: false
      }
    );

  if (canTip) {
    embed.addFields({
      name: '💸 Tipping',
      value: '`!tip @user <usd>` — tip in USD, auto-converted to SOL\n`!tip @user` — quick-tip $0.10',
      inline: false
    });
  }

  if (isOwnerUser) {
    embed.addFields({
      name: '🔧 Admin',
      value: '`!gp @user` / `!rp @user` — give / remove tip permission\n`!lp` — list tippers\n`!last` — last 10 bot transactions\n`!fon` / `!foff` — faucet on / off\n`!vp @user` / `!rpt @user` — view / clear pending tips',
      inline: false
    });
  }

  embed.addFields({
    name: '💡 Tip',
    value: 'New here? Start with `!wallet <your-address>` — one time, then you\'re set.',
    inline: false
  });

  await message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════
// 🔧 OWNER COMMANDS — modern outputs
// ═══════════════════════════════════════════════════════════

// 6. !gp — give tip permission
async function handleMessageGivePerms(message) {
  if (!await checkOwner(message)) return;

  const args = getArgs(message);

  if (args.length === 0) {
    await replyError(message, 'Usage: `!gp @user`', 8000);
    return;
  }

  const targetUser = message.mentions.users.first();
  if (!targetUser) {
    await replyError(message, 'Mention a user first.\nUsage: `!gp @user`', 8000);
    return;
  }

  if (isOwner(targetUser.id)) {
    await replyError(message, '👑 He\'s the owner — he already has every permission!', 8000);
    return;
  }

  if (await hasTipPermission(targetUser.id)) {
    await replyError(message, `**${targetUser.username}** can already tip!`, 8000);
    return;
  }

  try {
    await giveTipPermission(targetUser.id);
    const embed = okEmbed('Permission Granted', `**${targetUser.username}** can now send tips! 💸`)
      .setThumbnail(avatarOf(targetUser));
    await message.reply({ embeds: [embed] });
  } catch (error) {
    await replyError(message, `Couldn't save that: ${error.message}`, 8000);
  }
}

// 7. !rp — remove tip permission
async function handleMessageRemovePerms(message) {
  if (!await checkOwner(message)) return;

  const args = getArgs(message);

  if (args.length === 0) {
    await replyError(message, 'Usage: `!rp @user`', 8000);
    return;
  }

  const targetUser = message.mentions.users.first();
  if (!targetUser) {
    await replyError(message, 'Mention a user first.\nUsage: `!rp @user`', 8000);
    return;
  }

  if (isOwner(targetUser.id)) {
    await replyError(message, '👑 He\'s the owner — his permissions can\'t be removed!', 8000);
    return;
  }

  if (!await hasTipPermission(targetUser.id)) {
    await replyError(message, `**${targetUser.username}** doesn't have tip permission anyway.`, 8000);
    return;
  }

  try {
    await removeTipPermission(targetUser.id);
    const embed = okEmbed('Permission Removed', `**${targetUser.username}** can no longer send tips.`)
      .setThumbnail(avatarOf(targetUser));
    await message.reply({ embeds: [embed] });
  } catch (error) {
    await replyError(message, `Couldn't save that: ${error.message}`, 8000);
  }
}

// 8. !lp — list tippers
async function handleMessageListPerms(message) {
  if (!await checkOwner(message)) return;

  try {
    const permUsers = await dbAll(`SELECT * FROM permissions WHERE can_tip = 1`);

    if (permUsers.length === 0) {
      await replyError(message, 'Nobody has tip permission yet.\nUse `!gp @user` to add someone.');
      return;
    }

    const lines = [];
    for (let i = 0; i < permUsers.length; i++) {
      const user = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [permUsers[i].discord_id]);
      lines.push(`**${i + 1}.** <@${permUsers[i].discord_id}> — ${user?.username || 'Unknown'}`);
    }

    const embed = infoEmbed(`💸 Authorized Tippers (${permUsers.length})`, lines.join('\n').slice(0, 3900));
    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('List perms error:', error);
    await replyError(message, `Couldn't load the list: ${error.message}`, 8000);
  }
}

// 9. !last — last 10 bot transactions
async function handleMessageLast(message) {
  if (!await checkOwner(message)) return;

  try {
    const rows = await dbAll(`SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10`);

    if (!rows || rows.length === 0) {
      await replyError(message, 'No transactions in the database yet.');
      return;
    }

    const lines = [];
    for (const r of rows) {
      let senderName, receiverName;
      if (r.sender_id === 'faucet') senderName = '🚰 Faucet';
      else {
        const s = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [r.sender_id]);
        senderName = s?.username || 'Unknown';
      }
      if (r.receiver_id === 'faucet') receiverName = '🚰 Faucet';
      else {
        const rec = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [r.receiver_id]);
        receiverName = rec?.username || 'Unknown';
      }
      const icon = r.sender_id === 'faucet' ? '🎁' : '💸';
      const amt = r.amount_usd ? fmtUSD(r.amount_usd) : fmtSOL(r.amount_sol || 0, 6);
      lines.push(`${icon} **${amt}** — ${senderName} → ${receiverName}`);
    }

    const embed = baseEmbed(BRAND.gold)
      .setTitle('📊 Latest Bot Activity')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${FOOTER} • Last ${rows.length} transactions` });

    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Last transactions error:', error);
    await replyError(message, `Couldn't load transactions: ${error.message}`, 8000);
  }
}

// 10. !botbal — bot wallet balance (public)
async function handleMessageBotBalance(message) {
  if (!botKeypair) {
    await replyError(message, 'Bot wallet isn\'t configured.', 8000);
    return;
  }

  try {
    const balance = await getBalance(botKeypair.publicKey.toString());
    const price = await getSolPrice();
    const walletAddress = botKeypair.publicKey.toString();
    const usdValue = balance * price;
    const healthy = balance > 0.05;

    const embed = baseEmbed(healthy ? BRAND.primary : BRAND.error)
      .setAuthor({ name: 'JJH TipBot Vault', iconURL: avatarOf(client.user) })
      .setTitle(healthy ? '🏦 Bot Vault' : '⚠️ Bot Vault — Low!')
      .setDescription(`\`${walletAddress}\``)
      .addFields(
        { name: '◎ SOL', value: `**${balance.toFixed(4)}**`, inline: true },
        { name: '💵 USD Value', value: `**${fmtUSD(usdValue)}**`, inline: true },
        { name: '📈 SOL Price', value: `${fmtUSD(price)}`, inline: true }
      )
      .setThumbnail(avatarOf(client.user));

    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Bot balance error:', error);
    await replyError(message, 'Couldn\'t fetch the bot balance right now.', 8000);
  }
}

// 11/12. !fon / !foff — faucet toggle
async function handleMessageFaucetOn(message) {
  if (!await checkOwner(message)) return;
  await dbRun(`UPDATE settings SET value = 'true' WHERE key = 'faucet_enabled'`);
  await message.reply({ embeds: [okEmbed('Faucet ON', 'Users can claim free SOL again! 💧')] });
}

async function handleMessageFaucetOff(message) {
  if (!await checkOwner(message)) return;
  await dbRun(`UPDATE settings SET value = 'false' WHERE key = 'faucet_enabled'`);
  await message.reply({ embeds: [okEmbed('Faucet OFF', 'Claiming is paused for now.')] });
}

// 13. !vp — view pending tips
async function handleMessageViewPending(message) {
  if (!await checkOwner(message)) return;

  const targetUser = message.mentions.users.first();
  if (!targetUser) {
    await replyError(message, 'Mention a user first.\nUsage: `!vp @user`', 8000);
    return;
  }

  try {
    const pendingTips = await dbAll(
      `SELECT * FROM pending_tips WHERE receiver_id = ? AND processed = 0`,
      [targetUser.id]
    );

    if (pendingTips.length === 0) {
      await replyError(message, `No pending tips waiting for **${targetUser.username}**.`);
      return;
    }

    let total = 0;
    const lines = [];
    for (const tip of pendingTips) {
      const sender = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [tip.sender_id]);
      total += tip.amount_usd;
      lines.push(`• **${fmtUSD(tip.amount_usd)}** from ${sender?.username || 'Unknown'}`);
    }

    const embed = goldEmbed(`⏳ Pending Tips — ${targetUser.username}`, lines.join('\n').slice(0, 3500))
      .setThumbnail(avatarOf(targetUser))
      .addFields({ name: 'Total waiting', value: `**${pendingTips.length}** tips • **${fmtUSD(total)}**`, inline: false });

    await message.reply({ embeds: [embed] });
  } catch (error) {
    await replyError(message, `Couldn't load pending tips: ${error.message}`, 8000);
  }
}

// 14. !rpt — remove pending tips + refund
async function handleMessageRemovePending(message) {
  if (!await checkOwner(message)) return;

  const targetUser = message.mentions.users.first();
  if (!targetUser) {
    await replyError(message, 'Mention a user first.\nUsage: `!rpt @user`', 8000);
    return;
  }

  try {
    const pendingTips = await dbAll(
      `SELECT * FROM pending_tips WHERE receiver_id = ? AND processed = 0`,
      [targetUser.id]
    );

    if (pendingTips.length === 0) {
      await replyError(message, `No pending tips waiting for **${targetUser.username}**.`);
      return;
    }

    let totalRefund = 0;
    for (const tip of pendingTips) {
      await dbRun(`UPDATE users SET balance_usd = balance_usd + ? WHERE discord_id = ?`, [tip.amount_usd, tip.sender_id]);
      totalRefund += tip.amount_usd;
      await dbRun(`DELETE FROM pending_tips WHERE id = ?`, [tip.id]);
    }

    const embed = okEmbed('Pending Tips Cleared',
      `Removed **${pendingTips.length}** tips for **${targetUser.username}**.\nRefunded **${fmtUSD(totalRefund)}** to senders.`)
      .setThumbnail(avatarOf(targetUser));

    await message.reply({ embeds: [embed] });
  } catch (error) {
    await replyError(message, `Couldn't clear those: ${error.message}`, 8000);
  }
}

// ═══════════════════════════════════════════════════════════
// 💸 !tip HANDLER — modern outputs
// ═══════════════════════════════════════════════════════════
async function handleMessageTip(message) {
  const content = message.content;

  if (!content.toLowerCase().startsWith('!tip')) {
    return false;
  }

  const parts = content.split(' ');

  const receiver = message.mentions.users.first();
  if (!receiver) {
    await replyError(message, 'Mention someone to tip!\nExample: `!tip @John 1` or `!tip @John`');
    return true;
  }

  if (receiver.id === message.author.id) {
    await replyError(message, 'You can\'t tip yourself! Nice try though. 😉', 8000);
    return true;
  }

  let amountUSD;
  if (parts.length >= 3) {
    amountUSD = parseFloat(parts[2]);
    if (isNaN(amountUSD) || amountUSD <= 0) {
      await replyError(message, 'Enter a valid amount.\nExample: `!tip @John 1`', 8000);
      return true;
    }
  } else {
    amountUSD = 0.1;
  }

  const MIN_TIP_USD = 0.001;
  if (amountUSD < MIN_TIP_USD) {
    await replyError(message, `Minimum tip is **$${MIN_TIP_USD.toFixed(3)}**.\nTry a slightly bigger amount!`);
    return true;
  }

  const senderId = message.author.id;
  const receiverId = receiver.id;

  if (!await hasTipPermission(senderId)) {
    await replyError(message, 'You don\'t have tipping permission yet.\nAsk the owner: `!gp @user`', 12000);
    return true;
  }

  if (!botKeypair) {
    await replyError(message, 'Bot wallet isn\'t configured. Contact an admin.');
    return true;
  }

  try {
    const solPrice = await getSolPrice();
    const amountSOL = amountUSD / solPrice;

    const MIN_SOL_AMOUNT = 0.000005;
    if (amountSOL < MIN_SOL_AMOUNT) {
      await replyError(message,
        `That\'s too small for the Solana network.\n` +
        `${fmtUSD(amountUSD)} = ${amountSOL.toFixed(8)} SOL\n` +
        `Minimum on-chain: **${MIN_SOL_AMOUNT.toFixed(6)} SOL** (≈ ${fmtUSD(MIN_SOL_AMOUNT * solPrice)})`, 12000);
      return true;
    }

    const botBalance = await getBalance(botKeypair.publicKey.toString());
    const requiredBalance = amountSOL + 0.00001;

    if (botBalance < requiredBalance) {
      await replyError(message,
        `**Bot vault is empty!**\nPlease ask <@637927094319579140> or <@235836165716967424> to refill it.\n${shortAddr(botKeypair.publicKey.toString())}`, 15000);
      return true;
    }

    const [sender, receiverData] = await Promise.all([
      dbGet(`SELECT * FROM users WHERE discord_id = ?`, [senderId]),
      dbGet(`SELECT * FROM users WHERE discord_id = ?`, [receiverId])
    ]);

    if (!sender?.wallet) {
      await replyError(message, 'Link your wallet first: `!wallet <address>`');
      return true;
    }

    // Receiver has no wallet → queue the tip
    if (!receiverData?.wallet) {
      await dbRun(`INSERT INTO pending_tips (sender_id, receiver_id, amount_usd) VALUES (?, ?, ?)`,
        [senderId, receiverId, amountUSD]);

      const embed = goldEmbed('⏳ Tip Queued',
        `**${fmtUSD(amountUSD)}** (≈ ${amountSOL.toFixed(6)} SOL) is reserved for **${receiver.username}**.`)
        .setThumbnail(avatarOf(receiver))
        .addFields({
          name: 'Next step',
          value: 'They just need to run `!wallet <address>` — the tip auto-sends on link! ⚡',
          inline: false
        });

      await message.reply({ embeds: [embed] });
      return true;
    }

    try {
      new PublicKey(receiverData.wallet);
    } catch {
      await replyError(message, `**${receiver.username}** has an invalid wallet saved.\nAsk them to update it with \`!wallet <address>\`.`, 12000);
      return true;
    }

    const receiverPubkey = new PublicKey(receiverData.wallet);
    if (receiverPubkey.toString() === '11111111111111111111111111111111') {
      await replyError(message, `**${receiver.username}** has an invalid wallet saved.\nAsk them to update it with \`!wallet <address>\`.`, 12000);
      return true;
    }

    const result = await sendSOL(receiverData.wallet, amountSOL);

    if (!result.success) {
      await replyError(message, `${result.error}`, 15000);
      return true;
    }

    await Promise.all([
      dbRun(`INSERT INTO transactions (sender_id, receiver_id, amount_usd, amount_sol, signature) VALUES (?, ?, ?, ?, ?)`,
        [senderId, receiverId, amountUSD, amountSOL, result.signature]),
      dbRun(`UPDATE users SET balance_usd = balance_usd + ? WHERE discord_id = ?`, [amountUSD, receiverId]),
      dbRun(`UPDATE users SET total_tipped = total_tipped + ? WHERE discord_id = ?`, [amountUSD, senderId]),
      dbRun(`UPDATE users SET total_received = total_received + ? WHERE discord_id = ?`, [amountUSD, receiverId])
    ]);

    const embed = baseEmbed(BRAND.success)
      .setAuthor({ name: `${message.author.username}  →  ${receiver.username}`, iconURL: avatarOf(message.author) })
      .setTitle('💸 Tip Sent!')
      .setDescription(`## ${fmtUSD(amountUSD)}\n≈ **${amountSOL.toFixed(6)} SOL**`)
      .addFields(
        { name: '📈 Rate', value: `1 SOL = ${fmtUSD(solPrice)}`, inline: true },
        { name: '📬 To', value: shortAddr(receiverData.wallet), inline: true }
      )
      .setThumbnail(avatarOf(receiver));

    await message.reply({ embeds: [embed], components: solscanRow(result.signature) });
  } catch (error) {
    console.error('Tip error:', error);
    await replyError(message, `Transaction failed:\n${error.message}`, 12000);
  }

  return true;
}

// ═══════════════════════════════════════════════════════════
// 📨 MESSAGE ROUTER (unchanged logic)
// ═══════════════════════════════════════════════════════════
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (content.toLowerCase().startsWith('!tip')) {
    await handleMessageTip(message);
    return;
  }

  if (content.startsWith('!')) {
    const args = content.split(' ');
    const command = args[0].toLowerCase();

    try {
      switch (command) {
        case '!wallet':  await handleMessageWallet(message); break;
        case '!bal':     await handleMessageBalance(message); break;
        case '!faucet':  await handleMessageFaucet(message); break;
        case '!history': await handleMessageHistory(message); break;
        case '!help':    await handleMessageHelp(message); break;
        case '!gp':      await handleMessageGivePerms(message); break;
        case '!rp':      await handleMessageRemovePerms(message); break;
        case '!lp':      await handleMessageListPerms(message); break;
        case '!last':    await handleMessageLast(message); break;
        case '!botbal':  await handleMessageBotBalance(message); break;
        case '!fon':     await handleMessageFaucetOn(message); break;
        case '!foff':    await handleMessageFaucetOff(message); break;
        case '!vp':      await handleMessageViewPending(message); break;
        case '!rpt':     await handleMessageRemovePending(message); break;
        default: break; // ignore unknown commands
      }
    } catch (error) {
      console.error(`Error handling ${command}:`, error);
      const reply = await message.reply({ embeds: [errEmbed(`Error: ${error.message}`)] }).catch(() => {});
      if (reply) {
        autoDeleteErrorMessage(reply, 10000);
        autoDeleteErrorMessage(message, 10000);
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════
// 🟢 READY
// ═══════════════════════════════════════════════════════════
client.once('ready', async () => {
  console.log(`Bot online! Logged in as ${client.user.tag}`);
  if (botKeypair) {
    console.log(`Bot wallet: ${botKeypair.publicKey.toString()}`);
  }
  if (OWNER_ID) {
    console.log(`Owner ID: ${OWNER_ID}`);
  }
  console.log('🎨 Modern UI loaded — branded embeds, avatars & Solscan buttons');
  console.log('📝 Commands: !wallet, !bal, !faucet, !history, !help, !tip, !botbal');
  console.log('🔧 Admin: !gp, !rp, !lp, !last, !fon, !foff, !vp, !rpt');

  await client.user.setPresence({
    activities: [{ name: 'Official JJH TipBot', type: 3, state: '💰 Solana Tips' }],
    status: 'online'
  });
});

client.login(process.env.DISCORD_TOKEN);
