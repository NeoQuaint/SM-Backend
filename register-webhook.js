require('dotenv').config();

const YOCO_SECRET = process.env.YOCO_SECRET_KEY_SMARTCLASS;
const WEBHOOK_URL = 'https://smartclass-wlgb.onrender.com/api/yoco/webhook';

(async () => {
  if (!YOCO_SECRET) {
    console.error('❌ YOCO_SECRET_KEY_SMARTCLASS not set');
    process.exit(1);
  }

  console.log('Registering webhook at:', WEBHOOK_URL);
  console.log('Using key:', YOCO_SECRET.slice(0, 12) + '...');

  const res = await fetch('https://payments.yoco.com/api/webhooks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${YOCO_SECRET}`,
    },
    body: JSON.stringify({
      url: WEBHOOK_URL,
      events: ['payment.succeeded', 'payment.failed'],
    }),
  });

  const data = await res.json();
  console.log('\nStatus:', res.status);
  console.log(JSON.stringify(data, null, 2));

  if (data.secret) {
    console.log('\n===================================================');
    console.log('COPY THIS INTO RENDER AS YOCO_WEBHOOK_SECRET:');
    console.log(data.secret);
    console.log('===================================================\n');
  } else if (res.status === 401) {
    console.error('❌ 401 — key invalid or wrong API surface');
  }
})();