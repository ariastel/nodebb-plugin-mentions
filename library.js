'use strict';

const	async = require('async');

const winston = module.parent.require('winston');
const XRegExp = require('xregexp');
const validator = require('validator');

const nconf = module.parent.require('nconf');

const db = require.main.require('./src/database');
const api = require.main.require('./src/api');
const Topics = require.main.require('./src/topics');
const posts = require.main.require('./src/posts');
const User = require.main.require('./src/user');
const Groups = require.main.require('./src/groups');
const Notifications = require.main.require('./src/notifications');
const Privileges = require.main.require('./src/privileges');
const plugins = require.main.require('./src/plugins');
const Meta = require.main.require('./src/meta');
const slugify = require.main.require('./src/slugify');
const batch = require.main.require('./src/batch');
const utils = require.main.require('./public/src/utils');

const SocketPlugins = require.main.require('./src/socket.io/plugins');

const utility = require('./lib/utility');

const regex = XRegExp('(?:^|\\s|\\>|;)(@[\\p{L}\\d\\-_.]+)', 'g');
const isLatinMention = /@[\w\d\-_.]+$/;
const removePunctuationSuffix = function (string) {
	return string.replace(/[!?.]*$/, '');
};
const Entities = require('html-entities').XmlEntities;

const entities = new Entities();

const Mentions = {
	_settings: {},
	_defaults: {
		disableFollowedTopics: 'off',
		autofillGroups: 'off',
		disableGroupMentions: '[]',
		overrideIgnores: 'off',
		display: '',
	},
};
SocketPlugins.mentions = {};

Mentions.init = async (data) => {
	const hostMiddleware = require.main.require('./src/middleware');
	const controllers = require('./controllers');

	data.router.get('/admin/plugins/mentions', hostMiddleware.admin.buildHeader, controllers.renderAdminPage);
	data.router.get('/api/admin/plugins/mentions', controllers.renderAdminPage);

	// Retrieve settings
	Object.assign(Mentions._settings, Mentions._defaults, await Meta.settings.get('mentions'));
};

Mentions.addAdminNavigation = async (header) => {
	header.plugins.push({
		route: '/plugins/mentions',
		name: 'Mentions',
	});

	return header;
};

function getNoMentionGroups() {
	let noMentionGroups = ['registered-users', 'guests'];
	try {
		noMentionGroups = noMentionGroups.concat(JSON.parse(Mentions._settings.disableGroupMentions));
	} catch (err) {
		winston.error(err);
	}
	return noMentionGroups;
}

Mentions.notify = function (data) {
	const postData = data.post;
	const cleanedContent = Mentions.clean(postData.content, true, true, true);
	let matches = cleanedContent.match(regex);

	if (!matches) {
		return;
	}

	const noMentionGroups = getNoMentionGroups();

	matches = matches.map(match => slugify(match)).filter((match, index, array) => match && array.indexOf(match) === index && noMentionGroups.indexOf(match) === -1);

	if (!matches.length) {
		return;
	}

	async.parallel({
		userRecipients: function (next) {
			async.filter(matches, User.existsBySlug, next);
		},
		groupRecipients: function (next) {
			async.filter(matches, Groups.existsBySlug, next);
		},
	}, (err, results) => {
		if (err) {
			return;
		}

		if (!results.userRecipients.length && !results.groupRecipients.length) {
			return;
		}

		async.parallel({
			topic: function (next) {
				Topics.getTopicFields(postData.tid, ['title', 'cid'], next);
			},
			author: function (next) {
				User.getUserField(postData.uid, 'username', next);
			},
			uids: function (next) {
				async.map(results.userRecipients, (slug, next) => {
					User.getUidByUserslug(slug, next);
				}, next);
			},
			groupData: function (next) {
				getGroupMemberUids(results.groupRecipients, next);
			},
			topicFollowers: function (next) {
				if (Mentions._settings.disableFollowedTopics === 'on') {
					Topics.getFollowers(postData.tid, next);
				} else {
					next(null, []);
				}
			},
		}, async (err, results) => {
			if (err) {
				return;
			}

			const title = entities.decode(results.topic.title);
			const titleEscaped = title.replace(/%/g, '&#37;').replace(/,/g, '&#44;');

			let uids = results.uids.filter((uid, index, array) => array.indexOf(uid) === index && parseInt(uid, 10) !== parseInt(postData.uid, 10) && !results.topicFollowers.includes(uid.toString()));

			if (Mentions._settings.privilegedDirectReplies === 'on') {
				const toPid = await posts.getPostField(data.post.pid, 'toPid');
				uids = await filterPrivilegedUids(uids, data.post.cid, toPid);
			}

			const groupMemberUids = {};
			results.groupData.groupNames.forEach((groupName, index) => {
				results.groupData.groupMembers[index] = results.groupData.groupMembers[index].filter((uid) => {
					if (!uid || groupMemberUids[uid]) {
						return false;
					}
					groupMemberUids[uid] = 1;
					return !uids.includes(uid) &&
						parseInt(uid, 10) !== parseInt(postData.uid, 10) &&
						!results.topicFollowers.includes(uid.toString());
				});
			});

			sendNotificationToUids(postData, uids, 'user', `[[notifications:user_mentioned_you_in, ${results.author}, ${titleEscaped}]]`);

			results.groupData.groupNames.forEach((groupName, index) => {
				const memberUids = results.groupData.groupMembers[index];
				sendNotificationToUids(postData, memberUids, groupName, `[[notifications:user_mentioned_group_in, ${results.author}, ${groupName}, ${titleEscaped}]]`);
			});
		});
	});
};

