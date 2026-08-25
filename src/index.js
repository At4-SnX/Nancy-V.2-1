import 'dotenv/config';
import { AttachmentBuilder, AuditLogEvent, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const prefix = process.env.PREFIX || '&';
const UI = {
  white: 0xFFFFFF,
  arrow: '<:Nancy23Photoroom:1541568232756879370>',
  logo: '<:Nancy26Photoroom:1541568067836973096>',
  notice: '<:Nancy__25_removebgpreview:1541568070168875010>',
  settings: '<:Nancy24Photoroom:1541568231570014299>',
  bell: '<:Nancy38Photoroom:1541568051579850882>'
};
const settingsPath = path.resolve('data/settings.json');
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
const levelsDb = new DatabaseSync(path.resolve('data/levels.sqlite'));
levelsDb.exec(`
  CREATE TABLE IF NOT EXISTS member_levels (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  )
  ;CREATE TABLE IF NOT EXISTS shop_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  )
  ;CREATE TABLE IF NOT EXISTS server_metrics (
    guild_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, metric_date, metric_name)
  )
`);
const levelColumns = levelsDb.prepare('PRAGMA table_info(member_levels)').all().map(column => column.name);
if (!levelColumns.includes('ncoins')) levelsDb.exec('ALTER TABLE member_levels ADD COLUMN ncoins INTEGER NOT NULL DEFAULT 0');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* first boot */ }
const save = () => fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
const config = guildId => {
  const guildConfig = settings[guildId] ??= { antibot: false, antinuke: { enabled: false, threshold: 3, action: 'strip' } };
  guildConfig.levels ??= { roles: {}, channelId: null };
  guildConfig.levels.roles ??= {}; guildConfig.levels.channelId ??= null;
  guildConfig.antispam ??= { enabled: true, limit: 6, interval: 7, timeout: '10m' };
  return guildConfig;
};
function levelRecord(guildId, userId) {
  return levelsDb.prepare('SELECT xp, last_message_at, ncoins FROM member_levels WHERE guild_id = ? AND user_id = ?').get(guildId, userId) ?? { xp: 0, last_message_at: 0, ncoins: 0 };
}
function saveLevelRecord(guildId, userId, xp, lastMessageAt, ncoins = levelRecord(guildId, userId).ncoins) {
  levelsDb.prepare(`INSERT INTO member_levels (guild_id, user_id, xp, last_message_at, ncoins) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = excluded.xp, last_message_at = excluded.last_message_at, ncoins = excluded.ncoins`).run(guildId, userId, xp, lastMessageAt, ncoins);
}
function leaderboardRecords(guildId) {
  return levelsDb.prepare('SELECT user_id, xp FROM member_levels WHERE guild_id = ? ORDER BY xp DESC LIMIT 10').all(guildId);
}
function adjustCoins(guildId, userId, amount) {
  const user = levelRecord(guildId, userId);
  saveLevelRecord(guildId, userId, user.xp, user.last_message_at, Math.max(0, user.ncoins + amount));
  return Math.max(0, user.ncoins + amount);
}
function dayKey(offset = 0) { const day = new Date(Date.now() - offset * 86_400_000); return day.toISOString().slice(0, 10); }
function incrementMetric(guildId, metricName, amount = 1) {
  levelsDb.prepare(`INSERT INTO server_metrics (guild_id, metric_date, metric_name, metric_value) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, metric_date, metric_name) DO UPDATE SET metric_value = metric_value + excluded.metric_value`).run(guildId, dayKey(), metricName, amount);
}
function weeklyMetric(guildId, metricName) {
  const read = levelsDb.prepare('SELECT metric_date, metric_value FROM server_metrics WHERE guild_id = ? AND metric_name = ? AND metric_date >= ?').all(guildId, metricName, dayKey(6));
  const values = new Map(read.map(item => [item.metric_date, item.metric_value]));
  return Array.from({ length: 7 }, (_, index) => ({ date: dayKey(6 - index), value: values.get(dayKey(6 - index)) ?? 0 }));
}
function shopItems(guildId) { return levelsDb.prepare('SELECT role_id, price FROM shop_roles WHERE guild_id = ? ORDER BY price ASC').all(guildId); }
function bar(value, maximum) { return value > 0 ? '▰'.repeat(Math.max(1, Math.round((value / Math.max(1, maximum)) * 10))) : '—'; }
function migrateLegacyLevels() {
  for (const [guildId, guildConfig] of Object.entries(settings)) {
    for (const [userId, record] of Object.entries(guildConfig.levels?.users ?? {})) {
      levelsDb.prepare('INSERT OR IGNORE INTO member_levels (guild_id, user_id, xp, last_message_at) VALUES (?, ?, ?, ?)').run(guildId, userId, record.xp ?? 0, record.lastMessageAt ?? 0);
    }
    if (guildConfig.levels?.users) delete guildConfig.levels.users;
  }
  save();
}
migrateLegacyLevels();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildVoiceStates],
  allowedMentions: { parse: [], repliedUser: false }
});
const dangerPerms = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ModerateMembers;
const staffCommands = new Set(['ping', 'help', 'rank', 'leaderboard', 'coins', 'shop', 'stats', 'statistique', 'kick', 'mute', 'unmute', 'clear', 'lock', 'unlock', 'slowmode', 'ticketclose']);
const levelMilestones = [1, 10, 20, 30, 40, 50, 60, 70];
const maxLevel = 70;
const xpForLevel = level => level * level * 100;
const levelFromXp = xp => Math.min(maxLevel, Math.floor(Math.sqrt(xp / 100)));
const voiceSessions = new Map();
const spamMessages = new Map();
const ticketTypes = {
  fondation: 'Ticket Fondation', legal: 'Ticket Légal', illegal: 'Ticket Illégal', report_staff: 'Ticket report Staff',
  report_joueur: 'Ticket Report Joueur', question: 'Ticket Question', unban: 'Ticket Unban', build: 'Ticket Build'
};
const ticketCategoryVariables = {
  fondation: 'TICKET_CATEGORY_FONDATION_ID', legal: 'TICKET_CATEGORY_LEGAL_ID', illegal: 'TICKET_CATEGORY_ILLEGAL_ID', report_staff: 'TICKET_CATEGORY_REPORT_STAFF_ID',
  report_joueur: 'TICKET_CATEGORY_REPORT_JOUEUR_ID', question: 'TICKET_CATEGORY_QUESTION_ID', unban: 'TICKET_CATEGORY_UNBAN_ID', build: 'TICKET_CATEGORY_BUILD_ID'
};

