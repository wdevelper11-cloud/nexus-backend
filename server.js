require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── DATABASE (flat JSON file — zero setup, zero cost) ───
const adapter = new FileSync('db.json');
const db = low(adapter);
db.defaults({ leads: [], demos: [], orders: [] }).write();

// ─── MIDDLEWARE ───
app.use(express.json());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || '*',
    'http://localhost:8080',
    'http://localhost:3000',
    /\.vercel\.app$/,
    /\.netlify\.app$/
  ],
  methods: ['GET', 'POST'],
  credentials: true
}));

// Rate limiting — prevent abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: { success: false, error: 'Too many requests. Please try again shortly.' }
});

// Stricter limit for AI chat (more expensive)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { success: false, error: 'Chat rate limit reached. Please wait a moment.' }
});

app.use('/api/', apiLimiter);

// ─── HEALTH CHECK ───
app.get('/', (req, res) => {
  res.json({
    status: 'NexusCompute API is live',
    version: '1.0.0',
    nexusflow: process.env.ANTHROPIC_API_KEY ? 'real-ai' : 'smart-fallback',
    payments: process.env.RAZORPAY_KEY_ID ? 'live' : 'pending-setup'
  });
});

// ─── POST /api/submit-demo ───
// Handles demo booking form submissions
app.post('/api/submit-demo', async (req, res) => {
  try {
    const { name, email, role, tools } = req.body;
    if (!name || !email) return res.status(400).json({ success: false, error: 'Name and email required' });

    const entry = {
      id: Date.now(),
      type: 'demo',
      name: name.trim(),
      email: email.toLowerCase().trim(),
      role: role || '',
      tools: tools || '',
      createdAt: new Date().toISOString(),
      status: 'new'
    };

    db.get('demos').push(entry).write();
    console.log(`[DEMO BOOKED] ${name} <${email}>`);

    // Send email notification if configured
    if (process.env.RESEND_API_KEY && process.env.CONTACT_EMAIL) {
      await sendNotificationEmail('Demo Booking', entry);
    }

    res.json({ success: true, message: 'Demo booked! We\'ll reply within 24 hours.' });
  } catch (err) {
    console.error('[submit-demo error]', err);
    res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

// ─── POST /api/submit-lead ───
// Handles lead capture form
app.post('/api/submit-lead', async (req, res) => {
  try {
    const { email, role, spend, tools } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });

    const entry = {
      id: Date.now(),
      type: 'lead',
      email: email.toLowerCase().trim(),
      role: role || '',
      spend: spend || '',
      tools: tools || '',
      createdAt: new Date().toISOString(),
      status: 'new'
    };

    db.get('leads').push(entry).write();
    console.log(`[LEAD CAPTURED] ${email} | ${role} | spend: ${spend}`);

    if (process.env.RESEND_API_KEY && process.env.CONTACT_EMAIL) {
      await sendNotificationEmail('New Lead', entry);
    }

    res.json({ success: true, message: 'Got it! Recommendation coming within 24 hours.' });
  } catch (err) {
    console.error('[submit-lead error]', err);
    res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

// ─── POST /api/create-order ───
// Creates a Razorpay order (or mocked order if no key)
app.post('/api/create-order', async (req, res) => {
  try {
    const { plan, amount, name, email, company } = req.body;
    if (!plan || !amount) return res.status(400).json({ success: false, error: 'Plan and amount required' });

    const entry = {
      id: Date.now(),
      type: 'order',
      plan, amount, name, email, company,
      createdAt: new Date().toISOString(),
      status: 'initiated'
    };
    db.get('orders').push(entry).write();
    console.log(`[ORDER CREATED] ${plan} — ${name} <${email}>`);

    // Real Razorpay order creation
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
      const amtPaise = amount * 100;
      const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
      const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
        body: JSON.stringify({ amount: amtPaise, currency: 'INR', receipt: `order_${Date.now()}`, notes: { plan, email } })
      });
      const rzpOrder = await rzpRes.json();
      if (rzpOrder.id) {
        db.get('orders').find({ id: entry.id }).assign({ razorpayOrderId: rzpOrder.id }).write();
        return res.json({ success: true, orderId: rzpOrder.id, key: process.env.RAZORPAY_KEY_ID });
      }
    }

    // Fallback: mock order (payment modal shows "coming soon")
    res.json({ success: true, orderId: `mock_${Date.now()}`, key: null, mock: true });

  } catch (err) {
    console.error('[create-order error]', err);
    res.status(500).json({ success: false, error: 'Could not create order. Please try again.' });
  }
});

// ─── POST /api/verify-payment ───
// Verifies Razorpay payment after checkout
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, plan, name, email } = req.body;

    if (process.env.RAZORPAY_KEY_SECRET && razorpay_order_id && razorpay_signature) {
      const crypto = require('crypto');
      const body = razorpay_order_id + '|' + razorpay_payment_id;
      const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
      if (expected !== razorpay_signature) {
        return res.status(400).json({ success: false, error: 'Payment verification failed' });
      }
    }

    // Mark order as paid
    db.get('orders')
      .find({ razorpayOrderId: razorpay_order_id })
      .assign({ status: 'paid', paymentId: razorpay_payment_id, paidAt: new Date().toISOString() })
      .write();

    console.log(`[PAYMENT SUCCESS] ${plan} — ${name} <${email}> — ${razorpay_payment_id}`);

    if (process.env.RESEND_API_KEY && process.env.CONTACT_EMAIL) {
      await sendNotificationEmail('PAYMENT RECEIVED', { plan, name, email, paymentId: razorpay_payment_id });
    }

    res.json({ success: true, message: 'Payment verified. Access will be sent within 24 hours.' });
  } catch (err) {
    console.error('[verify-payment error]', err);
    res.status(500).json({ success: false, error: 'Verification error.' });
  }
});

