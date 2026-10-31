# Yapin Server Stats Bot

A JavaScript bot for Node.js 18+ using Yapin's official no-dependency SDK. It
tracks joins and leaves in `stats.json` and provides stats, member/server
lookups, invite and member listings, configurable welcome messages, member goals,
and optional voice-channel counters.

## Setup

1. In Yapin', open **Settings → Developer**, create a bot, and copy its token.
2. Add the bot to a server you manage.
3. Keep the official [yapper.js SDK](https://www.yapin.gg/sdk/yapper.js) in this
   folder next to `bot.js`.
4. Push this folder to a **public GitHub repository** with `bot.js`,
   `yapper.js`, and `package.json` in the repository root.
5. In Yapin hosting, choose the GitHub tab, enter the repository URL, and save.
   The host runs the root `bot.js` and supplies `YAPPER_BOT_TOKEN` automatically.
   Do not add your token to GitHub or paste it into the source code.

For local development, set `YAPPER_BOT_TOKEN` in your shell and run:

   ```powershell
   $env:YAPPER_BOT_TOKEN = "your-token"
   npm start
   ```

Never commit or share your token. `config.cfg`, `.env` files, and `stats.json`
are ignored by Git. Stats are written to `stats.json` in the bot's working
directory.

## Commands

- `/help [command]`, `/ping`, `/bot`, `/debug`, `/support`
- `/stats`, `/setup`, `/customize`, `/counter list|refresh|add|remove`
- `/enable online|members|staff|bots|boosts`
- `/disable online|members|staff|bots|boosts|all`
- `/staff-role <role name or role mention>`
- `/category list|create|use`, `/welcome show|set|disable`, `/goal set|clear`
- `/serverinfo`, `/userinfo`, `/roleinfo`, `/channelinfo`, `/invite`, `/inviteinfo`
- `/members`, `/data`, `/emojiinfo`, `/avatar`, `/check`, `/reset`
- `/command list|restrict|allow`

Server configuration changes (`/setup`, `/customize`, `/counter`, `/category`,
`/welcome`, `/goal`, `/enable`, `/disable`, `/staff-role`, `/command`, `/data`,
and `/reset`) are restricted to the server owner. Online and
member totals are enabled by default. `/setup` creates their voice-channel counters. `/enable staff`,
`/enable bots`, or `/enable boosts` enables the stat **and creates or updates
its voice-channel counter**. `/setup` names the channels with the matching
emoji labels: `🟢 Online: N`, `👥 Members: N`, `💼 Total Staff: N`,
`🤖 Total Bots: N`, and `⚡ Total Boosts: N`. Existing member and online
counters in the `Server Stats` category are reused and renamed. `/stats` shows
the matching emoji summary. `/staff-role` accepts an exact role name or role
mention. `/disable <type>` disables a stat and deletes its counter channel;
`/disable all` removes all stat counters. `/reset confirm` deletes only counter
channels created and tracked by this bot; it leaves categories in place in case
they contain other channels.


The staff total counts members assigned the configured staff role. Bot totals
are based on bot flags in the member data. If Yapin does not return bot
identification metadata, the bot count displays as unavailable instead of
incorrectly reporting zero. Boost totals are shown when Yapin returns a
boost-count field; otherwise they display as unavailable.

The local bot does not include ServerStats' hosted voting, premium, donation, or
partner features, or external game/social integrations. `/ping` measures a Yapin
API request; the SDK does not expose gateway/shard latency. Member and online
counter channels update on join/leave events and periodically while the bot is
running.