function duration(input) {
  const match = /^(\d+)\s*([mhd])$/i.exec(input || '');
  if (!match) return null;
  const value = Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase()]);
  return value > 0 && value <= 2_419_200_000 ? value : null;
}
function targetId(value) { return value?.replace(/[<#@!>&]/g, ''); }
function roleName(value) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function isStaffMember(member) { return member.roles.cache.some(role => roleName(role.name) === 'equipe staff'); }
function has(member, command) {
  if (['help', 'rank', 'leaderboard', 'coins', 'shop', 'stats', 'statistique'].includes(command)) return true;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const names = member.roles.cache.map(role => roleName(role.name));
  if (names.includes('administrateur')) return true;
  return isStaffMember(member) && staffCommands.has(command);
}
function ticketConfig(guildId) {
  const tickets = config(guildId).tickets ??= { roles: {}, categoryId: null, open: {} };
  tickets.roles ??= {}; tickets.open ??= {}; tickets.categoryId ??= null;
  return tickets;
}
function lockConfig(guildId) {
  const locks = config(guildId).locks ??= {};
  return locks;
}
function ticketCategoryId(tickets, type) {
  return process.env[ticketCategoryVariables[type]]?.trim() || process.env.TICKET_CATEGORY_ID?.trim() || tickets.categoryId;
}
async function log(guild, text) { const channel = process.env.LOG_CHANNEL_ID && guild.channels.cache.get(process.env.LOG_CHANNEL_ID); if (channel?.isTextBased()) await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(text).setTimestamp()] }).catch(() => {}); }
function compact(text) { return `\`${String(text).replace(/`/g, '´').replace(/\s+/g, ' ').trim()}\``; }
async function reply(ctx, text, ephemeral = false) { const content = compact(text); return ctx.reply({ content, ephemeral }).catch(() => ctx.channel?.send({ content })); }
async function v2Reply(ctx, components, ephemeral = false) {
  const payload = { flags: 32_768 | (ephemeral && ctx.isChatInputCommand?.() ? 64 : 0), components };
  return ctx.reply(payload).catch(() => ctx.channel?.send({ flags: 32_768, components }));
}
function progressBar(value) { const filled = Math.max(0, Math.min(10, Math.round(value * 10))); return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`; }
function helpComponents() { return [{ type: 17, accent_color: UI.white, components: [
  { type: 10, content: `## ${UI.logo} Nancy RP V.2 • Centre de commandes` },
  { type: 10, content: `${UI.arrow} **__Bienvenue dans le centre de gestion__**. Retrouvez ci-dessous les fonctionnalités mises à disposition afin d’assurer une expérience claire, sécurisée et agréable sur Nancy RP V.2.\n\n> Toutes les commandes sont également disponibles avec le préfixe \`${prefix}\`.` },
  { type: 14, divider: true, spacing: 1 },
  { type: 14, divider: true, spacing: 1 },
  { type: 10, content: `### <:Nancy24Photoroom:1541568231570014299> Modération\n\`> ${prefix}kick <membre> [raison]\` · \`${prefix}ban <membre> [raison]\` · \`${prefix}mute <membre> <durée> [raison]\`\n\`${prefix}unmute <membre>\` · \`${prefix}clear <1-100>\` · \`${prefix}lock\` · \`${prefix}unlock\` · \`${prefix}slowmode <secondes>\`\nAntispam configurable : \`${prefix}antispam on [messages] [secondes] [timeout]\`.` },
  { type: 10, content: `### <:Nancy23Photoroom:1541568232756879370> Progression & Nancy Coins\n\`${prefix}rank [membre]\` affiche une progression détaillée. \`${prefix}leaderboard\` affiche le **__top 10__** actualisé en direct.\nMessages : **__8 à 25 XP__** et **__1 à 10 N-Coins__** toutes les 20 secondes. Vocal : **__4 XP et 1 N-Coin__** toutes les 15 secondes.` },
  { type: 10, content: `### ${UI.logo} Boutique & statistiques\n\`${prefix}coins\` consulte votre portefeuille. \`${prefix}shop\` présente les rôles disponibles et \`${prefix}buy <rôle>\` confirme un achat.\n\`${prefix}stats\` affiche les graphiques d’activité du serveur.` },
  { type: 10, content: `### <:Nancy38Photoroom:1541568051579850882> Tickets\n Utilise le panneau dédié pour **__créer un ticket__**. Un staff peut **__fermer un ticket__** avec \`${prefix}ticketclose\`.` },
  { type: 10, content: `### ${UI.notice} Accès aux fonctionnalités\n> Les réglages sensibles sont réservés aux administrateurs. L’équipe staff dispose des outils de modération courants. Les commandes de consultation restent accessibles à tous.` },
  { type: 10, content: '-# Nancy RP V.2 • Utilisez chaque outil avec discernement et conformément au règlement du serveur.' }
] }]; }

