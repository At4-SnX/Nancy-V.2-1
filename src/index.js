import 'dotenv/config';
import { AttachmentBuilder, AuditLogEvent, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';

const prefix = process.env.PREFIX || '&';
const settingsPath = path.resolve('data/settings.json');
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* first boot */ }
const save = () => fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
const config = guildId => {
  const guildConfig = settings[guildId] ??= { antibot: false, antinuke: { enabled: false, threshold: 3, action: 'strip' } };
  guildConfig.levels ??= { roles: {}, users: {}, channelId: null };
  guildConfig.levels.roles ??= {}; guildConfig.levels.users ??= {}; guildConfig.levels.channelId ??= null;
  return guildConfig;
};

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildVoiceStates] });
const dangerPerms = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ModerateMembers;
const staffCommands = new Set(['ping', 'help', 'rank', 'leaderboard', 'kick', 'mute', 'unmute', 'clear', 'lock', 'unlock', 'slowmode', 'ticketclose']);
const levelMilestones = [1, 10, 20, 30, 40, 50, 60, 70];
const maxLevel = 70;
const xpForLevel = level => level * level * 100;
const levelFromXp = xp => Math.min(maxLevel, Math.floor(Math.sqrt(xp / 100)));
const voiceSessions = new Map();
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
  if (['help', 'rank', 'leaderboard'].includes(command)) return true;
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
function ticketCategoryId(tickets, type) {
  return process.env[ticketCategoryVariables[type]]?.trim() || process.env.TICKET_CATEGORY_ID?.trim() || tickets.categoryId;
}
async function log(guild, text) { const channel = process.env.LOG_CHANNEL_ID && guild.channels.cache.get(process.env.LOG_CHANNEL_ID); if (channel?.isTextBased()) await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(text).setTimestamp()] }).catch(() => {}); }
async function reply(ctx, text, ephemeral = false) { return ctx.reply({ content: text, ephemeral }).catch(() => ctx.channel?.send(text)); }
async function v2Reply(ctx, components, ephemeral = false) {
  const payload = { flags: 32_768 | (ephemeral && ctx.isChatInputCommand?.() ? 64 : 0), components };
  return ctx.reply(payload).catch(() => ctx.channel?.send({ flags: 32_768, components }));
}
function progressBar(value) { const filled = Math.max(0, Math.min(10, Math.round(value * 10))); return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`; }
function helpComponents() { return [{ type: 17, accent_color: 0x1e4d70, components: [
  { type: 10, content: '## ✦ Nancy RP V.2 • Centre de commandes' },
  { type: 10, content: 'Bienvenue dans le centre de gestion du serveur. Toutes les commandes existent aussi avec le préfixe `&`.' },
  { type: 14, divider: true, spacing: 1 },
  { type: 10, content: `### 🛡️ Modération\n\`${prefix}kick <membre> [raison]\` · \`${prefix}ban <membre> [raison]\` · \`${prefix}mute <membre> <durée> [raison]\`\n\`${prefix}unmute <membre>\` · \`${prefix}clear <1-100>\` · \`${prefix}lock\` · \`${prefix}unlock\` · \`${prefix}slowmode <secondes>\`` },
  { type: 10, content: `### 🏅 Progression\n\`${prefix}rank [membre]\` affiche une progression détaillée. \`${prefix}leaderboard\` affiche le top 10 actualisé en direct.\nMessages : **8 à 25 XP** toutes les 20 secondes. Vocal : **4 XP toutes les 15 secondes**.` },
  { type: 10, content: `### 🎫 Tickets\nUtilise le panneau dédié pour créer un ticket. Un staff peut fermer un ticket avec \`${prefix}ticketclose\`.` },
  { type: 10, content: `-# Réservé Administrateur : antibot, antinuke, configuration niveaux et tickets. Équipe Staff : modération basique.` }
] }]; }