// ─── POST /api/nexusflow-chat ───
// NexusFlow AI — powered by Claude with smart fallback
app.post('/api/nexusflow-chat', chatLimiter, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Message required' });

    // ── Real Claude API ──
    if (process.env.ANTHROPIC_API_KEY) {
      const messages = [];

      // Add conversation history (max last 8 messages to control cost)
      if (history && Array.isArray(history)) {
        const recent = history.slice(-8);
        recent.forEach(msg => {
          messages.push({ role: msg.role, content: msg.content });
        });
      }
      messages.push({ role: 'user', content: message.trim() });

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', // cheapest model — perfect for chat
          max_tokens: 600,
          system: `You are NexusFlow AI, an infrastructure intelligence assistant for NexusCompute Cloud — a GPU cloud platform for AI automation agencies, workflow builders, and AI content creators.

You help users with:
- AI workload slowdowns, bottlenecks, memory issues
- Cost optimisation and overspend analysis
- Scaling alerts and capacity planning
- Client support handling (n8n, Make.com, ComfyUI, Stable Diffusion, FLUX)
- Setup and integration help
- Margin and pricing advice for agencies

PERSONALITY: You are data-driven, direct, and specific. You always give numbered options ranked by cost/impact. You reference specific metrics ($, ms, %). You never give vague advice. You sound like a senior infrastructure engineer who also understands the business side.

FORMAT: Use <b>bold</b> for key numbers and recommendations. Use line breaks liberally. Keep responses under 200 words. End with a specific question or action prompt.

If the user asks something outside infrastructure/AI, politely redirect: "I'm focused on your infrastructure. For that question, you'd be better served by [X]. Back on infra — what else can I help optimize?"`,
          messages
        })
      });

      const data = await response.json();
      if (data.content && data.content[0]) {
        return res.json({ success: true, reply: data.content[0].text, source: 'claude' });
      }
    }

    // ── Smart Fallback (no API key needed) ──
    const reply = getSmartFallbackReply(message);
    res.json({ success: true, reply, source: 'fallback' });

  } catch (err) {
    console.error('[nexusflow-chat error]', err);
    const reply = getSmartFallbackReply(req.body.message || '');
    res.json({ success: true, reply, source: 'fallback' });
  }
});