async function applyLevelRoles(member, level) {
  const roles = config(member.guild.id).levels.roles;
  for (const milestone of levelMilestones.filter(value => value <= level)) {
    const roleId = roles[milestone]; if (!roleId || member.roles.cache.has(roleId)) continue;
    const role = await member.guild.roles.fetch(roleId).catch(() => null);
    if (role?.editable) await member.roles.add(role, `Récompense niveau ${milestone}`).catch(() => {});
  }
}
async function addXp(member, amount, coins = 0) {
  if (amount <= 0) return;
  const user = levelRecord(member.guild.id, member.id);
  const oldLevel = levelFromXp(user.xp);
  const xp = Math.min(xpForLevel(maxLevel), user.xp + amount);
  const newLevel = levelFromXp(xp);
  saveLevelRecord(member.guild.id, member.id, xp, user.last_message_at, user.ncoins + coins);
  if (newLevel > oldLevel) {
    await applyLevelRoles(member, newLevel);
    const levelChannelId = config(member.guild.id).levels.channelId;
    if (!levelChannelId) return;
    const levelChannel = await member.guild.channels.fetch(levelChannelId).catch(() => null);
    if (levelChannel?.isTextBased()) {
      await levelChannel.send({
        flags: 32_768,
        components: [{
          type: 17,
          accent_color: UI.white,
          components: [
            { type: 10, content: `## ${UI.logo} Progression • Nouveau niveau atteint` },
            { type: 10, content: `${UI.arrow} Félicitations ${member} ! Votre activité vous permet d’atteindre le **__niveau ${newLevel}__**.\n\n> Poursuivez votre participation afin de débloquer les prochaines récompenses et de progresser au sein de la communauté.` },
            { type: 12, items: [{ media: { url: 'attachment://A.gif' } }] },
            { type: 10, content: `-# Nancy RP V.2 • Niveau ${newLevel} / ${maxLevel}` }
          ]
        }],
        files: [new AttachmentBuilder('assets/A.gif', { name: 'A.gif' })]
      }).catch(() => {});
    }
  }
}
async function creditVoice(member, now = Date.now()) {
  const key = `${member.guild.id}:${member.id}`; const session = voiceSessions.get(key); if (!session) return;
  const periods = Math.floor((now - session.creditedAt) / 15_000); if (periods < 1) return;
  session.creditedAt += periods * 15_000;
  await addXp(member, periods * 4, periods);
  incrementMetric(member.guild.id, 'voice_seconds', periods * 15);
}
async function enforceAntiSpam(message) {
  const anti = config(message.guild.id).antispam;
  if (!anti.enabled || has(message.member, 'antibot')) return false;
  const key = `${message.guild.id}:${message.author.id}`; const now = Date.now();
  const recent = (spamMessages.get(key) ?? []).filter(time => now - time < anti.interval * 1_000);
  recent.push(now); spamMessages.set(key, recent);
  if (recent.length < anti.limit) return false;
  spamMessages.set(key, []);
  await message.delete().catch(() => {});
  const timeoutMs = duration(anti.timeout) ?? 600_000;
  if (message.member.moderatable) await message.member.timeout(timeoutMs, `Antispam : ${anti.limit} messages en ${anti.interval} secondes`).catch(() => {});
  await log(message.guild, `**ANTISPAM** — ${message.author.tag} sanctionné après ${anti.limit} messages en ${anti.interval} secondes.`);
  const warning = await message.channel.send({ content: compact(`${message.author.tag} : antispam détecté, timeout de ${anti.timeout} appliqué.`) }).catch(() => null);
  if (warning) setTimeout(() => warning.delete().catch(() => {}), 12_000);
  return true;
}
async function enforceAntiLink(message) {
  const links = message.content.match(/discord\.gg\/\S+/gi) ?? [];
  const forbidden = links.some(link => !link.toLowerCase().includes('tenor'));
  if (!forbidden) return false;
  await message.delete().catch(() => {});
  await log(message.guild, `**ANTILIEN** — Message de ${message.author.tag} supprimé : lien non autorisé.`);
  const warning = await message.channel.send({ content: compact(`${message.author.tag} : invitation discord.gg supprimée automatiquement.`) }).catch(() => null);
  if (warning) setTimeout(() => warning.delete().catch(() => {}), 12_000);
  return true;
}
const ticketIntroduction = [
  '<:Nancy23Photoroom:1541568232756879370> **__Bienvenue au centre de support__** ! Afin que votre dossier soit **__orienté vers l’équipe compétente dans les plus brefs délais__**, veuillez sélectionner avec attention la **__catégorie correspondant à votre demande__** parmi la liste ci-dessous :',
  '> <:Nancy43Photoroom:1541572050827870349> **__Ticket Fondations__** : `Pour toute demande relative à la création, la gestion ou la validation d’une fondation (projet, entreprise ou organisation).`',
  '> <:Nancy44Photoroom:1541572049950998638> **__Ticket Légal__** : `Destiné aux démarches, litiges ou questions concernant les activités légales (business, contrats, régulations).`',
  '> <:Nancy45Photoroom:1541572048759947354> **__Ticket Illégal__** : `Réservé aux demandes, signalements ou interactions en lien avec les activités illégales ou le milieu criminel/gang.`',
  '> <:Nancy46Photoroom:1541572047564439593> **__Ticket Report Staff__** : `Pour signaler un comportement inapproprié, un abus de pouvoir ou un problème concernant un membre de l’équipe de modération/administration.`',
  '> <:Nancy46Photoroom:1541572047564439593> **__Ticket Report Joueur__** : `Pour effectuer un signalement à l’encontre d’un joueur (règlement brisé, anti-jeu, non-respect du RP, etc., preuves à l’appui).`',
  '> <:Nancy47Photoroom:1541572046537105529> **__Ticket Question__** : `Si vous avez une interrogation générale sur le fonctionnement du serveur, le règlement ou besoin d’un renseignement.`',
  '> <:Nancy48Photoroom:1541572045467418766> **__Ticket Unban__** : `Pour contester une sanction et effectuer une demande de débannissement auprès de la modération.`',
  '> <:Nancy49Photoroom:1541572044397748304> **__Ticket Build__** : `Pour toute demande concernant la construction, les bugs de mapping ou l’ajout/modification de structures.`'
].join('\n\n');

