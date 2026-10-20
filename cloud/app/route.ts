import { getChatGPTUser, chatGPTSignInPath } from './chatgpt-auth';
import { htmlResponse } from '../lib/http.mjs';
import { SHELL } from '../lib/shell.mjs';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (!await getChatGPTUser()) {
    return Response.redirect(new URL(chatGPTSignInPath('/'), request.url), 302);
  }
  return htmlResponse(SHELL);
}
