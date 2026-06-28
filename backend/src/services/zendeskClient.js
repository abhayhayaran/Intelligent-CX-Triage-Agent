import { dbService } from './database.js';

const getEnvCredentials = () => {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL;
  const token = process.env.ZENDESK_API_TOKEN;

  if (subdomain && email && token) {
    return { subdomain, email, token };
  }
  return null;
};

const makeZendeskRequest = async (credentials, path, options = {}) => {
  const { subdomain, email, token } = credentials;
  const url = `https://${subdomain}.zendesk.com${path}`;
  
  const authHeader = 'Basic ' + Buffer.from(`${email}/token:${token}`).toString('base64');
  
  const headers = {
    'Authorization': authHeader,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Zendesk API Error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.json();
};

export const zendeskClient = {
  /**
   * Checks if the client is currently in "Real Zendesk API" mode.
   */
  isRealMode() {
    return getEnvCredentials() !== null;
  },

  /**
   * Search knowledge base / help center articles
   */
  async searchKnowledgeBase(queryText) {
    const credentials = getEnvCredentials();
    
    if (credentials) {
      console.log(`[Zendesk API] Searching Zendesk Knowledge Base for: "${queryText}"`);
      const path = `/api/v2/help_center/articles/search.json?query=${encodeURIComponent(queryText)}`;
      const data = await makeZendeskRequest(credentials, path);
      // Format response to look uniform
      return data.results.map(article => ({
        id: article.id,
        title: article.title,
        body: article.body || article.snippet,
        category: 'zendesk-kb'
      }));
    } else {
      console.log(`[Zendesk MOCK] Querying local database for: "${queryText}"`);
      // Search mock database using simple LIKE search
      const sql = 'SELECT * FROM kb_articles WHERE title LIKE ? OR body LIKE ?';
      const term = `%${queryText}%`;
      return dbService.query(sql, [term, term]);
    }
  },

  /**
   * Create a new ticket
   */
  async createTicket({ subject, description, priority, tags }) {
    const credentials = getEnvCredentials();

    if (credentials) {
      console.log(`[Zendesk API] Creating real ticket in Zendesk`);
      const path = '/api/v2/tickets.json';
      const body = {
        ticket: {
          subject,
          comment: { body: description },
          priority,
          tags: Array.isArray(tags) ? tags : JSON.parse(tags || '[]')
        }
      };

      const result = await makeZendeskRequest(credentials, path, {
        method: 'POST',
        body: JSON.stringify(body)
      });

      return {
        id: result.ticket.id,
        subject: result.ticket.subject,
        description: description,
        priority: result.ticket.priority,
        status: result.ticket.status,
        tags: JSON.stringify(result.ticket.tags),
        created_at: result.ticket.created_at
      };
    } else {
      console.log(`[Zendesk MOCK] Creating mock ticket in local database`);
      // Insert mock ticket into local SQLite DB
      const tagsStr = typeof tags === 'string' ? tags : JSON.stringify(tags || []);
      const sql = `
        INSERT INTO tickets (subject, description, priority, tags, status)
        VALUES (?, ?, ?, ?, 'new')
      `;
      const result = dbService.run(sql, [subject, description, priority, tagsStr]);
      
      return {
        id: result.lastInsertRowid,
        subject,
        description,
        priority,
        status: 'new',
        tags: tagsStr,
        created_at: new Date().toISOString()
      };
    }
  },

  /**
   * Fetch details of a single ticket (used by the ZAF frontend app)
   */
  async getTicket(ticketId) {
    const credentials = getEnvCredentials();

    if (credentials) {
      console.log(`[Zendesk API] Fetching ticket details for ID: ${ticketId}`);
      const path = `/api/v2/tickets/${ticketId}.json`;
      const result = await makeZendeskRequest(credentials, path);
      return {
        id: result.ticket.id,
        subject: result.ticket.subject,
        description: result.ticket.description || '',
        priority: result.ticket.priority,
        status: result.ticket.status,
        tags: JSON.stringify(result.ticket.tags)
      };
    } else {
      console.log(`[Zendesk MOCK] Querying SQLite for ticket ID: ${ticketId}`);
      const ticket = dbService.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
      if (!ticket) {
        throw new Error(`Ticket with ID ${ticketId} not found in mock database.`);
      }
      return ticket;
    }
  },

  /**
   * Save a drafted response for a ticket.
   * Drafts are always cached locally so they can be retrieved by the sidebar app.
   */
  async saveDraftResponse(ticketId, { draftBody, confidenceScore, suggestedTags }) {
    console.log(`[DB] Saving agent draft response for Ticket ID: ${ticketId}`);
    
    // Check if the ticket exists (if mock mode)
    if (!this.isRealMode()) {
      const ticket = dbService.get('SELECT id FROM tickets WHERE id = ?', [ticketId]);
      if (!ticket) {
        throw new Error(`Cannot save draft: Ticket ID ${ticketId} does not exist in local DB.`);
      }
    }

    const tagsStr = typeof suggestedTags === 'string' ? suggestedTags : JSON.stringify(suggestedTags || []);

    const sql = `
      INSERT INTO draft_responses (ticket_id, draft_body, confidence_score, suggested_tags)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ticket_id) DO UPDATE SET
        draft_body = excluded.draft_body,
        confidence_score = excluded.confidence_score,
        suggested_tags = excluded.suggested_tags,
        created_at = CURRENT_TIMESTAMP
    `;
    
    dbService.run(sql, [ticketId, draftBody, confidenceScore, tagsStr]);

    return {
      ticket_id: ticketId,
      draft_body: draftBody,
      confidence_score: confidenceScore,
      suggested_tags: tagsStr
    };
  },

  /**
   * Get draft response for a ticket (used by the ZAF app)
   */
  async getDraftResponse(ticketId) {
    console.log(`[DB] Fetching agent draft response for Ticket ID: ${ticketId}`);
    const draft = dbService.get('SELECT * FROM draft_responses WHERE ticket_id = ?', [ticketId]);
    return draft || null;
  }
};