function ticketPanel() {
  return {
    flags: 32_768,
    components: [{ type: 17, accent_color: UI.white, components: [
      { type: 10, content: `## ${UI.logo} Centre de support • Nancy RP V.2` },
      { type: 10, content: ticketIntroduction },
      { type: 12, items: [{ media: { url: 'attachment://ticket.gif' } }] },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: `### ${UI.notice} Informations importantes\n> ${UI.arrow} Votre demande ouvrira un **__salon privé__**. Décrivez votre situation avec **__précision__** et joignez, si nécessaire, les **__éléments utiles à son traitement__**.\n\n> **__Une équipe dédiée prendra votre dossier en charge dans les meilleurs délais.__**` },
      { type: 1, components: [{ type: 3, custom_id: 'ticket:create', placeholder: 'Choisir une catégorie de ticket', options: Object.entries(ticketTypes).map(([value, label]) => ({ label, value })) }] }
    ] }],
    files: [new AttachmentBuilder('assets/ticket.gif', { name: 'ticket.gif' })]
  };
}
async function createTicket(guild, owner, type, reportedStaff = []) {
  const tickets = ticketConfig(guild.id);
  const alreadyOpen = Object.values(tickets.open).some(ticket => ticket.ownerId === owner.id && ticket.type === type);
  if (alreadyOpen) return { error: `Tu as déjà un **${ticketTypes[type]}** ouvert.` };
  const alertRoleId = tickets.roles[type];
  if (!alertRoleId) return { error: `Le rôle d’alerte du **${ticketTypes[type]}** n’est pas encore configuré.` };
  if (alertRoleId === guild.roles.everyone.id) return { error: 'Le rôle d’alerte ne peut pas être everyone. Configurez un rôle dédié pour ce type de ticket.' };
  const categoryId = ticketCategoryId(tickets, type);
  if (!categoryId) return { error: 'La catégorie des tickets n’est pas encore configurée dans les variables Railway.' };
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: owner.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  if (alertRoleId) overwrites.push({ id: alertRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  const safeName = owner.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 30) || owner.id;
  const channel = await guild.channels.create({ name: `ticket-${type.replace('_', '-')}-${safeName}`, type: ChannelType.GuildText, parent: categoryId, permissionOverwrites: overwrites, reason: `${ticketTypes[type]} créé par ${owner.user.tag}` });
  tickets.open[channel.id] = { ownerId: owner.id, type, reportedStaff, createdAt: Date.now() }; save();
  const alertRole = await guild.roles.fetch(alertRoleId).catch(() => null);
  await channel.send({
    content: `<@&${alertRoleId}> • Nouveau dossier **${ticketTypes[type]}** à prendre en charge.`,
    allowedMentions: { parse: [], roles: [alertRoleId], users: [] }
  }).catch(() => {});
  const reportedText = reportedStaff.length ? `\n\n**Membre(s) du staff signalé(s) :** ${reportedStaff.map(id => `<@${id}>`).join(', ')}` : '';
  await channel.send({
    flags: 32_768,
    components: [{ type: 17, accent_color: UI.white, components: [
      { type: 10, content: `## ${UI.logo} ${ticketTypes[type]}` },
      { type: 10, content: `${UI.arrow} Bienvenue ${owner}. Votre dossier a été créé avec succès.\n\n> Présentez votre demande de manière **__précise, claire et structurée__**. L’équipe **${alertRole?.name ?? 'concernée'}** a été notifiée et prendra votre dossier en charge.${reportedText}` },
      { type: 14, divider: true, spacing: 1 },
      { type: 1, components: [{ type: 2, style: 4, custom_id: 'ticket:close', label: 'Fermer le ticket' }] }
    ] }]
  });
  return { channel };
}
async function closeTicket(interaction) {
  const guild = interaction.guild; const ticket = guild && ticketConfig(guild.id).open[interaction.channelId];
  if (!ticket) return interaction.reply({ content: 'Ce salon n’est pas un ticket géré par le bot.', ephemeral: true });
  if (interaction.user.id !== ticket.ownerId && !has(interaction.member, 'ticketclose')) return interaction.reply({ content: 'Seul le créateur du ticket ou un membre du staff peut le fermer.', ephemeral: true });
  delete ticketConfig(guild.id).open[interaction.channelId]; save();
  await interaction.reply({ content: '🔒 Ticket fermé. Suppression du salon dans 5 secondes.' });
  setTimeout(() => interaction.channel?.delete('Ticket fermé').catch(() => {}), 5_000);
}

async function execute(ctx, command, args, slash = false) {
  const guild = ctx.guild; if (!guild) return reply(ctx, 'Cette commande doit être utilisée sur un serveur.', true);
  const member = ctx.member;
  const actor = ctx.user ?? ctx.author;
  if (!has(member, command)) return reply(ctx, 'Vous n’avez pas la permission nécessaire.', true);
  const reason = slash ? ctx.options.getString('raison') : args.slice(command === 'mute' ? 2 : 1).join(' ');
  const getMember = async value => guild.members.fetch(targetId(value)).catch(() => null);
  if (command === 'ping') return reply(ctx, `Bot opérationnel — latence : ${client.ws.ping} ms.`, true);
  if (command === 'help') return v2Reply(ctx, helpComponents(), true);
  if (command === 'rank') {
    const target = slash ? (ctx.options.getMember('membre') ?? member) : (args[0] ? await getMember(args[0]) : member);
    if (!target) return reply(ctx, 'Membre introuvable.', true);
    const xp = levelRecord(guild.id, target.id).xp;
    const level = levelFromXp(xp); const currentFloor = xpForLevel(level); const next = level >= maxLevel ? null : xpForLevel(level + 1);
    const ratio = next ? (xp - currentFloor) / (next - currentFloor) : 1;
    return v2Reply(ctx, [{ type: 17, accent_color: UI.white, components: [
      { type: 10, content: `## ${UI.logo} Profil de progression` },
      { type: 10, content: `${UI.arrow} Profil de ${target}\n\n### Niveau **${level} / ${maxLevel}**\n\`${progressBar(ratio)}\` **${Math.floor(ratio * 100)} %**` },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: next ? `**${xp.toLocaleString('fr-FR')} XP** accumulée • encore **${(next - xp).toLocaleString('fr-FR')} XP** avant le niveau **${level + 1}**.\n\n-# Activité message et présence en vocal contribuent toutes deux à ta progression.` : `**${xp.toLocaleString('fr-FR')} XP** accumulée • tu as atteint le **niveau maximum**.\n\n-# Félicitations : ton parcours est complété.` }
    ] }], true);
  }
  if (command === 'leaderboard') {
    const users = leaderboardRecords(guild.id);
    if (!users.length) return v2Reply(ctx, [{ type: 17, accent_color: UI.white, components: [{ type: 10, content: `## ${UI.logo} Classement • Nancy RP V.2` }, { type: 10, content: `${UI.arrow} Aucun point d’expérience n’a encore été enregistré.\n\n> Participez aux échanges écrits et vocaux pour lancer votre progression.` }] }], true);
    const lines = await Promise.all(users.map(async (data, index) => {
      const ranked = await guild.members.fetch(data.user_id).catch(() => null);
      const medal = ['🥇', '🥈', '🥉'][index] ?? `**${index + 1}.**`;
      return `${medal} **${ranked?.user.tag ?? `Utilisateur ${data.user_id}`}**\n> Niveau **${levelFromXp(data.xp)}** • **${data.xp.toLocaleString('fr-FR')} XP**`;
    }));
    return v2Reply(ctx, [{ type: 17, accent_color: UI.white, components: [
      { type: 10, content: `## ${UI.logo} Classement officiel • Nancy RP V.2` },
      { type: 10, content: `${UI.arrow} Voici les **__citoyens les plus actifs__**. Ce classement est calculé à partir des **__données XP__** au moment de la commande.` },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: lines.join('\n\n') },
      { type: 10, content: '-# Continue à écrire et à participer en vocal pour progresser dans le classement.' }
    ] }], true);
  }
  if (command === 'coins') {
    const target = slash ? (ctx.options.getMember('membre') ?? member) : (args[0] ? await getMember(args[0]) : member);
    if (!target) return reply(ctx, 'Membre introuvable.', true);
    const coins = levelRecord(guild.id, target.id).ncoins;
    return v2Reply(ctx, [{ type: 17, accent_color: UI.white, components: [
      { type: 10, content: `## ${UI.logo} Portefeuille • Nancy Coins` },
      { type: 10, content: `${UI.arrow} ${target} possède actuellement **__${coins.toLocaleString('fr-FR')} N-Coin${coins === 1 ? '' : 's'}__**.\n\n> Gagnez entre **1 et 10 N-Coins** grâce à vos messages, selon leur longueur, et **1 N-Coin toutes les 15 secondes** en salon vocal.` },
      { type: 10, content: `-# Utilisez \`${prefix}shop\` pour consulter les rôles disponibles.` }
    ] }], true);
  }
  if (command === 'shop') {
    const items = shopItems(guild.id);
    if (!items.length) return v2Reply(ctx, [{ type: 17, accent_color: UI.white, components: [{ type: 10, content: `## ${UI.logo} Boutique • Nancy Coins` }, { type: 10, content: `${UI.arrow} La boutique ne contient pas encore de rôle.\n\n> Un administrateur peut ajouter un rôle avec \`${prefix}shoprole <rôle> <prix>\`.` }] }], true);
    const lines = await Promise.all(items.map(async item => {
      const role = await guild.roles.fetch(item.role_id).catch(() => null);
      return role ? `${UI.arrow} ${role} — **__${item.price.toLocaleString('fr-FR')} N-Coins__**` : null;
    }));
    return v2Reply(ctx, [{ type: 17, accent_color: UI.white, components: [
      { type: 10, content: `## ${UI.logo} Boutique officielle • Nancy Coins` },
      { type: 10, content: `${UI.arrow} Découvrez les rôles disponibles à l’achat. Chaque rôle est définitivement attribué après validation de votre paiement.` },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: lines.filter(Boolean).join('\n') || 'Aucun rôle disponible.' },
      { type: 10, content: `-# Pour acheter : \`${prefix}buy <rôle>\` • Consultez votre solde avec \`${prefix}coins\`.` }
    ] }], true);
  }
  if (command === 'buy') {
    const roleId = slash ? ctx.options.getRole('role')?.id : targetId(args[0]);
    const item = shopItems(guild.id).find(entry => entry.role_id === roleId);
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!item || !role) return reply(ctx, 'Ce rôle n’est pas disponible dans la boutique.', true);
    if (member.roles.cache.has(role.id)) return reply(ctx, 'Vous possédez déjà ce rôle.', true);
    if (!role.editable) return reply(ctx, 'Je ne peux pas attribuer ce rôle. Placez mon rôle au-dessus de celui-ci.', true);
    const wallet = levelRecord(guild.id, member.id);
    if (wallet.ncoins < item.price) return reply(ctx, `Solde insuffisant : ${item.price - wallet.ncoins} N-Coins manquants.`, true);
    adjustCoins(guild.id, member.id, -item.price);
    try { await member.roles.add(role, `Achat boutique par ${actor.tag}`); }
    catch { adjustCoins(guild.id, member.id, item.price); return reply(ctx, 'L’achat n’a pas pu être finalisé. Vos N-Coins ont été remboursés.', true); }
    return reply(ctx, `Achat validé : rôle ${role.name} obtenu pour ${item.price} N-Coins.`);
  }
  if (command === 'shoprole') {
    const roleId = slash ? ctx.options.getRole('role')?.id : targetId(args[0]);
    const price = Number(slash ? ctx.options.getInteger('prix') : args[1]);
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.managed || !role.editable || !Number.isInteger(price) || price < 1) return reply(ctx, 'Indiquez un rôle attribuable et un prix supérieur à 0.', true);
    levelsDb.prepare(`INSERT INTO shop_roles (guild_id, role_id, price) VALUES (?, ?, ?) ON CONFLICT(guild_id, role_id) DO UPDATE SET price = excluded.price`).run(guild.id, role.id, price);
    return reply(ctx, `Boutique mise à jour : ${role.name} coûte désormais ${price} N-Coins.`);
  }
  if (command === 'stats' || command === 'statistique') {
    const joins = weeklyMetric(guild.id, 'joins'); const messages = weeklyMetric(guild.id, 'messages'); const voice = weeklyMetric(guild.id, 'voice_seconds');
    const chart = (records, suffix = '') => records.map(record => `${record.date.slice(5).replace('-', '/')}  ${bar(record.value, Math.max(...records.map(row => row.value)))}  **${record.value}${suffix}**`).join('\n');
    const joinTotal = joins.reduce((total, record) => total + record.value, 0); const messageTotal = messages.reduce((total, record) => total + record.value, 0); const voiceMinutes = Math.round(voice.reduce((total, record) => total + record.value, 0) / 60);
    return v2Reply(ctx, [{ type: 17, accent_color: UI.white, components: [
      { type: 10, content: `## ${UI.logo} Statistiques • Nancy RP V.2` },
      { type: 10, content: `${UI.arrow} Synthèse des **__sept derniers jours__** • ${guild.memberCount.toLocaleString('fr-FR')} membres actuels.` },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: `### ${UI.bell} Arrivées • moyenne ${Math.round((joinTotal / 7) * 10) / 10}/jour\n${chart(joins)}` },
      { type: 10, content: `### ${UI.settings} Messages • ${messageTotal.toLocaleString('fr-FR')} au total\n${chart(messages)}` },
      { type: 10, content: `### ${UI.notice} Activité vocale • ${voiceMinutes.toLocaleString('fr-FR')} minutes\n${chart(voice.map(record => ({ ...record, value: Math.round(record.value / 60) })), ' min')}` },
      { type: 10, content: '-# Les données sont collectées depuis l’activation de cette version du bot.' }
    ] }], true);
  }
  if (command === 'levelroles') {
    const roles = config(guild.id).levels.roles;
    const list = levelMilestones.map(level => `Niveau **${level}** : ${roles[level] ? `<@&${roles[level]}>` : 'non configuré'}`).join('\n');
    return reply(ctx, `🎁 **Rôles de niveau**\n${list}`, true);
  }
  if (command === 'levelchannel') {
    const channelId = slash ? ctx.options.getChannel('salon')?.id : targetId(args[0]);
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return reply(ctx, 'Indiquez un salon textuel valide.', true);
    config(guild.id).levels.channelId = channel.id; save();
    return reply(ctx, `Les annonces de niveau seront envoyées dans ${channel}.`);
  }
  if (command === 'ticketrole') {
    const type = (slash ? ctx.options.getString('type') : args[0])?.toLowerCase();
    const roleId = slash ? ctx.options.getRole('role')?.id : targetId(args[1]);
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!ticketTypes[type] || !role || role.managed || role.id === guild.roles.everyone.id) return reply(ctx, 'Choisissez un rôle dédié valide ; le rôle @everyone ne peut pas être utilisé pour les tickets.', true);
    ticketConfig(guild.id).roles[type] = role.id; save();
    return reply(ctx, `Le rôle ${role} disposera de l’accès et recevra une notification pour les dossiers de type **${ticketTypes[type]}**.`);
  }
  if (command === 'ticketcategory') {
    const categoryId = slash ? ctx.options.getChannel('categorie')?.id : targetId(args[0]);
    const category = await guild.channels.fetch(categoryId).catch(() => null);
    if (!category || category.type !== 4) return reply(ctx, 'Indiquez une catégorie Discord valide.', true);
    ticketConfig(guild.id).categoryId = category.id; save();
    return reply(ctx, `Les tickets seront créés dans la catégorie **${category.name}**.`);
  }
  if (command === 'ticketpanel') {
    if (!ctx.channel?.send) return reply(ctx, 'Salon non compatible.', true);
    await ctx.channel.send(ticketPanel());
    return reply(ctx, 'Panneau de tickets publié.', true);
  }
  if (command === 'ticketclose') {
    const tickets = ticketConfig(guild.id); if (!tickets.open[ctx.channel.id]) return reply(ctx, 'Ce salon n’est pas un ticket géré par le bot.', true);
    delete tickets.open[ctx.channel.id]; save(); await reply(ctx, '🔒 Ticket fermé. Suppression du salon dans 5 secondes.');
    return setTimeout(() => ctx.channel?.delete('Ticket fermé').catch(() => {}), 5_000);
  }
  if (command === 'levelrole') {
    const level = Number(slash ? ctx.options.getInteger('niveau') : args[0]);
    const roleId = slash ? ctx.options.getRole('role')?.id : targetId(args[1]);
    if (!levelMilestones.includes(level) || !roleId) return reply(ctx, 'Usage : levelrole <1|10|20|30|40|50|60|70> <rôle>', true);
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.managed || !role.editable) return reply(ctx, 'Ce rôle est introuvable ou je ne peux pas l’attribuer.', true);
    config(guild.id).levels.roles[level] = role.id; save();
    for (const cachedMember of guild.members.cache.values()) {
      const xp = levelRecord(guild.id, cachedMember.id).xp;
      if (!cachedMember.user.bot && levelFromXp(xp) >= level) await applyLevelRoles(cachedMember, level);
    }
    return reply(ctx, `Le rôle ${role} sera attribué au **niveau ${level}**.`);
  }
  if (command === 'kick' || command === 'ban') {
    const textTarget = slash ? null : await getMember(args[0]);
    const user = slash ? ctx.options.getUser('membre') : textTarget?.user;
    if (!user) return reply(ctx, 'Membre introuvable.', true);
    const target = await guild.members.fetch(user.id).catch(() => null);
    if (target && (!target.moderatable || target.roles.highest.comparePositionTo(member.roles.highest) >= 0)) return reply(ctx, 'Je ne peux pas agir sur ce membre.', true);
    await (command === 'kick' ? target.kick(reason || 'Aucune raison fournie') : guild.members.ban(user.id, { reason: reason || 'Aucune raison fournie' }));
    await log(guild, `**${command.toUpperCase()}** — ${user.tag} par ${actor.tag} : ${reason || 'Aucune raison'}`);
    return reply(ctx, `${user.tag} a été ${command === 'kick' ? 'expulsé' : 'banni'}.`);
  }
  if (command === 'mute') {
    const value = slash ? ctx.options.getString('duree') : args[1]; const ms = duration(value); const target = await getMember(slash ? ctx.options.getUser('membre').id : args[0]);
    if (!target || !ms) return reply(ctx, 'Usage : mute <membre> <10m|2h|1d> [raison]. Durée maximale : 28 jours.', true);
    if (!target.moderatable || target.roles.highest.comparePositionTo(member.roles.highest) >= 0) return reply(ctx, 'Je ne peux pas timeout ce membre.', true);
    await target.timeout(ms, reason || 'Aucune raison fournie'); await log(guild, `**MUTE** — ${target.user.tag} par ${actor.tag}, ${value} : ${reason || 'Aucune raison'}`); return reply(ctx, `${target.user.tag} est mute pour ${value}.`);
  }
  if (command === 'unmute') { const target = await getMember(slash ? ctx.options.getUser('membre').id : args[0]); if (!target?.moderatable) return reply(ctx, 'Membre introuvable ou non modérable.', true); await target.timeout(null); return reply(ctx, `${target.user.tag} n’est plus mute.`); }
  if (command === 'clear') { const amount = Number(slash ? ctx.options.getInteger('quantite') : args[0] || 0); if (!Number.isInteger(amount) || amount < 1 || amount > 100 || !ctx.channel?.bulkDelete) return reply(ctx, 'Indiquez une quantité entre 1 et 100 dans un salon textuel.', true); const deleted = await ctx.channel.bulkDelete(amount, true); return reply(ctx, `${deleted.size} message(s) supprimé(s).`); }
  if (command === 'lock' || command === 'unlock') {
    if (!ctx.channel?.permissionOverwrites) return reply(ctx, 'Salon non compatible.', true);
    const botMember = guild.members.me;
    if (!botMember?.permissionsIn(ctx.channel).has(PermissionFlagsBits.ManageChannels)) return reply(ctx, 'Il me manque la permission **Gérer les salons** dans ce salon.', true);
    const locks = lockConfig(guild.id); const channelId = ctx.channel.id;
    const lockPermissions = ['SendMessages', 'AddReactions', 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads'];
    if (command === 'lock') {
      if (locks[channelId]) return reply(ctx, 'Ce salon est déjà verrouillé.', true);
      const overwriteIds = new Set([...ctx.channel.permissionOverwrites.cache.keys(), guild.roles.everyone.id]);
      const snapshot = {};
      for (const id of overwriteIds) {
        if (id === client.user.id) continue;
        const overwrite = ctx.channel.permissionOverwrites.cache.get(id);
        snapshot[id] = { created: !overwrite, permissions: Object.fromEntries(lockPermissions.map(permission => [permission, overwrite?.allow.has(PermissionFlagsBits[permission]) ? true : overwrite?.deny.has(PermissionFlagsBits[permission]) ? false : null])) };
        await ctx.channel.permissionOverwrites.edit(id, Object.fromEntries(lockPermissions.map(permission => [permission, false])), { reason: `Verrouillage par ${actor.tag}` });
      }
      locks[channelId] = snapshot; save();
      return reply(ctx, '🔒 Salon verrouillé. Les permissions précédentes seront restaurées par `unlock`.');
    }
    const snapshot = locks[channelId];
    if (!snapshot) return reply(ctx, 'Ce salon n’a pas été verrouillé par le bot ou son état n’est plus disponible.', true);
    for (const [id, saved] of Object.entries(snapshot)) {
      if (saved.created) await ctx.channel.permissionOverwrites.delete(id, `Déverrouillage par ${actor.tag}`).catch(() => {});
      else await ctx.channel.permissionOverwrites.edit(id, saved.permissions, { reason: `Déverrouillage par ${actor.tag}` }).catch(() => {});
    }
    delete locks[channelId]; save();
    return reply(ctx, '🔓 Salon déverrouillé et permissions restaurées.');
  }
  if (command === 'slowmode') { const seconds = Number(slash ? ctx.options.getInteger('secondes') : args[0]); if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600 || !ctx.channel?.setRateLimitPerUser) return reply(ctx, 'Indiquez entre 0 et 21600 secondes.', true); await ctx.channel.setRateLimitPerUser(seconds); return reply(ctx, `Mode lent réglé sur ${seconds} seconde(s).`); }
  if (command === 'antibot') { const state = (slash ? ctx.options.getString('etat') : args[0])?.toLowerCase(); if (!['on', 'off'].includes(state)) return reply(ctx, 'Usage : antibot on/off', true); if (state === 'off' && actor.id !== process.env.BOT_OWNER_ID) return reply(ctx, 'Seul le propriétaire défini dans `BOT_OWNER_ID` peut désactiver l’antibot.', true); config(guild.id).antibot = state === 'on'; save(); return reply(ctx, `Antibot **${state === 'on' ? 'activé' : 'désactivé'}**.`); }
  if (command === 'antinuke') { const state = (slash ? ctx.options.getString('etat') : args[0])?.toLowerCase(); const threshold = slash ? ctx.options.getInteger('seuil') : Number(args[1] || 3); const action = (slash ? ctx.options.getString('action') : args[2] || 'strip').toLowerCase(); if (!['on', 'off'].includes(state) || !Number.isInteger(threshold) || threshold < 2 || threshold > 20 || !['strip', 'kick', 'ban'].includes(action)) return reply(ctx, 'Usage : antinuke on/off [seuil 2-20] [strip|kick|ban]', true); if (state === 'off' && actor.id !== process.env.BOT_OWNER_ID) return reply(ctx, 'Seul le propriétaire défini dans `BOT_OWNER_ID` peut désactiver l’antinuke.', true); config(guild.id).antinuke = { enabled: state === 'on', threshold, action }; save(); return reply(ctx, `Antinuke **${state === 'on' ? 'activé' : 'désactivé'}** (seuil ${threshold}, action ${action}).`); }
  if (command === 'antispam') {
    const state = (slash ? ctx.options.getString('etat') : args[0])?.toLowerCase();
    const limit = Number(slash ? ctx.options.getInteger('messages') ?? 6 : args[1] ?? 6);
    const interval = Number(slash ? ctx.options.getInteger('secondes') ?? 7 : args[2] ?? 7);
    const timeout = slash ? ctx.options.getString('timeout') ?? '10m' : args[3] ?? '10m';
    if (!['on', 'off'].includes(state) || !Number.isInteger(limit) || limit < 3 || limit > 15 || !Number.isInteger(interval) || interval < 2 || interval > 60 || !duration(timeout)) return reply(ctx, 'Usage : antispam on/off [3-15 messages] [2-60 secondes] [timeout, ex. 10m]', true);
    if (state === 'off' && actor.id !== process.env.BOT_OWNER_ID) return reply(ctx, 'Seul le propriétaire défini dans `BOT_OWNER_ID` peut désactiver l’antispam.', true);
    config(guild.id).antispam = { enabled: state === 'on', limit, interval, timeout }; save();
    return reply(ctx, `Antispam **${state === 'on' ? 'activé' : 'désactivé'}** : ${limit} messages en ${interval} secondes → timeout ${timeout}.`);
  }
}