Mentions.addFilters = async (data) => {
	data.regularFilters.push({ name: '[[notifications:mentions]]', filter: 'mention' });
	return data;
};

Mentions.notificationTypes = async (data) => {
	data.types.push('notificationType_mention');
	return data;
};

Mentions.addFields = async (data) => {
	if (!Meta.config.hideFullname) {
		data.fields.push('fullname');
	}
	return data;
};

function sendNotificationToUids(postData, uids, nidType, notificationText) {
	if (!uids.length) {
		return;
	}

	let filteredUids = [];
	let notification;
	async.waterfall([
		function (next) {
			createNotification(postData, nidType, notificationText, next);
		},
		function (_notification, next) {
			notification = _notification;
			if (!notification) {
				return next();
			}

			batch.processArray(uids, (uids, next) => {
				async.waterfall([
					function (next) {
						Privileges.topics.filterUids('read', postData.tid, uids, next);
					},
					function (_uids, next) {
						if (Mentions._settings.overrideIgnores === 'on') {
							return setImmediate(next, null, _uids);
						}

						Topics.filterIgnoringUids(postData.tid, _uids, next);
					},
					function (_uids, next) {
						// Filter out uids that have already been notified for this pid
						db.isSortedSetMembers(`mentions:sent:${postData.pid}`, _uids, (err, exists) => {
							next(err, _uids.filter((uid, idx) => !exists[idx]));
						});
					},
					function (_uids, next) {
						if (!_uids.length) {
							return next();
						}

						filteredUids = filteredUids.concat(_uids);

						next();
					},
				], next);
			}, {
				interval: 1000,
				batch: 500,
			}, next);
		},
	], (err) => {
		if (err) {
			return winston.error(err);
		}

		if (notification && filteredUids.length) {
			plugins.hooks.fire('action:mentions.notify', { notification, uids: filteredUids });
			Notifications.push(notification, filteredUids, () => {
				const dates = filteredUids.map(() => Date.now());
				db.sortedSetAdd(`mentions:sent:${postData.pid}`, dates, filteredUids);
			});
		}
	});
}

function createNotification(postData, nidType, notificationText, callback) {
	Topics.getTopicField(postData.tid, 'title', (err, title) => {
		if (err) {
			return callback(err);
		}
		if (title) {
			title = utils.decodeHTMLEntities(title);
		}
		Notifications.create({
			type: 'mention',
			bodyShort: notificationText,
			bodyLong: postData.content,
			nid: `tid:${postData.tid}:pid:${postData.pid}:uid:${postData.uid}:${nidType}`,
			pid: postData.pid,
			tid: postData.tid,
			from: postData.uid,
			path: `/post/${postData.pid}`,
			topicTitle: title,
			importance: 6,
		}, callback);
	});
}

function getGroupMemberUids(groupRecipients, callback) {
	async.map(groupRecipients, (slug, next) => {
		Groups.getGroupNameByGroupSlug(slug, next);
	}, (err, groupNames) => {
		if (err) {
			return callback(err);
		}
		async.map(groupNames, (groupName, next) => {
			Groups.getMembers(groupName, 0, -1, next);
		}, (err, groupMembers) => {
			if (err) {
				return callback(err);
			}
			callback(null, { groupNames: groupNames, groupMembers: groupMembers });
		});
	});
}

Mentions.parsePost = async (data) => {
	if (!data || !data.postData || !data.postData.content) {
		return data;
	}

	const parsed = await Mentions.parseRaw(data.postData.content);
	data.postData.content = parsed;
	return data;
};

