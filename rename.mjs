const T = '8935535413:AAH_lLD71ny5chdtumo4wIRjhUA6nEd4YIQ';

async function call(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${T}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  console.log(method, '->', j.ok ? 'OK' : JSON.stringify(j));
}

await call('setMyName', { name: 'VEYRON', language_code: 'en' });
await call('setMyName', { name: 'VEYRON', language_code: 'id' });
await call('setMyShortDescription', { short_description: 'Intelijen pasar, provider AI gratis, & berita — real-time.', language_code: 'id' });
await call('setMyDescription', { description: 'Intelijen pasar & provider AI gratis. Berita finansial global-Indonesia, direktori provider AI (base URL + model gratis), pemantauan X, dan ringkasan harian otomatis. Ketik /help untuk mulai.', language_code: 'id' });
const me = await (await fetch(`https://api.telegram.org/bot${T}/getMe`)).json();
console.log('getMe:', JSON.stringify({ first_name: me.result.first_name, username: me.result.username }));
