import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { handleApi } from '../../../lib/http.mjs';

export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  const user = await getChatGPTUser();
  return handleApi(request, env.DB, user, env);
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
