import { next } from '@vercel/functions';

export const config = { matcher: '/((?!favicon).*)' };

export default function middleware(request) {
  const header = request.headers.get('authorization') || '';
  let ok = false;
  try {
    const [user, pass] = atob(header.split(' ')[1] || '').split(':');
    ok = user === process.env.OPAL_USER && pass === process.env.OPAL_PASS;
  } catch (e) {}
  if (ok) return next();
  return new Response('Perlu login', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="OPAL"' },
  });
}
