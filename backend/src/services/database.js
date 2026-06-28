import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, process.env.NODE_ENV === 'test' ? 'test.db.json' : 'production.db.json');

// Ensure database directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory relational database state
let dbState = {
  idempotency_keys: [],
  tickets: [],
  kb_articles: [],
  draft_responses: []
};

// Seed initial mock Help Center articles
const seedKBArticles = [
  { id: 1, title: 'Billing & Refund Policy', body: 'We offer full refunds for cancellations within 14 days of purchase. Refunds take 5-7 business days to process back to your original payment method. For cancellations after 14 days, we provide pro-rated account credits instead of cash refunds.', category: 'billing' },
  { id: 2, title: 'Connecting your Custom Domain', body: 'To connect a custom domain: 1. Go to Settings > Domains. 2. Enter your domain. 3. Add an A record pointing to 192.0.2.1 and a CNAME record for www pointing to domains.example.com. DNS propagation can take up to 24 hours.', category: 'technical' },
  { id: 3, title: 'Resetting Account Password', body: 'If you forgot your password, click "Forgot Password" on the login screen. You will receive an email with a secure link to reset it. Reset links expire after 2 hours. If you do not see the email, check your spam folder.', category: 'account' },
  { id: 4, title: 'API Access and Token Limits', body: 'API access tokens can be created under Settings > API. We enforce a rate limit of 100 requests per minute per token. If you exceed this rate, you will receive a 429 Too Many Requests response. For high-volume needs, contact sales.', category: 'technical' },
  { id: 5, title: 'Updating Payment Method', body: 'To update your credit card or payment details: 1. Go to Billing > Payment Methods. 2. Click "Add Card" or "Edit". 3. Update your details and click Save. All billing transactions are securely handled through Stripe with 256-bit encryption.', category: 'billing' }
];

// Load database from disk or bootstrap seed data
const loadDatabase = () => {
  if (fs.existsSync(DB_PATH)) {
    try {
      const fileData = fs.readFileSync(DB_PATH, 'utf8');
      dbState = JSON.parse(fileData);
      console.log(`[Database] Loaded local JSON DB containing: 
  - ${dbState.idempotency_keys.length} idempotency keys
  - ${dbState.tickets.length} tickets
  - ${dbState.kb_articles.length} Help Center articles
  - ${dbState.draft_responses.length} response drafts`);
    } catch (err) {
      console.error('[Database] Failed to read production.db.json. Initializing clean state:', err);
      bootstrapCleanDatabase();
    }
  } else {
    bootstrapCleanDatabase();
  }
};

const bootstrapCleanDatabase = () => {
  dbState = {
    idempotency_keys: [],
    tickets: [],
    kb_articles: seedKBArticles,
    draft_responses: []
  };
  saveDatabaseToDisk();
  console.log('[Database] Initialized new JSON DB with seeded Help Center articles.');
};

const saveDatabaseToDisk = () => {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(dbState, null, 2), 'utf8');
  } catch (err) {
    console.error('[Database] Failed to write DB to disk:', err);
  }
};

// Load database on start
loadDatabase();

