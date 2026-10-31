import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Bot } from './yapper.js';

const DATA_FILE = path.join(process.cwd(), 'stats.json');
const COUNTER_REFRESH_MS = 5 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 1900;
const token = process.env.YAPPER_BOT_TOKEN;

if (!token) {
  console.error('Yapin hosting should provide YAPPER_BOT_TOKEN automatically. For local runs, set it in your environment.');
  process.exit(1);
}

function loadStats() {
  let contents;
  try {
    contents = readFileSync(DATA_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Could not read stats.json: ${error.message}`, { cause: error });
  }

  let data;
  try {
    data = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not parse stats.json: ${error.message}`, { cause: error });
  }
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    throw new Error('stats.json must contain a JSON object.');
  }
  return data;
}

let stats = loadStats();

function saveStats() {
  const temporaryFile = `${DATA_FILE}.tmp`;
  try {
    writeFileSync(temporaryFile, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
    renameSync(temporaryFile, DATA_FILE);
  } catch (error) {
    throw new Error(`Could not save stats.json: ${error.message}`, { cause: error });
  }
}

function serverStats(serverId) {
  const key = String(serverId);
  const current = stats[key] ??= {};
  if (!current || Array.isArray(current) || typeof current !== 'object') {
    throw new Error(`Invalid stats entry for server ${key} in stats.json.`);
  }

  current.joins ??= 0;
  current.leaves ??= 0;
  current.enabled_stats ??= ['online', 'members'];
  current.goal ??= null;
  current.staff_role_id ??= null;
  current.staff_role_name ??= null;
  current.welcome_channel_id ??= null;
  current.welcome_template ??= 'Welcome {user} to {server}!';
  current.counter_category_id ??= null;
  current.counters ??= {};
  current.counter_names ??= {};
  current.command_restrictions ??= {};
  return current;
}

const bot = new Bot(token);
let counterTimer;
let counterRefreshRunning = false;

function serverIdFor(msg) {
  return msg.server_id;
}

async function requireServer(msg) {
  const serverId = serverIdFor(msg);
  if (!serverId) {
    await msg.reply('Run this command in a server.');
    return null;
  }
  return serverId;
}

async function isServerOwner(msg, serverId) {
  let server;
  try {
    server = await bot.server(serverId);
  } catch (error) {
    console.error(`Could not check server owner for ${serverId}:`, error.message);
    await msg.reply('I couldn’t verify the server owner. Please try again later.');
    return false;
  }
  const ownerId = server.owner_id ?? server.owner?.id;
  if (String(ownerId) !== String(msg.author_id ?? '')) {
    await msg.reply('Only the server owner can change these settings.');
    return false;
  }
  return true;
}

function cleanId(value) {
  const match = /^(?:<@!?([A-Za-z0-9_-]+)>|<@&([A-Za-z0-9_-]+)>|<#([A-Za-z0-9_-]+)>|([A-Za-z0-9_-]+))$/.exec(String(value ?? ''));
  return match?.slice(1).find((part) => part !== undefined) ?? null;
}

function registerCommand(name, description, ownerOnly = false) {
  return (handler) => {
    bot.command(name, description, async (msg) => {
      const serverId = serverIdFor(msg);
      if (serverId) {
        const configured = serverStats(serverId).command_restrictions[name];
        const userId = String(msg.author_id ?? '');
        if (configured?.length && !configured.includes(userId)) {
          await msg.reply(`You aren’t allowed to use /${name} in this server.`);
          return;
        }
        if (ownerOnly && !(await isServerOwner(msg, serverId))) return;
      }
      await handler(msg);
    });
  };
}

async function sendLong(msg, text) {
  let remaining = String(text);
  while (remaining.length) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      await msg.reply(remaining);
      return;
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt < 1) splitAt = MAX_MESSAGE_LENGTH;
    await msg.reply(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
}

async function fetchAllMembers(serverId) {
  const results = [];
  let after;
  while (true) {
    const batch = await bot.members(serverId, after);
    if (!batch.length) break;
    results.push(...batch);
    const last = batch.at(-1);
    const nextAfter = last.user_id ?? last.user?.id ?? last.id;
    if (!nextAfter || String(nextAfter) === String(after) || batch.length < 200) break;
    after = nextAfter;
  }
  return results;
}

function memberHasRole(member, roleId) {
  const roles = member.role_ids ?? member.roles ?? member.user?.role_ids ?? [];
  return Array.isArray(roles) && roles.some((role) =>
    String(typeof role === 'object' ? role.id : role) === String(roleId));
}

function botStatus(member) {
  const profiles = [
    member,
    member.user,
    member.profile,
    member.account,
    member.user?.profile,
  ].filter((profile) => profile && typeof profile === 'object');
  let flagFound = false;
  for (const profile of profiles) {
    for (const key of ['bot', 'is_bot', 'isBot', 'bot_account', 'is_bot_account']) {
      if (!(key in profile)) continue;
      flagFound = true;
      const value = profile[key];
      if (value === true || value === 1 || String(value).toLowerCase() === 'true' ||
          String(value).toLowerCase() === 'bot') return true;
    }

    for (const key of ['type', 'account_type', 'user_type']) {
      if (!(key in profile)) continue;
      flagFound = true;
      if (String(profile[key]).toLowerCase() === 'bot') return true;
    }

    const flags = profile.flags ?? profile.user_flags;
    if (Array.isArray(flags)) {
      flagFound = true;
      if (flags.some((flag) => String(flag).toLowerCase() === 'bot')) return true;
    } else if (flags && typeof flags === 'object' && 'bot' in flags) {
      flagFound = true;
      if (flags.bot === true || flags.bot === 1) return true;
    }

    if (profile.application_id || profile.bot_id) return true;
  }
  return flagFound ? false : null;
}

function numericValue(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function getBoostCount(server, counts) {
  return numericValue(
    server.boost_count,
    server.boosts_count,
    server.server_boost_count,
    server.premium_subscription_count,
    server.boosts,
    counts.boost_count,
    counts.boosts_count,
    counts.server_boost_count,
    counts.premium_subscription_count,
    counts.boosts,
  );
}

const STAT_LABELS = {
  online: '🟢 Online',
  members: '👥 Members',
  staff: '💼 Total Staff',
  bots: '🤖 Total Bots',
  boosts: '⚡ Total Boosts',
};

async function statValues(serverId, kinds, counts) {
  counts ??= await bot.memberCounts(serverId);
  const values = {
    online: counts.online_count,
    members: counts.member_count,
  };
  const needsMembers = kinds.includes('staff') || kinds.includes('bots');
  const [members, server] = await Promise.all([
    needsMembers ? fetchAllMembers(serverId) : Promise.resolve(null),
    kinds.includes('boosts') ? bot.server(serverId) : Promise.resolve(null),
  ]);
  if (kinds.includes('staff')) {
    const roleId = serverStats(serverId).staff_role_id;
    if (!roleId) throw new Error('Set a staff role first with /staff-role <role name or role mention>.');
    values.staff = members.filter((member) => memberHasRole(member, roleId)).length;
  }
  if (kinds.includes('bots')) {
    const statuses = members.map(botStatus);
    values.bots = statuses.some((status) => status !== null)
      ? statuses.filter((status) => status === true).length
      : null;
  }
  if (kinds.includes('boosts')) values.boosts = getBoostCount(server, counts);
  return values;
}

async function ensureCounters(serverId, kinds, counts) {
  const tracked = serverStats(serverId);
  const selected = [...new Set(kinds)];
  if (!selected.length) return;

  counts ??= await bot.memberCounts(serverId);
  const values = await statValues(serverId, selected, counts);
  let channels = await bot.channels(serverId);
  const visibleChannels = new Set(channels.map((channel) => String(channel.id)));

  if (!tracked.counter_category_id) {
    const categories = await bot.categories(serverId);
    const category = categories.find((item) => item.name?.toLowerCase() === 'server stats')
      ?? await bot.createCategory(serverId, 'Server Stats');
    if (!category?.id) throw new Error('Yapin did not return an ID for the Server Stats category.');
    tracked.counter_category_id = category.id;
    saveStats();
  }

  for (const kind of selected) {
    const value = values[kind];
    const label = STAT_LABELS[kind];
    const displayValue = value ?? 'Unavailable';
    const name = `${label}: ${displayValue}`;
    let channelId = tracked.counters[kind];
    if (!channelId) {
      const oldNames = {
        online: /^(?:(?:🟢\s*)?online):\s*\d+$/i,
        members: /^(?:(?:👥\s*)?members):\s*\d+$/i,
        staff: /^(?:💼\s*)?total staff:\s*(?:\d+|Unavailable)$/i,
        bots: /^(?:🤖\s*)?total bots:\s*(?:\d+|Unavailable)$/i,
        boosts: /^(?:⚡\s*)?total boosts:\s*(?:\d+|Unavailable)$/i,
      };
      const existing = channels.find((channel) => {
        const categoryId = channel.category_id ?? channel.category?.id;
        return oldNames[kind]?.test(channel.name ?? '') &&
          (!categoryId || String(categoryId) === String(tracked.counter_category_id));
      });
      if (existing) channelId = existing.id;
    }
    if (channelId && visibleChannels.has(String(channelId))) {
      if (tracked.counter_names[kind] !== name) {
        await bot.editChannel(channelId, { name });
      }
    } else {
      const channel = await bot.createChannel(serverId, name, {
        kind: 'voice',
        categoryId: tracked.counter_category_id,
      });
      if (!channel?.id) throw new Error(`Yapin did not return an ID for the ${kind} counter channel.`);
      channelId = channel.id;
      tracked.counters[kind] = channelId;
      visibleChannels.add(String(channelId));
    }
    tracked.counters[kind] = channelId;
    tracked.counter_names[kind] = name;
    saveStats();
  }
}

async function refreshCounters(serverId, counts) {
  const tracked = serverStats(serverId);
  if (!Object.keys(tracked.counters).length) return;
  await ensureCounters(serverId, Object.keys(tracked.counters), counts);
}

async function refreshAllCounters() {
  if (counterRefreshRunning) return;
  counterRefreshRunning = true;
  try {
    let servers;
    try {
      servers = await bot.servers();
    } catch (error) {
      console.error('Could not refresh server counters:', error.message);
      return;
    }
    for (const server of servers) {
      try {
        const tracked = serverStats(server.id);
        const optionalEnabled = tracked.enabled_stats.some((type) =>
          ['staff', 'bots', 'boosts'].includes(type));
        if (Object.keys(tracked.counters).length || optionalEnabled) {
          await ensureCounters(server.id, optionalEnabled
            ? tracked.enabled_stats
            : Object.keys(tracked.counters));
        }
      } catch (error) {
        console.error(`Could not refresh counters for ${server.id}:`, error.message);
      }
    }
  } finally {
    counterRefreshRunning = false;
  }
}

async function setupCounters(msg) {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const tracked = serverStats(serverId);
  try {
    await ensureCounters(serverId, tracked.enabled_stats);
  } catch (error) {
    console.error(`Counter setup was incomplete for ${serverId}:`, error.message);
    await msg.reply(`I couldn’t complete counter setup: ${error.message}`);
    return;
  }

  if (Object.keys(tracked.counters).length) {
    await msg.reply('Stats counters are set up. Enabled counters refresh periodically.');
  } else {
    await msg.reply('The server did not return member counts, so no counters were created.');
  }
}

registerCommand('help', 'List commands or explain a command')(async (msg) => {
  const commands = {
    help: 'List commands or explain one.',
    ping: 'Measure the Yapin API response time.',
    invite: 'List server invites.',
    setup: 'Create member and online counter channels.',
    customize: 'Alias for /setup.',
    stats: 'Show member and join/leave stats.',
    enable: 'Enable stats fields: online, members, staff, bots, boosts.',
    disable: 'Disable stats fields and remove their counter channels.',
    'staff-role': 'Set the role used for the staff count.',
    counter: 'Add, remove, list, or refresh stat counters.',
    data: 'Show this bot’s stored server configuration.',
    members: 'List server members.',
    category: 'List, create, or select the counter category.',
    welcome: 'Configure a welcome message.',
    goal: 'Set or view a member-count goal.',
    command: 'Restrict a command to selected user IDs.',
    bot: 'Show bot information.',
    serverinfo: 'Show server information.',
    userinfo: 'Show a member’s information.',
    roleinfo: 'Show a role’s information.',
    channelinfo: 'Show a channel’s information.',
    inviteinfo: 'Show details for a server invite.',
    emojiinfo: 'Explain a Unicode or custom emoji.',
    avatar: 'Show a member’s avatar link.',
    check: 'Check server stats setup.',
    debug: 'Show non-sensitive diagnostic information.',
    support: 'Get Yapin bot-development support information.',
    reset: 'Remove bot configuration and its managed counters.',
  };
  const requested = msg.argv?.[0]?.toLowerCase().replace(/^\//, '');
  if (requested) {
    await msg.reply(commands[requested] ? `/${requested}: ${commands[requested]}` : `No local command named /${requested}.`);
    return;
  }
  await msg.reply(`**Commands**\n${Object.entries(commands).map(([name, description]) => `\`/${name}\` — ${description}`).join('\n')}`);
});

registerCommand('ping', 'Measure the Yapin API response time')(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const started = performance.now();
  try {
    await bot.memberCounts(serverId);
  } catch (error) {
    console.error(`Ping failed for server ${serverId}:`, error.message);
    await msg.reply('Yapin API request failed; check the bot connection and permissions.');
    return;
  }
  const elapsedMs = performance.now() - started;
  await msg.reply(`Yapin API latency: **${elapsedMs.toFixed(0)} ms**. Gateway/shard latency isn’t exposed by this SDK.`);
});

registerCommand('invite', 'List invites for this server')(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  let invites;
  try {
    invites = await bot.invites(serverId);
  } catch (error) {
    console.error(`Could not read invites for server ${serverId}:`, error.message);
    await msg.reply('I couldn’t read server invites. The bot may need Manage Server permission.');
    return;
  }
  if (!invites.length) {
    await msg.reply('This server has no invites I can see.');
    return;
  }
  await sendLong(msg, `**Server invites**\n${invites.slice(0, 20).map((item) => `${item.url ?? item.code} — uses: ${item.uses ?? 0}`).join('\n')}`);
});

registerCommand('setup', 'Create member and online counter channels', true)(setupCounters);
registerCommand('customize', 'Create member and online counter channels', true)(setupCounters);

registerCommand('enable', 'Enable one or more stats fields', true)(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const aliases = {
    online: 'online',
    member: 'members',
    members: 'members',
    staff: 'staff',
    bot: 'bots',
    bots: 'bots',
    boost: 'boosts',
    boosts: 'boosts',
  };
  const requested = (msg.argv ?? []).flatMap((value) => value.toLowerCase().split(/[|,]/)).filter(Boolean);
  if (!requested.length) {
    await msg.reply('Usage: /enable online, /enable members, /enable staff, /enable bots, or /enable boosts.');
    return;
  }
  const types = requested.map((type) => aliases[type]);
  if (types.some((type) => !type)) {
    await msg.reply('Valid stats types: online, members, staff, bots, boosts.');
    return;
  }
  const tracked = serverStats(serverId);
  const enabled = new Set(tracked.enabled_stats);
  for (const type of types) enabled.add(type);
  const nextEnabled = ['online', 'members', 'staff', 'bots', 'boosts']
    .filter((type) => enabled.has(type));
  try {
    await ensureCounters(serverId, nextEnabled);
  } catch (error) {
    console.error(`Could not enable counters for ${serverId}:`, error.message);
    await msg.reply(`Couldn’t enable these stats or create their channels: ${error.message}`);
    return;
  }
  tracked.enabled_stats = nextEnabled;
  saveStats();
  await msg.reply(`Enabled stats and updated the Server Stats channels: ${types.join(', ')}.`);
});

registerCommand('disable', 'Disable one or more stats fields and remove their counter channels', true)(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const aliases = {
    all: 'all',
    online: 'online',
    member: 'members',
    members: 'members',
    staff: 'staff',
    bot: 'bots',
    bots: 'bots',
    boost: 'boosts',
    boosts: 'boosts',
  };
  const requested = (msg.argv ?? []).flatMap((value) => value.toLowerCase().split(/[|,]/)).filter(Boolean);
  if (!requested.length) {
    await msg.reply('Usage: /disable online|members|staff|bots|boosts|all');
    return;
  }
  const types = requested.map((type) => aliases[type]);
  if (types.some((type) => !type)) {
    await msg.reply('Valid stats types: online, members, staff, bots, boosts, all.');
    return;
  }

  const tracked = serverStats(serverId);
  const selected = new Set(types.includes('all')
    ? ['online', 'members', 'staff', 'bots', 'boosts']
    : types);
  const failed = [];
  for (const type of selected) {
    const channelId = tracked.counters[type];
    if (channelId) {
      try {
        await bot.deleteChannel(channelId);
      } catch (error) {
        console.error(`Could not delete the ${type} counter for ${serverId}:`, error.message);
        failed.push(type);
        continue;
      }
      delete tracked.counters[type];
      delete tracked.counter_names[type];
    }
    tracked.enabled_stats = tracked.enabled_stats.filter((enabledType) => enabledType !== type);
  }
  saveStats();
  if (failed.length) {
    await msg.reply(`Disabled the other requested stats. I couldn’t delete these counter channels: ${failed.join(', ')}. Check the bot’s Manage Channels permission and retry.`);
    return;
  }
  await msg.reply(`Disabled stats and removed their counter channels: ${[...selected].join(', ')}.`);
});

registerCommand('staff-role', 'Set the server role counted as staff', true)(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const query = msg.argv?.join(' ').trim();
  if (!query) {
    const saved = serverStats(serverId);
    await msg.reply(saved.staff_role_id
      ? `Staff role: **${saved.staff_role_name ?? saved.staff_role_id}** (<@&${saved.staff_role_id}>)`
      : 'No staff role is set. Use /staff-role <role name or role mention>.');
    return;
  }

  let roles;
  try {
    roles = await bot.roles(serverId);
  } catch (error) {
    console.error(`Could not load roles for /staff-role in ${serverId}:`, error.message);
    await msg.reply('I couldn’t retrieve this server’s roles. Check the bot’s permissions.');
    return;
  }
  const roleId = cleanId(query);
  const role = roles.find((item) =>
    (roleId && String(item.id) === roleId) ||
    String(item.name ?? '').toLocaleLowerCase() === query.toLocaleLowerCase());
  if (!role) {
    await msg.reply('I couldn’t find that role. Use its exact name or mention the role.');
    return;
  }
  const saved = serverStats(serverId);
  saved.staff_role_id = String(role.id);
  saved.staff_role_name = role.name ?? String(role.id);
  saveStats();
  if (saved.enabled_stats.includes('staff')) {
    try {
      await ensureCounters(serverId, saved.enabled_stats);
    } catch (error) {
      console.error(`Could not update staff counter for ${serverId}:`, error.message);
      await msg.reply(`Staff role saved, but I couldn’t update its counter channel: ${error.message}`);
      return;
    }
  }
  await msg.reply(`Staff role set to **${saved.staff_role_name}** (<@&${saved.staff_role_id}>).`);
});

registerCommand('stats', 'Show this server’s member and join/leave stats')(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  let counts;
  const tracked = serverStats(serverId);
  const enabled = new Set(tracked.enabled_stats);
  let members;
  let server;
  try {
    counts = await bot.memberCounts(serverId);
    if (enabled.has('bots') || enabled.has('staff')) {
      members = await fetchAllMembers(serverId);
    }
    if (enabled.has('boosts')) {
      server = await bot.server(serverId);
    }
  } catch (error) {
    console.error(`Could not fetch stats for server ${serverId}:`, error.message);
    await msg.reply('I couldn’t load all requested server stats. Check the bot’s permissions and try again.');
    return;
  }

  const lines = ['📊 Server Stats'];
  if (enabled.has('online')) lines.push(`🟢 ONLINE: ${counts.online_count ?? 'Unavailable'}`);
  if (enabled.has('members')) lines.push(`👥 MEMBERS: ${counts.member_count ?? 'Unavailable'}`);
  if (enabled.has('staff')) {
    if (!tracked.staff_role_id) {
      lines.push('💼 TOTAL STAFF: Not set (use /staff-role <role>)');
    } else {
      const staffCount = members.filter((member) => memberHasRole(member, tracked.staff_role_id)).length;
      lines.push(`💼 TOTAL STAFF: ${staffCount}`);
    }
  }
  if (enabled.has('bots')) {
    const bots = members.map(botStatus);
    const botCount = bots.some((status) => status !== null)
      ? bots.filter((status) => status === true).length
      : 'Unavailable (Yapin member data has no bot flag)';
    lines.push(`🤖 TOTAL BOTS: ${botCount}`);
  }
  if (enabled.has('boosts')) {
    lines.push(`⚡ TOTAL BOOSTS: ${getBoostCount(server, counts) ?? 'Unavailable'}`);
  }
  await msg.reply(lines.join('\n'));
  try {
    await refreshCounters(serverId, counts);
  } catch (error) {
    console.error(`Could not update counters for server ${serverId}:`, error.message);
  }
});

registerCommand('counter', 'Manage server stat counters', true)(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const tracked = serverStats(serverId);
  const args = (msg.argv ?? []).map((arg) => arg.toLowerCase());
  const action = args[0] ?? 'list';

  if (action === 'list') {
    const counters = Object.entries(tracked.counters);
    if (!counters.length) {
      await msg.reply('No counters are configured. Run /setup to create member and online counters.');
      return;
    }
    const lines = await Promise.all(counters.map(async ([kind, channelId]) => {
      const channel = await bot.channel(channelId);
      return `${kind}: <#${channelId}> (${channel?.name ?? channelId})`;
    }));
    await msg.reply(`**Counters**\n${lines.join('\n')}`);
    return;
  }

  if (action === 'refresh') {
    try {
      await refreshCounters(serverId);
    } catch (error) {
      console.error(`Could not refresh counters for server ${serverId}:`, error.message);
      await msg.reply('I couldn’t refresh the counters. Check the bot’s channel permissions.');
      return;
    }
    await msg.reply('Counters refreshed.');
    return;
  }

  if (action === 'add') {
    const aliases = { member: 'members', members: 'members', online: 'online', staff: 'staff', bot: 'bots', bots: 'bots', boost: 'boosts', boosts: 'boosts' };
    const kind = aliases[args[1]];
    if (args.length !== 2 || !kind) {
      await msg.reply('Usage: /counter add online|members|staff|bots|boosts');
      return;
    }
    try {
      await ensureCounters(serverId, [kind]);
      if (!tracked.enabled_stats.includes(kind)) tracked.enabled_stats.push(kind);
      tracked.enabled_stats = ['online', 'members', 'staff', 'bots', 'boosts']
        .filter((type) => tracked.enabled_stats.includes(type));
      saveStats();
      await msg.reply(`Created or updated the ${STAT_LABELS[kind]} counter: <#${tracked.counters[kind]}>`);
    } catch (error) {
      console.error(`Could not add ${kind} counter for ${serverId}:`, error.message);
      await msg.reply(`I couldn’t create that counter: ${error.message}`);
    }
    return;
  }

  if (action === 'remove') {
    const aliases = { member: 'members', members: 'members', online: 'online', staff: 'staff', bot: 'bots', bots: 'bots', boost: 'boosts', boosts: 'boosts' };
    const kind = aliases[args[1]];
    if (args.length !== 2 || !kind) {
      await msg.reply('Usage: /counter remove online|members|staff|bots|boosts');
      return;
    }
    const channelId = tracked.counters[kind];
    if (!channelId) {
      await msg.reply(`There is no ${kind} counter to remove.`);
      return;
    }
    try {
      await bot.deleteChannel(channelId);
    } catch (error) {
      console.error(`Could not remove counter ${channelId}:`, error.message);
      await msg.reply('I couldn’t delete that counter channel.');
      return;
    }
    delete tracked.counters[kind];
    delete tracked.counter_names[kind];
    tracked.enabled_stats = tracked.enabled_stats.filter((type) => type !== kind);
    saveStats();
    await msg.reply(`Removed the ${kind} counter.`);
    return;
  }

  await msg.reply('Usage: /counter list|refresh|add online|members|staff|bots|boosts|remove <type>');
});