client.once(Events.ClientReady, c => {
  console.log(`Connecté comme ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) for (const state of guild.voiceStates.cache.values()) {
    if (!state.member?.user.bot && state.channelId) voiceSessions.set(`${guild.id}:${state.id}`, { creditedAt: Date.now() });
  }
});
client.on(Events.InteractionCreate, async i => {
  if (i.isButton() && i.customId === 'ticket:close') return closeTicket(i).catch(() => {});
  if (i.isStringSelectMenu() && i.customId === 'ticket:create') {
    const type = i.values[0];
    if (!ticketTypes[type]) return i.reply({ content: 'Type de ticket invalide.', ephemeral: true });
    if (type === 'report_staff') {
      const staffMembers = (await i.guild.members.fetch()).filter(member => !member.user.bot && isStaffMember(member)).first(25);
      if (!staffMembers.length) return i.reply({ content: 'Aucun membre avec le rôle Équipe Staff n’est disponible.', ephemeral: true });
      return i.reply({
        flags: 32_832,
        components: [{ type: 17, accent_color: UI.white, components: [
          { type: 10, content: `## ${UI.logo} Signalement d’un membre du staff` },
          { type: 10, content: `${UI.arrow} Sélectionnez le ou les membres possédant le rôle **__Équipe Staff__** concernés par votre signalement.\n\n> Votre sélection sera ajoutée au dossier de manière confidentielle afin de faciliter son traitement.` },
          { type: 1, components: [{ type: 3, custom_id: 'ticket:staff-targets', placeholder: 'Sélectionner un ou plusieurs staffs', min_values: 1, max_values: staffMembers.length, options: staffMembers.map(member => ({ label: member.displayName.slice(0, 100), description: member.user.tag.slice(0, 100), value: member.id })) }] }
        ] }]
      });
    }
    const result = await createTicket(i.guild, i.member, type);
    return i.reply({ content: result.error ?? `✅ Ton ticket a été créé : ${result.channel}`, ephemeral: true });
  }
  if (i.isStringSelectMenu() && i.customId === 'ticket:staff-targets') {
    const selected = await Promise.all(i.values.map(id => i.guild.members.fetch(id).catch(() => null)));
    if (selected.some(member => !member || !isStaffMember(member))) return i.reply({ content: 'Sélectionne uniquement des membres possédant le rôle Équipe Staff.', ephemeral: true });
    const result = await createTicket(i.guild, i.member, 'report_staff', i.values);
    return i.reply({ content: result.error ?? `✅ Ton ticket de signalement a été créé : ${result.channel}`, ephemeral: true });
  }
  if (!i.isChatInputCommand()) return;
  await execute(i, i.commandName, [], true).catch(e => reply(i, `Erreur : ${e.message}`, true));
});
client.on(Events.MessageCreate, async m => {
  if (m.author.bot || !m.guild) return;
  if (await enforceAntiLink(m)) return;
  if (await enforceAntiSpam(m)) return;
  if (!m.content.startsWith(prefix) && m.content.trim().length >= 3) {
    const user = levelRecord(m.guild.id, m.author.id);
    if (Date.now() - user.last_message_at >= 20_000) {
      saveLevelRecord(m.guild.id, m.author.id, user.xp, Date.now());
      const gained = Math.min(25, 8 + Math.floor(m.content.trim().length / 25));
      const coins = Math.min(10, 1 + Math.floor(m.content.trim().length / 30));
      await addXp(m.member, gained, coins);
      incrementMetric(m.guild.id, 'messages');
    }
  }
  if (!m.content.startsWith(prefix)) return;
  const [command, ...args] = m.content.slice(prefix.length).trim().split(/\s+/); if (!command) return;
  await execute(m, command.toLowerCase(), args).catch(e => m.reply(`Erreur : ${e.message}`));
});
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member ?? oldState.member; if (!member || member.user.bot || oldState.channelId === newState.channelId) return;
  const key = `${member.guild.id}:${member.id}`;
  if (oldState.channelId) await creditVoice(member);
  if (newState.channelId) voiceSessions.set(key, { creditedAt: Date.now() }); else voiceSessions.delete(key);
});
setInterval(async () => {
  for (const [key] of voiceSessions) {
    const [guildId, memberId] = key.split(':'); const guild = client.guilds.cache.get(guildId); const member = guild && await guild.members.fetch(memberId).catch(() => null);
    if (member?.voice.channelId) await creditVoice(member); else voiceSessions.delete(key);
  }
}, 15_000);
client.on(Events.GuildMemberAdd, async member => {
  if (!member.user.bot) incrementMetric(member.guild.id, 'joins');
  if (!member.user.bot || !config(member.guild.id).antibot) return;
  await member.ban({ reason: 'Antibot activé' }).catch(() => {});
  await log(member.guild, `**ANTIBOT** — ${member.user.tag} banni automatiquement.`);
});

