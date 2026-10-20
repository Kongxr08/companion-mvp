import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  userId: text('user_id').primaryKey(),
  settings: text('settings').notNull(), mood: text('mood').notNull(),
  revision: integer('revision').notNull().default(0),
  contextFloor: integer('context_floor').notNull().default(0),
  lastUserAt: real('last_user_at').notNull(), lastIdleAt: real('last_idle_at').notNull().default(0),
  updatedAt: real('updated_at').notNull(),
});
export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }), userId: text('user_id').notNull(),
  role: text('role').notNull(), content: text('content').notNull(),
  kind: text('kind').notNull().default('chat'), eventKey: text('event_key').notNull(),
  createdAt: real('created_at').notNull(),
}, t => [index('messages_user_id').on(t.userId,t.id),uniqueIndex('messages_event').on(t.userId,t.eventKey)]);
export const memories = sqliteTable('memories', {
  id: integer('id').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),
  category:text('category').notNull(),slot:text('slot').notNull(),content:text('content').notNull(),
  sourceId:integer('source_id'),evidence:text('evidence').notNull().default(''),origin:text('origin').notNull(),
  createdAt:real('created_at').notNull(),updatedAt:real('updated_at').notNull(),
}, t => [uniqueIndex('memories_slot').on(t.userId,t.category,t.slot),index('memories_user').on(t.userId,t.updatedAt)]);
export const tasks = sqliteTable('tasks', {
  id:integer('id').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),title:text('title').notNull(),
  dueAt:real('due_at').notNull(),status:text('status').notNull().default('pending'),createdAt:real('created_at').notNull(),
  deliveredAt:real('delivered_at'),messageId:integer('message_id'),error:text('error').notNull().default(''),
},t=>[index('tasks_user').on(t.userId,t.dueAt)]);
export const requests=sqliteTable('requests',{
  userId:text('user_id').notNull(),token:text('token').notNull(),bodyHash:text('body_hash').notNull(),
  reply:text('reply').notNull(),createdAt:real('created_at').notNull(),
},t=>[primaryKey({columns:[t.userId,t.token]})]);
// An atomic batch fails in full if the state read before a model call is stale.
// Guard rows are inserted and removed within the same batch, never used as sessions.
export const mutationGuards=sqliteTable('mutation_guards',{
  operation:text('operation').primaryKey(),expected:integer('expected').notNull(),actual:integer('actual').notNull(),
},t=>[check('current_revision',sql`${t.expected} = ${t.actual}`)]);