registerCommand('data', 'Show this bot’s stored server configuration', true)(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  await sendLong(msg, `\`\`\`json\n${JSON.stringify(serverStats(serverId), null, 2)}\n\`\`\``);
});

registerCommand('members', 'List server members')(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  let allMembers;
  try {
    allMembers = await fetchAllMembers(serverId);
  } catch (error) {
    console.error(`Could not fetch members for server ${serverId}:`, error.message);
    await msg.reply('I couldn’t retrieve the member list. Check the bot’s server permissions.');
    return;
  }
  if (!allMembers.length) {
    await msg.reply('No members were returned.');
    return;
  }
  const lines = allMembers.slice(0, 40).map((member) => {
    const name = member.display_name ?? member.username ?? member.name ?? member.user?.display_name ?? member.user?.username ?? 'Unknown';
    const id = member.id ?? member.user_id ?? '?';
    return `• ${name} (\`${id}\`)`;
  });
  const suffix = allMembers.length > 40 ? `\nShowing 40 of ${allMembers.length}.` : '';
  await sendLong(msg, `**Members (${allMembers.length})**\n${lines.join('\n')}${suffix}`);
});

registerCommand('category', 'Manage the category used for stat counters', true)(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const args = msg.argv ?? [];
  const action = args[0]?.toLowerCase() ?? 'list';
  const tracked = serverStats(serverId);
  try {
    if (action === 'list') {
      const categories = await bot.categories(serverId);
      if (!categories.length) {
        await msg.reply('This server has no categories I can see.');
        return;
      }
      const lines = categories.map((item) =>
        `${item.name} (\`${item.id}\`)${String(item.id) === String(tracked.counter_category_id) ? ' — selected' : ''}`);
      await sendLong(msg, `**Categories**\n${lines.join('\n')}`);
      return;
    }
    if (action === 'create') {
      const name = args.slice(1).join(' ').trim();
      if (!name) {
        await msg.reply('Usage: /category create <name>');
        return;
      }
      const created = await bot.createCategory(serverId, name);
      if (!created?.id) {
        await msg.reply('Yapin didn’t return the new category ID.');
        return;
      }
      tracked.counter_category_id = created.id;
      saveStats();
      await msg.reply(`Created and selected category **${created.name ?? name}**.`);
      return;
    }
    if (action === 'use' && args.length === 2) {
      const categoryId = cleanId(args[1]);
      if (!categoryId) {
        await msg.reply('Usage: /category use <category ID>');
        return;
      }
      const categories = await bot.categories(serverId);
      if (!categories.some((item) => String(item.id) === categoryId)) {
        await msg.reply('That category isn’t visible in this server.');
        return;
      }
      tracked.counter_category_id = categoryId;
      saveStats();
      await msg.reply('Selected that category for future stat counters.');
      return;
    }
  } catch (error) {
    console.error(`Category command failed for server ${serverId}:`, error.message);
    await msg.reply('I couldn’t complete that category action. Check the bot’s channel permissions.');
    return;
  }
  await msg.reply('Usage: /category list|create <name>|use <category ID>');
});