async function applyLevelRoles(member, level) {
  const roles = config(member.guild.id).levels.roles;
  for (const milestone of levelMilestones.filter(value => value <= level)) {
    const roleId = roles[milestone]; if (!roleId || member.roles.cache.has(roleId)) continue;
    const role = await member.guild.roles.fetch(roleId).catch(() => null);
    if (role?.editable) await member.roles.add(role, `Récompense niveau ${milestone}`).catch(() => {});
  }
}
async function addXp(member, amount) {
  if (amount <= 0) return;
  const user = config(member.guild.id).levels.users[member.id] ??= { xp: 0, lastMessageAt: 0 };
  const oldLevel = levelFromXp(user.xp);
  user.xp = Math.min(xpForLevel(maxLevel), user.xp + amount);
  const newLevel = levelFromXp(user.xp); save();
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
          accent_color: 0x1e4d70,
          components: [
            { type: 10, content: '## 🎉 Nouveau niveau atteint !' },
            { type: 10, content: `${member} vient de passer au **niveau ${newLevel}** !\n\nTa régularité, que ce soit par ton activité écrite ou vocale, te fait progresser parmi les citoyens les plus investis de Nancy RP V.2. Continue ainsi pour atteindre le niveau maximal et débloquer les prochaines récompenses.` },
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
  await addXp(member, periods * 4);
}
function ticketPanel() {
  return {
    flags: 32_768,
    components: [{ type: 17, accent_color: 0x1e4d70, components: [
      { type: 10, content: '## 🎫 Centre de support • Nancy RP V.2' },
      { type: 10, content: 'Sélectionne la catégorie correspondant à ta demande. Un salon privé sera créé et l’équipe concernée sera alertée.' },
      { type: 12, items: [{ media: { url: 'attachment://ticket.gif' } }] },
      { type: 14, divider: true, spacing: 1 },
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
  if (alertRoleId) await channel.send({ content: `<@&${alertRoleId}>`, allowedMentions: { roles: [alertRoleId] } }).catch(() => {});
  const reportedText = reportedStaff.length ? `\n\n**Membre(s) du staff signalé(s) :** ${reportedStaff.map(id => `<@${id}>`).join(', ')}` : '';
  await channel.send({
    flags: 32_768,
    components: [{ type: 17, accent_color: 0x1e4d70, components: [
      { type: 10, content: `## ${ticketTypes[type]}` },
      { type: 10, content: `Bienvenue ${owner}. Explique ta demande de façon précise ; l’équipe concernée te répondra ici.${reportedText}` },
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
  if (command === 'ping') return v2Reply(ctx, [{ type: 17, accent_color: 0x1e4d70, components: [{ type: 10, content: '## 🛰️ Nancy RP V.2 • État du bot' }, { type: 10, content: `Le bot est connecté et opérationnel. Latence actuelle : **${client.ws.ping} ms**.` }, { type: 10, content: '-# Les systèmes de modération, tickets et progression sont prêts.' }] }], true);
  if (command === 'help') return v2Reply(ctx, helpComponents(), true);
  if (command === 'rank') {
    const target = slash ? (ctx.options.getMember('membre') ?? member) : (args[0] ? await getMember(args[0]) : member);
    if (!target) return reply(ctx, 'Membre introuvable.', true);
    const xp = config(guild.id).levels.users[target.id]?.xp ?? 0;
    const level = levelFromXp(xp); const currentFloor = xpForLevel(level); const next = level >= maxLevel ? null : xpForLevel(level + 1);
    const ratio = next ? (xp - currentFloor) / (next - currentFloor) : 1;
    return v2Reply(ctx, [{ type: 17, accent_color: 0x1e4d70, components: [
      { type: 10, content: `## 🏅 Profil de progression • ${target.user.tag}` },
      { type: 10, content: `${target}\n\n### Niveau ${level} / ${maxLevel}\n\`${progressBar(ratio)}\` **${Math.floor(ratio * 100)} %**` },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: next ? `**${xp.toLocaleString('fr-FR')} XP** accumulée • encore **${(next - xp).toLocaleString('fr-FR')} XP** avant le niveau **${level + 1}**.\n\n-# Activité message et présence en vocal contribuent toutes deux à ta progression.` : `**${xp.toLocaleString('fr-FR')} XP** accumulée • tu as atteint le **niveau maximum**.\n\n-# Félicitations : ton parcours est complété.` }
    ] }], true);
  }
  if (command === 'leaderboard') {
    const users = Object.entries(config(guild.id).levels.users).sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
    if (!users.length) return v2Reply(ctx, [{ type: 17, accent_color: 0x1e4d70, components: [{ type: 10, content: '## 🏆 Classement Nancy RP V.2' }, { type: 10, content: 'Aucune expérience n’a encore été gagnée. Lance la progression en participant au serveur !' }] }], true);
    const lines = await Promise.all(users.map(async ([id, data], index) => {
      const ranked = await guild.members.fetch(id).catch(() => null);
      const medal = ['🥇', '🥈', '🥉'][index] ?? `**${index + 1}.**`;
      return `${medal} **${ranked?.user.tag ?? `Utilisateur ${id}`}**\n> Niveau **${levelFromXp(data.xp)}** • **${data.xp.toLocaleString('fr-FR')} XP**`;
    }));
    return v2Reply(ctx, [{ type: 17, accent_color: 0x1e4d70, components: [
      { type: 10, content: '## 🏆 Classement officiel • Nancy RP V.2' },
      { type: 10, content: 'Voici les citoyens les plus actifs. Ce classement est calculé à partir des données XP au moment exact de la commande.' },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: lines.join('\n\n') },
      { type: 10, content: '-# Continue à écrire et à participer en vocal pour progresser dans le classement.' }
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
    if (!ticketTypes[type] || !role || role.managed) return reply(ctx, 'Usage : ticketrole <fondation|legal|illegal|report_staff|report_joueur|question|unban|build> <rôle>', true);
    ticketConfig(guild.id).roles[type] = role.id; save();
    return reply(ctx, `${role} sera alerté pour les **${ticketTypes[type]}**.`);
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
    if (!role || role.managed || !role.editable) return reply(ctx, 'Ce rôle est introuvable ou je ne peux pas l’attribuer. Place mon rôle au-dessus.', true);
    config(guild.id).levels.roles[level] = role.id; save();
    for (const cachedMember of guild.members.cache.values()) {
      const xp = config(guild.id).levels.users[cachedMember.id]?.xp ?? 0;
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
  if (command === 'lock' || command === 'unlock') { if (!ctx.channel?.permissionOverwrites) return reply(ctx, 'Salon non compatible.', true); await ctx.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: command === 'lock' ? false : null }, { reason: `${command} par ${actor.tag}` }); return reply(ctx, command === 'lock' ? '🔒 Salon verrouillé.' : '🔓 Salon déverrouillé.'); }
  if (command === 'slowmode') { const seconds = Number(slash ? ctx.options.getInteger('secondes') : args[0]); if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600 || !ctx.channel?.setRateLimitPerUser) return reply(ctx, 'Indiquez entre 0 et 21600 secondes.', true); await ctx.channel.setRateLimitPerUser(seconds); return reply(ctx, `Mode lent réglé sur ${seconds} seconde(s).`); }
  if (command === 'antibot') { const state = (slash ? ctx.options.getString('etat') : args[0])?.toLowerCase(); if (!['on', 'off'].includes(state)) return reply(ctx, 'Usage : antibot on/off', true); if (state === 'off' && actor.id !== process.env.BOT_OWNER_ID) return reply(ctx, 'Seul le propriétaire défini dans `BOT_OWNER_ID` peut désactiver l’antibot.', true); config(guild.id).antibot = state === 'on'; save(); return reply(ctx, `Antibot **${state === 'on' ? 'activé' : 'désactivé'}**.`); }
  if (command === 'antinuke') { const state = (slash ? ctx.options.getString('etat') : args[0])?.toLowerCase(); const threshold = slash ? ctx.options.getInteger('seuil') : Number(args[1] || 3); const action = (slash ? ctx.options.getString('action') : args[2] || 'strip').toLowerCase(); if (!['on', 'off'].includes(state) || !Number.isInteger(threshold) || threshold < 2 || threshold > 20 || !['strip', 'kick', 'ban'].includes(action)) return reply(ctx, 'Usage : antinuke on/off [seuil 2-20] [strip|kick|ban]', true); if (state === 'off' && actor.id !== process.env.BOT_OWNER_ID) return reply(ctx, 'Seul le propriétaire défini dans `BOT_OWNER_ID` peut désactiver l’antinuke.', true); config(guild.id).antinuke = { enabled: state === 'on', threshold, action }; save(); return reply(ctx, `Antinuke **${state === 'on' ? 'activé' : 'désactivé'}** (seuil ${threshold}, action ${action}).`); }
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
        components: [{ type: 17, accent_color: 0x1e4d70, components: [
          { type: 10, content: '## Signalement d’un membre du staff' },
          { type: 10, content: 'Sélectionne le ou les membres possédant le rôle **Équipe Staff** que tu souhaites signaler.' },
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
  if (!m.content.startsWith(prefix) && m.content.trim().length >= 3) {
    const user = config(m.guild.id).levels.users[m.author.id] ??= { xp: 0, lastMessageAt: 0 };
    if (Date.now() - user.lastMessageAt >= 20_000) {
      user.lastMessageAt = Date.now();
      const gained = Math.min(25, 8 + Math.floor(m.content.trim().length / 25));
      await addXp(m.member, gained);
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
client.on(Events.GuildMemberAdd, async member => { if (!member.user.bot || !config(member.guild.id).antibot) return; await member.ban({ reason: 'Antibot activé' }).catch(() => {}); await log(member.guild, `**ANTIBOT** — ${member.user.tag} banni automatiquement.`); });

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