export const dbService = {
  bootstrapCleanDatabase,
  /**
   * Run a query that returns multiple rows
   */
  query(sql, params = []) {
    const cleanSql = sql.replace(/\s+/g, ' ').trim();
    
    // Pattern: SELECT * FROM kb_articles WHERE title LIKE ? OR body LIKE ?
    if (cleanSql.includes('FROM kb_articles') && cleanSql.includes('LIKE')) {
      const searchTerm = params[0] ? params[0].replace(/%/g, '').toLowerCase() : '';
      return dbState.kb_articles.filter(article => 
        article.title.toLowerCase().includes(searchTerm) || 
        article.body.toLowerCase().includes(searchTerm)
      );
    }
    
    // Pattern: SELECT * FROM tickets ORDER BY id DESC
    if (cleanSql.includes('FROM tickets') && cleanSql.includes('ORDER BY id DESC')) {
      return [...dbState.tickets].sort((a, b) => b.id - a.id);
    }

    console.warn(`[Database] Query fallback for unmapped SQL: "${sql}"`);
    return [];
  },

  /**
   * Run a query that returns a single row
   */
  get(sql, params = []) {
    const cleanSql = sql.replace(/\s+/g, ' ').trim();

    // Pattern: SELECT * FROM idempotency_keys WHERE key = ?
    if (cleanSql.includes('FROM idempotency_keys WHERE key = ?')) {
      const key = params[0];
      return dbState.idempotency_keys.find(k => k.key === key) || null;
    }

    // Pattern: SELECT * FROM tickets WHERE id = ?
    if (cleanSql.includes('FROM tickets WHERE id = ?')) {
      const id = Number(params[0]);
      return dbState.tickets.find(t => t.id === id) || null;
    }

    // Pattern: SELECT * FROM draft_responses WHERE ticket_id = ?
    if (cleanSql.includes('FROM draft_responses WHERE ticket_id = ?')) {
      const ticketId = Number(params[0]);
      return dbState.draft_responses.find(d => d.ticket_id === ticketId) || null;
    }

    console.warn(`[Database] Get fallback for unmapped SQL: "${sql}"`);
    return null;
  },

  /**
   * Execute an INSERT, UPDATE, or DELETE statement
   */
  run(sql, params = []) {
    const cleanSql = sql.replace(/\s+/g, ' ').trim();

    // Pattern: INSERT INTO idempotency_keys (key, status) VALUES (?, ?)
    if (cleanSql.startsWith('INSERT INTO idempotency_keys')) {
      const [key, status] = params;
      
      // UNIQUE CONSTRAINT enforcement
      const existing = dbState.idempotency_keys.find(k => k.key === key);
      if (existing) {
        throw new Error(`UNIQUE constraint failed: idempotency_keys.key (${key} already exists)`);
      }

      dbState.idempotency_keys.push({
        key,
        status,
        response_payload: null,
        created_at: new Date().toISOString()
      });
      
      saveDatabaseToDisk();
      return { lastInsertRowid: key, changes: 1 };
    }

    // Pattern: UPDATE idempotency_keys SET status = ? WHERE key = ?
    if (cleanSql.startsWith('UPDATE idempotency_keys SET status = ? WHERE key = ?')) {
      const [status, key] = params;
      const index = dbState.idempotency_keys.findIndex(k => k.key === key);
      if (index !== -1) {
        dbState.idempotency_keys[index].status = status;
        saveDatabaseToDisk();
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    // Pattern: UPDATE idempotency_keys SET status = ?, response_payload = ? WHERE key = ?
    if (cleanSql.startsWith('UPDATE idempotency_keys SET status = ?, response_payload = ? WHERE key = ?')) {
      const [status, payload, key] = params;
      const index = dbState.idempotency_keys.findIndex(k => k.key === key);
      if (index !== -1) {
        dbState.idempotency_keys[index].status = status;
        dbState.idempotency_keys[index].response_payload = payload;
        saveDatabaseToDisk();
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    // Pattern: UPDATE idempotency_keys SET status = ? WHERE key = ? (for reset/retry)
    if (cleanSql.startsWith('UPDATE idempotency_keys SET status = ? WHERE key = ?')) {
      const [status, key] = params;
      const index = dbState.idempotency_keys.findIndex(k => k.key === key);
      if (index !== -1) {
        dbState.idempotency_keys[index].status = status;
        saveDatabaseToDisk();
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    // Pattern: INSERT INTO tickets (subject, description, priority, tags, status) VALUES (?, ?, ?, ?, 'new')
    if (cleanSql.startsWith('INSERT INTO tickets')) {
      const [subject, description, priority, tags] = params;
      const nextId = dbState.tickets.length > 0 ? Math.max(...dbState.tickets.map(t => t.id)) + 1 : 1;

      const newTicket = {
        id: nextId,
        subject,
        description,
        priority,
        status: 'new',
        tags,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      dbState.tickets.push(newTicket);
      saveDatabaseToDisk();
      return { lastInsertRowid: nextId, changes: 1 };
    }

    // Pattern: INSERT INTO draft_responses (ticket_id, draft_body, confidence_score, suggested_tags) VALUES (?, ?, ?, ?) ON CONFLICT ...
    if (cleanSql.startsWith('INSERT INTO draft_responses')) {
      const [ticketId, draftBody, confidenceScore, suggestedTags] = params;
      const index = dbState.draft_responses.findIndex(d => d.ticket_id === ticketId);

      const draftRecord = {
        ticket_id: ticketId,
        draft_body: draftBody,
        confidence_score: confidenceScore,
        suggested_tags: suggestedTags,
        created_at: new Date().toISOString()
      };

      if (index !== -1) {
        // ON CONFLICT DO UPDATE
        dbState.draft_responses[index] = draftRecord;
      } else {
        dbState.draft_responses.push(draftRecord);
      }

      saveDatabaseToDisk();
      return { changes: 1 };
    }

    console.warn(`[Database] Run fallback for unmapped SQL: "${sql}"`);
    return { changes: 0 };
  },

  /**
   * Execute statements inside a database transaction with clone/rollback safety
   */
  transaction(fn) {
    return () => {
      console.log('[Database] Transaction started. Creating database backup point...');
      // Deep clone current state for rollback backup
      const backupState = JSON.parse(JSON.stringify(dbState));
      
      try {
        const result = fn();
        console.log('[Database] Transaction executed successfully. Committing changes...');
        saveDatabaseToDisk();
        return result;
      } catch (err) {
        console.error('[Database] Transaction error occurred. Rolling back to backup point!', err.message);
        // Restore backup
        dbState = backupState;
        saveDatabaseToDisk();
        throw err; // Propagate error
      }
    };
  }
};
