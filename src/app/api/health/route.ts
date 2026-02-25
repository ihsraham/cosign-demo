import { apiOk } from '@/lib/api';

export async function GET() {
  return apiOk({ ok: true, at: new Date().toISOString() });
}
