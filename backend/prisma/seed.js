import { prisma } from '../src/services/database.js';

const seedKBArticles = [
  { 
    title: 'Billing & Refund Policy', 
    body: 'We offer full refunds for cancellations within 14 days of purchase. Refunds take 5-7 business days to process back to your original payment method. For cancellations after 14 days, we provide pro-rated account credits instead of cash refunds.', 
    category: 'billing' 
  },
  { 
    title: 'Connecting your Custom Domain', 
    body: 'To connect a custom domain: 1. Go to Settings > Domains. 2. Enter your domain. 3. Add an A record pointing to 192.0.2.1 and a CNAME record for www pointing to domains.example.com. DNS propagation can take up to 24 hours.', 
    category: 'technical' 
  },
  { 
    title: 'Resetting Account Password', 
    body: 'If you forgot your password, click "Forgot Password" on the login screen. You will receive an email with a secure link to reset it. Reset links expire after 2 hours. If you do not see the email, check your spam folder.', 
    category: 'account' 
  },
  { 
    title: 'API Access and Token Limits', 
    body: 'API access tokens can be created under Settings > API. We enforce a rate limit of 100 requests per minute per token. If you exceed this rate, you will receive a 429 Too Many Requests response. For high-volume needs, contact sales.', 
    category: 'technical' 
  },
  { 
    title: 'Updating Payment Method', 
    body: 'To update your credit card or payment details: 1. Go to Billing > Payment Methods. 2. Click "Add Card" or "Edit". 3. Update your details and click Save. All billing transactions are securely handled through Stripe with 256-bit encryption.', 
    category: 'billing' 
  }
];

async function main() {
  console.log('🌱 Starting database seeding...');
  
  const count = await prisma.kBArticle.count();
  if (count > 0) {
    console.log('⚠️ kb_articles table already has data. Skipping seed to prevent duplicates.');
    return;
  }

  console.log(`📝 Inserting ${seedKBArticles.length} Help Center articles...`);
  for (const article of seedKBArticles) {
    await prisma.kBArticle.create({
      data: article
    });
  }
  
  console.log('✅ Database seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