registerCommand('welcome', 'Configure the server welcome message', true)(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const args = msg.argv ?? [];
  const action = args[0]?.toLowerCase() ?? 'show';
  const tracked = serverStats(serverId);

  if (action === 'show') {
    if (!tracked.welcome_channel_id) {
      await msg.reply('Welcome messages are disabled. Use /welcome set <channel ID> [message].');
      return;
    }
    await msg.reply(
      `Welcome channel: <#${tracked.welcome_channel_id}>\nMessage: ${tracked.welcome_template}\n` +
      'Available placeholders: {user}, {server}, {member_count}',
    );
    return;
  }
  if (action === 'disable') {
    tracked.welcome_channel_id = null;
    saveStats();
    await msg.reply('Welcome messages are disabled.');
    return;
  }
  if (action === 'set' && args.length >= 2) {
    const channelId = cleanId(args[1]);
    if (!channelId) {
      await msg.reply('Usage: /welcome set <channel ID> [message]');
      return;
    }
    let channels;
    try {
      channels = await bot.channels(serverId);
    } catch (error) {
      console.error(`Could not validate welcome channel in ${serverId}:`, error.message);
      await msg.reply('I couldn’t check channels in this server.');
      return;
    }
    if (!channels.some((channel) => String(channel.id) === channelId)) {
      await msg.reply('That channel isn’t visible in this server.');
      return;
    }
    tracked.welcome_channel_id = channelId;
    if (args.length > 2) tracked.welcome_template = args.slice(2).join(' ').slice(0, 500);
    saveStats();
    await msg.reply(
      `Welcome message set for <#${channelId}>.\nAvailable placeholders: {user}, {server}, {member_count}`,
    );
    return;
  }
  await msg.reply('Usage: /welcome show|set <channel ID> [message]|disable');
});

