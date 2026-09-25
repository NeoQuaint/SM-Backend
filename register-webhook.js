require('dotenv').config();

const YOCO_SECRET = process.env.YOCO_SECRET_KEY_SMARTCLASS;
const WEBHOOK_URL = 'https://smartclass-wlgb.onrender.com/api/yoco/webhook';

(async () => {
  if (!YOCO_SECRET) {
    console.error('❌ YOCO_SECRET_KEY_SMARTCLASS not set in env');
    process.exit(1);
  }

  console.log('Registering webhook at:', WEBHOOK_URL);
  console.log('Using key starting with:', YOCO_SECRET.slice(0, 12) + '...');

  const res = await fetch('https://api.yoco.com/v1/webhooks/subscriptions/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${YOCO_SECRET}`,
    },
    body: JSON.stringify({
      name: 'SmartClass production webhook',
      notification_url: WEBHOOK_URL,
      event_types: ['payment.created', 'payment.refunded'],
    }),
  });

  const data = await res.json();
  console.log('\nStatus:', res.status);
  console.log(JSON.stringify(data, null, 2));

  if (data.secret) {
    console.log('\n===================================================');
    console.log('COPY THIS INTO RENDER AS YOCO_WEBHOOK_SECRET:');
    console.log('');
    console.log(data.secret);
    console.log('');
    console.log('===================================================\n');
  } else if (res.status === 401) {
    console.error('❌ 401 — secret key wrong, or not a Yoco API key');
  } else if (res.status === 403) {
    console.error('❌ 403 — key lacks webhook scopes. Enable webhooks on your Yoco account.');
  } else if (res.status === 409) {
    console.error('❌ 409 — webhook already exists for this URL.');
  }
})();