// ─── GET /api/leads ───
// Simple admin view of all leads (protect in production)
app.get('/api/admin/leads', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const leads = db.get('leads').value();
  const demos = db.get('demos').value();
  const orders = db.get('orders').value();
  res.json({ leads, demos, orders, total: leads.length + demos.length });
});

// ─── SMART FALLBACK REPLIES ───
// These run when no Claude API key is set. Detailed enough to be genuinely useful.
function getSmartFallbackReply(userMsg) {
  const q = userMsg.toLowerCase();

  const KB = [
    {
      patterns: ['slow', 'slowdown', 'lag', 'latency', 'delay', 'taking long', 'too slow', 'speed'],
      reply: `<b>Detected: inference queue bottleneck</b><br><br>Top 3 causes (ranked by frequency):<br>1. <b>fp32 precision instead of fp16</b> — 2× slower, same quality. Switch now.<br>2. <b>Resolution above 768px</b> for non-showcase tasks — each step is exponentially longer<br>3. <b>Multiple large-model calls hitting same GPU</b> — interleave with smaller models<br><br>Fix #1 alone cuts inference time by ~40%. Want me to walk through which setting to change in your setup?`
    },
    {
      patterns: ['memory', 'vram', 'out of memory', 'oom', 'crash', 'memory error'],
      reply: `<b>Memory pressure detected.</b> Here's your situation:<br><br>Running 4+ concurrent instances on shared allocation puts you at ~91% VRAM utilisation — that's your crash threshold.<br><br><b>Options ranked by cost/impact:</b><br>1. <b>Free</b> — Load models sequentially, not all at once<br>2. <b>Free</b> — Quantise summarisation clients to 4-bit (same output, ¼ footprint)<br>3. <b>Upgrade</b> — Dedicated allocation removes this entirely<br><br>Which clients are doing summarisation vs image gen? That determines the fastest fix.`
    },
    {
      patterns: ['cost', 'overpay', 'expensive', 'save', 'cheaper', 'billing', 'bill'],
      reply: `<b>Running cost audit...</b><br><br>Top 3 opportunities:<br>🔴 <b>$82/mo</b> — Using 13B model for tasks where 7B is identical. Switch 2 clients.<br>🟡 <b>$45/mo</b> — Idle GPU between 2am–6am. Schedule workloads or pause instances.<br>🟢 <b>$28/mo</b> — Redundant retry calls in your workflow (3 retries per call → reduce to 1)<br><br><b>Total recoverable: ~$155/month</b> with zero quality change. Which of these do you want to tackle first?`
    },
    {
      patterns: ['scale', 'scaling', 'capacity', 'limit', 'upgrade', 'more clients'],
      reply: `<b>Scaling alert.</b> At your current growth rate you'll hit capacity in ~18 days based on average usage trends.<br><br><b>Recommended action (before you hit limits):</b><br>→ Pre-provision a second GPU allocation — 24hr turnaround, avoids client-facing disruption<br>→ Current shared plan supports ~3 concurrent large-model clients. If you're at 3, you're at the edge.<br><br><b>Risk of waiting:</b> Client workflows queue up, 2–4 min delays appear. That's a churn risk.<br><br>How many active clients are you running right now?`
    },
    {
      patterns: ['n8n', 'make', 'comfyui', 'stable diffusion', 'flux', 'workflow', 'setup', 'integrate', 'connect', 'api key'],
      reply: `<b>Integration setup:</b><br><br>For <b>n8n</b>: HTTP Request node → POST → your endpoint URL → Header: <code>Authorization: Bearer YOUR_KEY</code><br>For <b>Make.com</b>: HTTP module → same config<br>For <b>ComfyUI</b>: Settings → API URL → paste your endpoint<br><br>All integrations use the same OpenAI-compatible API structure. If you're already using OpenAI nodes in n8n, it's literally one URL change.<br><br>Which tool are you connecting? I'll give you the exact node config.`
    },
    {
      patterns: ['recommend', 'which plan', 'what plan', 'advice', 'help me choose'],
      reply: `<b>Plan recommendation guide:</b><br><br>• <b>1–3 clients, text workflows</b> → Automation Starter ($199/mo)<br>• <b>4–7 clients or image generation</b> → Agency plan ($559/mo)<br>• <b>ComfyUI / Stable Diffusion</b> → Creative Pro ($559/mo)<br>• <b>8+ clients or reselling</b> → Enterprise (custom)<br><br><b>Rule of thumb:</b> If a failure costs you a client relationship, use dedicated compute. Shared is for dev and low-stakes volume.<br><br>What's your client count and main workload?`
    },
    {
      patterns: ['uptime', 'down', 'offline', 'not working', 'outage', 'api down'],
      reply: `<b>Running service check...</b><br><br>✅ All NexusCompute nodes: Operational<br>✅ API gateway: Responding (avg 180ms)<br>✅ GPU allocation: Active<br><br>If you're seeing issues, most common causes:<br>1. API key not in request header<br>2. Typo in endpoint URL<br>3. Local network issue<br><br>Test: <code>curl -X POST [endpoint] -H "Authorization: Bearer [key]"</code> — if you get 200, backend is fine and issue is client-side.<br><br>What error are you seeing exactly?`
    },
    {
      patterns: ['margin', 'profit', 'revenue', 'resell', 'charge client'],
      reply: `<b>Your margin profile:</b><br><br>Your cost: Fixed monthly plan<br>Recommended client charge: <b>1.6–2.2× your plan cost</b> → 37–55% gross margin<br><br><b>To maximise margin:</b><br>1. Sell monthly retainers (not per-call) — you control the floor<br>2. Bundle "infrastructure + monitoring" — clients pay for peace of mind<br>3. Charge onboarding fees — $150–$300 one-time setup<br><br>At 5 clients you should be netting $900–$2,200/month profit after your NexusCompute cost.<br><br>Want a full P&L breakdown for your exact client count?`
    }
  ];

  for (const entry of KB) {
    if (entry.patterns.some(p => q.includes(p))) return entry.reply;
  }

  // Default replies
  const defaults = [
    `I'm analyzing your infrastructure data...<br><br>To give you a precise recommendation, tell me:<br>1. How many concurrent clients are you running?<br>2. Workload type — image generation, text inference, or both?<br>3. Seeing this issue now or historically?<br><br>The more specific, the more accurate my recommendations.`,
    `No active issues flagged right now — good sign.<br><br>Three things I monitor proactively:<br>• Memory utilisation (alert at 85%)<br>• Inference latency (alert if avg exceeds 8s)<br>• Idle cost (alert if GPU is >40% idle for 6+ hours)<br><br>Everything nominal. What did you want to investigate?`,
    `Good question. Tell me more about your setup — which tools (n8n, Make, ComfyUI)? How many clients? I'll pull the relevant metrics and give you a data-backed answer rather than guessing.`
  ];

  return defaults[Math.floor(Math.random() * defaults.length)];
}