registerCommand('goal', 'Set or view a member-count goal', true)(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const tracked = serverStats(serverId);
  const args = msg.argv ?? [];
  if (args[0]?.toLowerCase() === 'clear') {
    tracked.goal = null;
    saveStats();
    await msg.reply('Member goal cleared.');
    return;
  }
  if (args[0]?.toLowerCase() === 'set') {
    if (args.length !== 2 || !/^\d+$/.test(args[1]) || Number(args[1]) < 1) {
      await msg.reply('Usage: /goal set <positive member count>');
      return;
    }
    tracked.goal = Number(args[1]);
    saveStats();
  }
  let count;
  try {
    count = (await bot.memberCounts(serverId)).member_count;
  } catch (error) {
    console.error(`Could not fetch goal progress for ${serverId}:`, error.message);
    await msg.reply('I couldn’t fetch the current member count.');
    return;
  }
  if (!tracked.goal) {
    await msg.reply('No member goal is set. Use /goal set <positive member count>.');
    return;
  }
  const progress = Number(count ?? 0);
  await msg.reply(`Member goal: **${progress} / ${tracked.goal}** (${Math.min(100, Math.floor(progress * 100 / tracked.goal))}%).`);
});

registerCommand('command', 'Restrict a command to selected user IDs', true)(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const args = msg.argv ?? [];
  const restrictions = serverStats(serverId).command_restrictions;
  if (!args.length || args[0].toLowerCase() === 'list') {
    const entries = Object.entries(restrictions);
    if (!entries.length) {
      await msg.reply('No command restrictions are configured.');
      return;
    }
    await sendLong(msg, `**Command restrictions**\n${entries.map(([name, users]) => `/${name}: ${users.join(', ')}`).join('\n')}`);
    return;
  }
  if (args.length !== 3 || !['restrict', 'allow'].includes(args[0].toLowerCase())) {
    await msg.reply('Usage: /command restrict|allow <command name> <user ID>, or /command list');
    return;
  }
  const name = args[1].toLowerCase().replace(/^\//, '');
  if (!bot.commands.has(name) || name === 'command') {
    await msg.reply('Choose an existing command other than /command.');
    return;
  }
  const userId = cleanId(args[2]);
  if (!userId) {
    await msg.reply('Provide one numeric user ID.');
    return;
  }
  const allowed = restrictions[name] ??= [];
  if (args[0].toLowerCase() === 'restrict') {
    if (!allowed.includes(userId)) allowed.push(userId);
    await msg.reply(`Only listed users can now use /${name}.`);
  } else {
    restrictions[name] = allowed.filter((id) => id !== userId);
    if (!restrictions[name].length) delete restrictions[name];
    await msg.reply(`Updated the /${name} user allow-list.`);
  }
  saveStats();
});

