// server.js
const express = require('express');
const fetch = require('node-fetch'); // if Node >=18 you can use global fetch instead
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Allow cross-origin requests so browser fetch from your site to this domain works
app.use(cors({ origin: true }));

// === CONFIG: set these via environment variables ===
// Example: WEBHOOK_SECRET="MYSECRET123"
const PORT = process.env.PORT || 8080;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'replace_with_strong_secret';
const META_PIXEL_ID = process.env.META_PIXEL_ID || '';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE || '';
const GTM_SERVER_ENDPOINT = process.env.GTM_SERVER_ENDPOINT || ''; // optional

// Simple in-memory store (use Redis in production)
const mappingStore = new Map();

function sha256Lower(v){ if(!v) return ''; return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex'); }
function nowInSec(){ return Math.floor(Date.now()/1000); }

// POST /register_event  <-- called by browser (GTM client mapping)
app.post('/register_event', (req, res) => {
  try {
    const { appointment_id, event_id, client_id, utm, canonical, ts } = req.body || {};
    if (!appointment_id || !event_id) return res.status(400).json({ ok:false, error:'appointment_id & event_id required' });
    mappingStore.set(String(appointment_id), { event_id, client_id: client_id || null, utm: utm || null, canonical: canonical || null, ts: Date.now() });
    return res.json({ ok:true });
  } catch(e) {
    console.error('register_event error', e);
    return res.status(500).json({ ok:false });
  }
});

// POST /ghl-webhook  <-- called by GoHighLevel workflow
app.post('/ghl-webhook', async (req, res) => {
  try {
    const token = (req.headers['x-ghl-webhook-token'] || req.headers['authorization'] || '').toString();
    if (!token || token.indexOf(WEBHOOK_SECRET) === -1) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }

    const body = req.body || {};
    const appointment = body.appointment || body.booking || body;
    const contact = body.contact || body.customer || body.client || {};
    const appointment_id = appointment.id || appointment.bookingId || appointment.appointment_id || appointment.appointmentId || '';

    const stored = appointment_id ? (mappingStore.get(String(appointment_id)) || {}) : {};
    const event_id = stored.event_id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const client_id = stored.client_id || null;
    const canonical = stored.canonical || {};

    // hash PII
    const user_data = {};
    if (contact.email) user_data.em = sha256Lower(contact.email);
    if (contact.phone) user_data.ph = sha256Lower(contact.phone);
    if (contact.firstName || contact.first_name) user_data.fn = sha256Lower(contact.firstName || contact.first_name || '');
    if (contact.lastName || contact.last_name) user_data.ln = sha256Lower(contact.lastName || contact.last_name || '');

    // optional client_ip_address / ua
    if (req.headers['x-forwarded-for']) user_data.client_ip_address = req.headers['x-forwarded-for'].split(',')[0].trim();
    if (req.headers['user-agent']) user_data.client_user_agent = req.headers['user-agent'];

    const custom_data = {
      appointment_id: appointment_id || '',
      calendar_name: appointment.calendarName || appointment.calendar_name || '',
      appointment_start: appointment.startTime || appointment.start || '',
      utm_source: canonical.utm_source || '',
      utm_medium: canonical.utm_medium || '',
      utm_campaign: canonical.utm_campaign || '',
      utm_term: canonical.utm_term || '',
      utm_content: canonical.utm_content || '',
      gclid: (stored.utm && stored.utm.last_touch && stored.utm.last_touch.utm && stored.utm.last_touch.utm.gclid) || '',
      fbclid: (stored.utm && stored.utm.last_touch && stored.utm.last_touch.utm && stored.utm.last_touch.utm.fbclid) || ''
    };

    // Build Meta CAPI body
    const metaBody = {
      data: [{
        event_name: 'calendar_appointment',
        event_time: nowInSec(),
        event_id: event_id,
        user_data: user_data,
        custom_data: custom_data,
        action_source: 'website'
      }]
    };

    // Send to Meta
    let metaUrl = `https://graph.facebook.com/v17.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`;
    if (META_TEST_EVENT_CODE) metaUrl += `&test_event_code=${META_TEST_EVENT_CODE}`;

    const metaResp = await fetch(metaUrl, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(metaBody) });
    const metaText = await metaResp.text().catch(()=>'');

    // Optional: forward to GTM Server endpoint (for Google Ads EC)
    if (GTM_SERVER_ENDPOINT) {
      try {
        const serverPayload = {
          event_name: 'calendar_appointment',
          event_time: nowInSec(),
          event_id: event_id,
          client_id: client_id,
          user_data: user_data,
          custom_data: custom_data
        };
        await fetch(GTM_SERVER_ENDPOINT, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(serverPayload) });
      } catch(e) {
        console.warn('forward to GTM server failed', e);
      }
    }

    // delete mapping to keep store small (or rely on Redis TTL in production)
    if (appointment_id) mappingStore.delete(String(appointment_id));

    console.log('Webhook processed', { appointment_id, event_id, metaStatus: metaResp.status });
    return res.json({ ok:true, metaStatus: metaResp.status, metaResult: metaText });
  } catch(e) {
    console.error('ghl-webhook error', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

app.listen(PORT, () => console.log('Server listening on port', PORT));