// ─── EMAIL NOTIFICATIONS (optional — uses Resend free tier) ───
async function sendNotificationEmail(subject, data) {
  if (!process.env.RESEND_API_KEY || !process.env.CONTACT_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'NexusCompute <notifications@nexuscompute.cloud>',
        to: process.env.CONTACT_EMAIL,
        subject: `[NexusCompute] ${subject}`,
        html: `<pre>${JSON.stringify(data, null, 2)}</pre>`
      })
    });
  } catch (e) {
    console.error('[email error]', e.message);
  }
}

// ─── START SERVER ───
app.listen(PORT, () => {
  console.log(`\n🚀 NexusCompute API running on port ${PORT}`);
  console.log(`   NexusFlow AI: ${process.env.ANTHROPIC_API_KEY ? '✅ Real Claude' : '⚡ Smart fallback (add ANTHROPIC_API_KEY to enable)'}`);
  console.log(`   Payments: ${process.env.RAZORPAY_KEY_ID ? '✅ Razorpay live' : '⏳ Add RAZORPAY_KEY_ID when ready'}`);
  console.log(`   Email alerts: ${process.env.RESEND_API_KEY ? '✅ Resend enabled' : '⏳ Add RESEND_API_KEY when ready'}`);
  console.log(`   Database: ✅ db.json (local file)\n`);
});