registerCommand('bot', 'Show bot information')(async (msg) => {
  await msg.reply(
    `**Yapin Server Stats Bot**\nAccount: ${bot.me?.username ?? 'Yapin bot'}\n` +
    `SDK: yapper.js ${bot.version ?? 'official'}\nCommands registered: ${bot.commands.size}`,
  );
});

registerCommand('serverinfo', 'Show information about this server')(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  let server;
  let counts;
  try {
    [server, counts] = await Promise.all([bot.server(serverId), bot.memberCounts(serverId)]);
  } catch (error) {
    console.error(`Could not fetch server info for ${serverId}:`, error.message);
    await msg.reply('I couldn’t fetch server information.');
    return;
  }
  const lines = [`**${server.name ?? 'Server'}**`, `ID: \`${serverId}\``, `Members: ${counts.member_count ?? 'Unavailable'}`];
  if (counts.online_count != null) lines.push(`Online: ${counts.online_count}`);
  for (const [key, label] of [['created_at', 'Created'], ['owner_id', 'Owner ID']]) {
    if (server[key]) lines.push(`${label}: ${server[key]}`);
  }
  await msg.reply(lines.join('\n'));
});

registerCommand('userinfo', 'Show information about a member')(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const userId = msg.argv?.[0] ? cleanId(msg.argv[0]) : msg.author_id;
  if (!userId) {
    await msg.reply('Usage: /userinfo [user ID]');
    return;
  }
  let member;
  let user;
  try {
    member = await bot.member(serverId, userId);
    user = member.user ?? await bot.user(userId);
  } catch (error) {
    console.error(`Could not fetch user ${userId} in ${serverId}:`, error.message);
    await msg.reply('I couldn’t find that member in this server.');
    return;
  }
  const name = user.display_name ?? user.username ?? member.username ?? 'Unknown';
  const lines = [`**${name}**`, `ID: \`${userId}\``];
  for (const [value, label] of [
    [member.nickname, 'Nickname'],
    [member.joined_at, 'Joined server'],
    [user.created_at, 'Account created'],
  ]) {
    if (value) lines.push(`${label}: ${value}`);
  }
  await msg.reply(lines.join('\n'));
});

