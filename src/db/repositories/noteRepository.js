'use strict';

/**
 * Note repository: private moderator notes.
 *
 * Notes are never shown to the user they describe and never trigger a DM. They
 * are visible only to members holding a moderator role or higher.
 */

let gateway = null;

/** Bound by the data layer during initialisation. */
function attach(instance) {
  gateway = instance;
}

/**
 * Create a note.
 * @param {string} guildId
 * @param {{userId: string, authorId: string, content: string, caseNumber?: number}} data
 */
async function create(guildId, data) {
  return gateway.createNote(guildId, data);
}

/** List notes about a user. */
async function list(guildId, userId) {
  return gateway.listNotes(guildId, userId);
}

/** Soft-delete a note. */
async function remove(guildId, noteId) {
  return gateway.deleteNote(guildId, noteId);
}

module.exports = { attach, create, list, remove };
