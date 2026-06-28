import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Force NODE_ENV to 'test' before loading services
process.env.NODE_ENV = 'test';

import { dbService } from './database.js';
import { triageService } from './triageService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testDbPath = path.resolve(__dirname, '../../data/test.db.json');

describe('Database System Tests (Transactions & Constraints)', () => {
  beforeEach(() => {
    // Bootstrap clean schema inside test.db.json
    dbService.bootstrapCleanDatabase();
  });

  afterEach(() => {
    // Delete test.db.json file to keep workspaces clean
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch (err) {
        // Silently skip if open
      }
    }
  });

  it('should successfully commit data changes during standard transactions', () => {
    let result;
    dbService.transaction(() => {
      result = dbService.run(
        'INSERT INTO tickets (subject, description, priority, tags) VALUES (?, ?, ?, ?)',
        ['Test Subject', 'Test Desc', 'normal', '[]']
      );
    })(); // Invoke the curried transaction wrapper

    const ticket = dbService.get('SELECT * FROM tickets WHERE id = ?', [result.lastInsertRowid]);
    expect(ticket).not.toBeNull();
    expect(ticket.subject).toBe('Test Subject');
  });

  it('should completely roll back database changes if an error is thrown within a transaction', () => {
    try {
      dbService.transaction(() => {
        dbService.run(
          'INSERT INTO tickets (subject, description, priority, tags) VALUES (?, ?, ?, ?)',
          ['Rollback Subject', 'Test Desc', 'normal', '[]']
        );
        // Force transaction failure
        throw new Error('Forced simulation crash');
      })(); // Invoke the curried transaction wrapper
    } catch (err) {
      expect(err.message).toBe('Forced simulation crash');
    }

    const ticket = dbService.get('SELECT * FROM tickets WHERE id = ?', [1]);
    expect(ticket).toBeNull(); // Reverted back to null
  });

  it('should enforce UNIQUE constraint on duplicate idempotency keys', () => {
    dbService.run(
      'INSERT INTO idempotency_keys (key, status, response_body) VALUES (?, ?, ?)',
      ['key123', 'completed', '{}']
    );

    // Attempting duplicate insert should trigger relational UNIQUE check error
    expect(() => {
      dbService.run(
        'INSERT INTO idempotency_keys (key, status, response_body) VALUES (?, ?, ?)',
        ['key123', 'pending', '{}']
      );
    }).toThrow(/UNIQUE constraint failed/);
  });
});

describe('AI Triage Pipeline & Idempotency Engine', () => {
  beforeEach(() => {
    dbService.bootstrapCleanDatabase();
    // Enforce mock mode during tests by clearing API credentials
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ZENDESK_API_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch (err) {}
    }
  });

  it('should execute mock triage pipeline and generate ticket & draft when credentials are empty', async () => {
    const requestId = 'req-triage-test-1';
    const customerQuery = 'My domain connection has been dropping frequently since yesterday.';
    const progressLogs = [];

    const result = await triageService.processTriage(
      requestId,
      customerQuery,
      (evt) => progressLogs.push(evt)
    );

    // 1. Validate progress messages sequence
    expect(progressLogs.length).toBeGreaterThanOrEqual(4);
    expect(progressLogs[0].type).toBe('info');
    expect(progressLogs[0].message).toContain('Simulated Claude Agent');

    const toolStarts = progressLogs.filter(e => e.type === 'tool_start');
    expect(toolStarts.length).toBe(3); // search, ticket, draft

    // 2. Validate ticket database record creation
    const ticket = dbService.get('SELECT * FROM tickets WHERE id = ?', [result.ticket.id]);
    expect(ticket).not.toBeNull();
    expect(ticket.tags).toContain('technical'); // Category should resolve to technical and populate the tags array
    expect(ticket.priority).toBe('normal');

    // 3. Validate draft response generation
    const draft = dbService.get('SELECT * FROM draft_responses WHERE ticket_id = ?', [result.ticket.id]);
    expect(draft).not.toBeNull();
    expect(draft.draft_body).toContain('technical');
  });

  it('should serve cached response immediately and skip execution loop on duplicate requestId (Idempotency)', async () => {
    const requestId = 'req-triage-idempotency-2';
    const customerQuery = 'Help me reset my login password.';

    // First execution
    const firstResult = await triageService.processTriage(requestId, customerQuery, () => {});
    
    // Second execution with identical requestId
    const progressLogs = [];
    const secondResult = await triageService.processTriage(
      requestId,
      customerQuery,
      (evt) => progressLogs.push(evt)
    );

    // 1. Results should be identical
    expect(secondResult.ticket.id).toBe(firstResult.ticket.id);

    // 2. Progress event should notify that cache was served and avoid agent runs
    expect(progressLogs).toHaveLength(1);
    expect(progressLogs[0].type).toBe('info');
    expect(progressLogs[0].message).toContain('Idempotency hit');
  });
});