const actions = new Map();
const auditTypes = new Map([[Events.ChannelCreate, AuditLogEvent.ChannelCreate], [Events.ChannelDelete, AuditLogEvent.ChannelDelete], [Events.ChannelUpdate, AuditLogEvent.ChannelUpdate], [Events.GuildRoleCreate, AuditLogEvent.RoleCreate], [Events.GuildRoleDelete, AuditLogEvent.RoleDelete], [Events.GuildRoleUpdate, AuditLogEvent.RoleUpdate], [Events.GuildBanAdd, AuditLogEvent.MemberBanAdd], [Events.GuildMemberRemove, AuditLogEvent.MemberKick]]);
for (const [event, auditType] of auditTypes) client.on(event, async entity => {
  const guild = entity.guild; const anti = config(guild.id).antinuke; if (!anti.enabled) return;
  const logs = await guild.fetchAuditLogs({ type: auditType, limit: 1 }).catch(() => null); const entry = logs?.entries.first();
  if (!entry || entry.targetId !== entity.id || Date.now() - entry.createdTimestamp > 8000 || entry.executorId === client.user.id || entry.executorId === guild.ownerId) return;
  const key = `${guild.id}:${entry.executorId}`; const recent = (actions.get(key) || []).filter(t => Date.now() - t < 10_000); recent.push(Date.now()); actions.set(key, recent);
  if (recent.length < anti.threshold) return;
  actions.set(key, []); const offender = await guild.members.fetch(entry.executorId).catch(() => null); if (!offender || !offender.moderatable) return;
  if (anti.action === 'strip') { const roles = offender.roles.cache.filter(r => r.id !== guild.id && r.permissions.any(dangerPerms)); await offender.roles.remove(roles, 'Antinuke : actions de masse'); }
  else if (anti.action === 'kick') await offender.kick('Antinuke : actions de masse');
  else await offender.ban({ reason: 'Antinuke : actions de masse' });
  await log(guild, `🚨 **ANTINUKE** — ${offender.user.tag} : ${anti.action} après ${anti.threshold} actions en 10 secondes.`);
});

if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN est requis dans .env');
client.login(process.env.DISCORD_TOKEN);