registerCommand('roleinfo', 'Show information about a role')(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  if (!msg.argv?.length) {
    await msg.reply('Usage: /roleinfo <role name or ID>');
    return;
  }
  const target = cleanId(msg.argv[0]) ?? msg.argv.join(' ').trim();
  let roles;
  try {
    roles = await bot.roles(serverId);
  } catch (error) {
    console.error(`Could not fetch roles for ${serverId}:`, error.message);
    await msg.reply('I couldn’t retrieve this server’s roles.');
    return;
  }
  const role = roles.find((item) =>
    String(item.id) === target || String(item.name ?? '').toLowerCase() === target.toLowerCase());
  if (!role) {
    await msg.reply('I couldn’t find that role.');
    return;
  }
  await msg.reply(
    `**${role.name ?? 'Role'}**\nID: \`${role.id ?? 'unknown'}\`\n` +
    `Color: ${role.color ?? 'Default'}\nMentionable: ${role.mentionable ? 'Yes' : 'No'}`,
  );
});

registerCommand('channelinfo', 'Show information about a channel')(async (msg) => {
  const channelId = msg.argv?.[0] ? cleanId(msg.argv[0]) : msg.channel_id;
  if (!channelId) {
    await msg.reply('Usage: /channelinfo [channel ID]');
    return;
  }
  const channel = await bot.channel(channelId);
  if (!channel) {
    await msg.reply('I couldn’t find that channel.');
    return;
  }
  const lines = [`**${channel.name ?? 'Channel'}**`, `ID: \`${channel.id ?? channelId}\``];
  for (const [key, label] of [['kind', 'Type'], ['type', 'Type'], ['category_id', 'Category'], ['server_id', 'Server']]) {
    if (channel[key] && !(key === 'type' && channel.kind)) lines.push(`${label}: ${channel[key]}`);
  }
  await msg.reply(lines.join('\n'));
});