Mentions.parseRaw = async (content) => {
	let splitContent = utility.split(content, false, false, true);
	let matches = [];
	splitContent.forEach((cleanedContent, i) => {
		if ((i & 1) === 0) {
			matches = matches.concat(cleanedContent.match(regex) || []);
		}
	});

	if (!matches.length) {
		return content;
	}

	matches = matches.filter((cur, idx) =>
		// Eliminate duplicates
		 idx === matches.indexOf(cur)).map((match) => {
		/**
		 *	Javascript-favour of regex does not support lookaround,
		 *	so need to clean up the cruft by discarding everthing
		 *	before the @
		 */
		const atIndex = match.indexOf('@');
		return atIndex !== 0 ? match.slice(atIndex) : match;
	});

	await Promise.all(matches.map(async (match) => {
		const slug = slugify(match.slice(1));
		match = removePunctuationSuffix(match);

		const uid = await User.getUidByUserslug(slug);
		const results = await utils.promiseParallel({
			groupExists: Groups.existsBySlug(slug),
			user: User.getUserFields(uid, ['uid', 'username', 'fullname']),
		});

		if (results.user.uid || results.groupExists) {
			const regex = isLatinMention.test(match) ?
				new RegExp(`(?:^|\\s|\>|;)${match}\\b`, 'g') :
				new RegExp(`(?:^|\\s|\>|;)${match}`, 'g');

			let skip = false;

			splitContent = splitContent.map((c, i) => {
				// *Might* not be needed anymore? Check pls...
				if (skip || (i & 1) === 1) {
					skip = c === '<code>';	// if code block detected, skip the content inside of it
					return c;
				}
				return c.replace(regex, (match) => {
					// Again, cleaning up lookaround leftover bits
					const atIndex = match.indexOf('@');
					const plain = match.slice(0, atIndex);
					match = match.slice(atIndex);
					if (results.user.uid) {
						switch (Mentions._settings.display) {
							case 'fullname':
								match = results.user.fullname || match;
								break;
							case 'username':
								match = results.user.username;
								break;
						}
					}

					const str = results.user.uid ?
						`<a class="plugin-mentions-user plugin-mentions-a" href="${nconf.get('url')}/uid/${results.user.uid}">${match}</a>` :
						`<a class="plugin-mentions-group plugin-mentions-a" href="${nconf.get('url')}/groups/${slug}">${match}</a>`;

					return plain + str;
				});
			});
		}
	}));

	return splitContent.join('');
};

Mentions.clean = function (input, isMarkdown, stripBlockquote, stripCode) {
	let split = utility.split(input, isMarkdown, stripBlockquote, stripCode);
	split = split.filter((e, i) =>
		// only keep non-code/non-blockquote
		 (i & 1) === 0);
	return split.join('');
};

/*
	Local utility methods
*/
async function filterPrivilegedUids(uids, cid, toPid) {
	let toPidUid;
	if (toPid) {
		toPidUid = await posts.getPostField(toPid, 'uid');
	}

	// Remove administrators, global mods, and moderators of the post's cid
	uids = await Promise.all(uids.map(async (uid) => {
		// Direct replies are a-ok.
		if (uid === toPidUid) {
			return uid;
		}

		const [isAdmin, isMod] = await Promise.all([
			User.isAdministrator(uid),
			User.isModerator(uid, cid),	// covers gmod as well
		]);

		return isAdmin || isMod ? false : uid;
	}));

	return uids.filter(Boolean);
}

async function filterDisallowedFullnames(users) {
	const userSettings = await User.getMultipleUserSettings(users.map(user => user.uid));
	return users.filter((user, index) => userSettings[index].showfullname);
}

async function stripDisallowedFullnames(users) {
	const userSettings = await User.getMultipleUserSettings(users.map(user => user.uid));
	return users.map((user, index) => {
		if (!userSettings[index].showfullname) {
			user.fullname = null;
		}
		return user;
	});
}

/*
	WebSocket methods
*/

SocketPlugins.mentions.getTopicUsers = async (socket, data) => {
	const uids = await Topics.getUids(data.tid);
	const users = await User.getUsers(uids);
	if (Meta.config.hideFullname) {
		return users;
	}
	return stripDisallowedFullnames(users);
};

SocketPlugins.mentions.listGroups = function (socket, data, callback) {
	if (Mentions._settings.autofillGroups === 'off') {
		return callback(null, []);
	}

	Groups.getGroups('groups:visible:createtime', 0, -1, (err, groups) => {
		if (err) {
			return callback(err);
		}
		const noMentionGroups = getNoMentionGroups();
		groups = groups.filter(groupName => groupName && !noMentionGroups.includes(groupName)).map(groupName => validator.escape(groupName));
		callback(null, groups);
	});
};

SocketPlugins.mentions.userSearch = async (socket, data) => {
	// Transparently pass request through to socket user.search handler
	const socketUser = require.main.require('./src/socket.io/user');

	// Search by username
	let { users } = await api.users.search(socket, data);

	if (!Meta.config.hideFullname) {
		// Strip fullnames of users that do not allow their full name to be visible
		users = await stripDisallowedFullnames(users);

		// Search by fullname
		let { users: fullnameUsers } = await api.users.search(socket, { query: data.query, searchBy: 'fullname' });
		// Hide results of users that do not allow their full name to be visible (prevents "enumeration attack")
		fullnameUsers = await filterDisallowedFullnames(fullnameUsers);

		// Merge results, filter duplicates (from username search, leave fullname results)
		users = users.filter(userObj => fullnameUsers.filter(userObj2 => userObj.uid === userObj2.uid).length === 0).concat(fullnameUsers);
	}

	if (Mentions._settings.privilegedDirectReplies !== 'on') {
		return users;
	}

	if (data.composerObj) {
		const cid = Topics.getTopicField(data.composerObj.tid, 'cid');
		const filteredUids = await filterPrivilegedUids(users.map(userObj => userObj.uid), cid, data.composerObj.toPid);

		users = users.filter(userObj => filteredUids.includes(userObj.uid));
	}

	return users;
};

module.exports = Mentions;
