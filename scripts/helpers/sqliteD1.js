'use strict';
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

/** Real SQLite execution with D1's small prepare/bind/batch interface. No network. */
async function sqliteD1() {
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.run(fs.readFileSync(path.join(__dirname, '../../cloudflare/schema.sql'), 'utf8'));
  const binding = {
    prepare(sql) {
      return { bind: (...params) => {
        const query = () => {
          const statement = database.prepare(sql);
          try {
            statement.bind(params);
            const rows = [];
            while (statement.step()) rows.push(statement.getAsObject());
            return rows;
          } finally { statement.free(); }
        };
        return {
          all: async () => ({ results: query() }),
          first: async () => query()[0] || null,
          run: async () => {
            query();
            return { meta: { changes: database.getRowsModified(), last_row_id: database.exec('SELECT last_insert_rowid()')[0].values[0][0] } };
          },
        };
      } };
    },
    async batch(statements) {
      database.run('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.run('COMMIT');
        return results;
      } catch (error) { database.run('ROLLBACK'); throw error; }
    },
  };
  return { database, binding };
}
module.exports = { sqliteD1 };