registerCommand('inviteinfo', 'Show details for a server invite')(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  if (!msg.argv?.length) {
    await msg.reply('Usage: /inviteinfo <invite code>');
    return;
  }
  const code = msg.argv[0].split('/').at(-1);
  let invite;
  try {
    invite = (await bot.invites(serverId)).find((item) => item.code === code);
  } catch (error) {
    console.error(`Could not fetch invites for ${serverId}:`, error.message);
    await msg.reply('I couldn’t read invites. The bot may need Manage Server permission.');
    return;
  }
  if (!invite) {
    await msg.reply('I couldn’t find that invite in this server.');
    return;
  }
  await msg.reply(
    `**Invite ${invite.code ?? code}**\nURL: ${invite.url ?? 'Unavailable'}\n` +
    `Uses: ${invite.uses ?? 0}\nInviter ID: ${invite.inviter_id ?? 'Unknown'}`,
  );
});

registerCommand('emojiinfo', 'Explain a Unicode or custom emoji')(async (msg) => {
  if (!msg.argv?.length) {
    await msg.reply('Usage: /emojiinfo <emoji>');
    return;
  }
  const value = msg.argv.join(' ').trim();
  const custom = /^<(a?):([^:]+):(\d+)>$/.exec(value);
  if (custom) {
    await msg.reply(`Custom emoji **${custom[2]}**\nID: \`${custom[3]}\`\nAnimated: ${custom[1] ? 'Yes' : 'No'}`);
    return;
  }
  const codePoints = Array.from(value, (character) => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  await msg.reply(`Emoji: ${value}\nCode points: ${codePoints.join(' ')}`);
});

registerCommand('avatar', 'Show a member’s avatar link')(async (msg) => {
  const userId = msg.argv?.[0] ? cleanId(msg.argv[0]) : msg.author_id;
  if (!userId) {
    await msg.reply('Usage: /avatar [user ID]');
    return;
  }
  let user;
  try {
    user = await bot.user(userId);
  } catch (error) {
    console.error(`Could not fetch avatar for user ${userId}:`, error.message);
    await msg.reply('I couldn’t find that user.');
    return;
  }
  const name = user.display_name ?? user.username ?? userId;
  await msg.reply(`**${name}**\n${user.avatar_url ?? user.avatar ?? 'This user has no public avatar URL.'}`);
});

registerCommand('check', 'Check this server’s stats setup')(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  const tracked = serverStats(serverId);
  let channels;
  try {
    await bot.server(serverId);
    channels = await bot.channels(serverId);
  } catch (error) {
    console.error(`Server check failed for ${serverId}:`, error.message);
    await msg.reply('I couldn’t complete the check. Verify the bot can view the server and channels.');
    return;
  }
  const channelIds = new Set(channels.map((channel) => String(channel.id)));
  const issues = [];
  for (const kind of Object.keys(tracked.counters)) {
    if (!channelIds.has(String(tracked.counters[kind]))) issues.push(`${kind} counter channel is missing`);
  }
  if (tracked.welcome_channel_id && !channelIds.has(String(tracked.welcome_channel_id))) {
    issues.push('welcome channel is missing');
  }
  if (tracked.enabled_stats.includes('staff') && !tracked.staff_role_id) {
    issues.push('staff stats are enabled but no staff role is set; use /staff-role');
  }
  if (!Object.keys(tracked.counters).length) issues.push('stats counters are not set up; run /setup');
  await msg.reply(`**Server check**\n${issues.length ? issues.map((item) => `• ${item}`).join('\n') : 'No configuration problems found.'}`);
});

