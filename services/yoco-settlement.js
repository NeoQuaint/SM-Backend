const { settleVerifiedEvent } = require('./payment-settlement');
function checkoutIdFrom(payload) {
 const id=payload?.metadata?.checkoutId||payload?.checkoutId||payload?.checkout_id;
 return typeof id==='string' && /^(ch_|checkout_)[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
async function settleYocoEvent(pool,event,expectedMode='live') {
 if (['payment.succeeded','payment.failed','payment.cancelled','refund.succeeded','payment.refunded'].includes(event.type||event.event_type) && !checkoutIdFrom(event.payload||event.data)) throw Object.assign(new Error('Missing checkout ID in payment metadata'),{status:400});
 return settleVerifiedEvent(pool,event,expectedMode);
}
module.exports={settleYocoEvent,checkoutIdFrom};
