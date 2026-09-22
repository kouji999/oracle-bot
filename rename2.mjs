const T = '8935535413:AAH_lLD71ny5chdtumo4wIRjhUA6nEd4YIQ';
const r = await fetch(`https://api.telegram.org/bot${T}/getMyName`);
console.log('getMyName:', JSON.stringify(await r.json()));