registerCommand('debug', 'Show non-sensitive diagnostic information')(async (msg) => {
  const serverId = serverIdFor(msg);
  if (!serverId) {
    await msg.reply(`SDK: Yapin JavaScript SDK\nRegistered commands: ${bot.commands.size}`);
    return;
  }
  const tracked = serverStats(serverId);
  await msg.reply(
    `Server ID: \`${serverId}\`\nSDK: Yapin JavaScript SDK\n` +
    `Registered commands: ${bot.commands.size}\nTracked counters: ${Object.keys(tracked.counters).length}\n` +
    `Welcome configured: ${tracked.welcome_channel_id ? 'yes' : 'no'}`,
  );
});

registerCommand('support', 'Get Yapin bot-development support information')(async (msg) => {
  await msg.reply('For Yapin bot development help, visit https://yapin.gg/invite/developers');
});

registerCommand('reset', 'Remove bot configuration and managed counter channels', true)(async (msg) => {
  const serverId = await requireServer(msg);
  if (!serverId) return;
  if (msg.argv?.[0]?.toLowerCase() !== 'confirm') {
    await msg.reply('This deletes the bot’s saved stats and its managed counter channels. Run `/reset confirm` to proceed.');
    return;
  }
  const tracked = serverStats(serverId);
  const errors = [];
  for (const [kind, channelId] of Object.entries(tracked.counters)) {
    try {
      await bot.deleteChannel(channelId);
      delete tracked.counters[kind];
      delete tracked.counter_names[kind];
      saveStats();
    } catch (error) {
      errors.push(`${channelId}: ${error.message}`);
    }
  }
  if (errors.length) {
    for (const error of errors) console.error(`Reset incomplete for server ${serverId}: ${error}`);
    await msg.reply('Reset was incomplete because some channels could not be deleted. Check the bot’s permissions and run /reset confirm again.');
    return;
  }
  delete stats[String(serverId)];
  saveStats();
  await msg.reply('Saved stats and managed counter channels have been reset. Empty categories are left in place.');
});

bot.on('member_join', async (event) => {
  const tracked = serverStats(event.server_id);
  tracked.joins += 1;
  saveStats();
  console.log(`${event.username} joined server ${event.server_id} (member #${event.member_count})`);

  if (tracked.welcome_channel_id) {
    const text = tracked.welcome_template
      .replaceAll('{user}', `<@${event.user_id}>`)
      .replaceAll('{server}', String(event.server_name ?? 'the server'))
      .replaceAll('{member_count}', String(event.member_count ?? ''));
    try {
      await bot.send(tracked.welcome_channel_id, text.slice(0, 2000));
    } catch (error) {
      console.error(`Could not send welcome message for server ${event.server_id}:`, error.message);
    }
  }

  try {
    await refreshCounters(event.server_id);
  } catch (error) {
    console.error(`Could not update counters for server ${event.server_id}:`, error.message);
  }
});

bot.on('member_leave', async (event) => {
  const tracked = serverStats(event.server_id);
  tracked.leaves += 1;
  saveStats();
  console.log(`${event.username} left server ${event.server_id}`);
  try {
    await refreshCounters(event.server_id);
  } catch (error) {
    console.error(`Could not update counters for server ${event.server_id}:`, error.message);
  }
});

bot.on('ready', async (me) => {
  console.log(`Online as ${me.username}`);
  await refreshAllCounters();
  if (!counterTimer) counterTimer = setInterval(() => void refreshAllCounters(), COUNTER_REFRESH_MS);
});

bot.on('error', (error) => {
  console.error('Yapin bot error:', error);
});

try {
  await bot.start();
} catch (error) {
  console.error('Could not start the Yapin bot:', error.message);
  process.exitCode = 1;
} finally {
  if (counterTimer) clearInterval(counterTimer);
}
