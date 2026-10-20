declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    CHAT_MODE?: string;
    LLM_MODEL?: string;
    LLM_API_KEY?: string;
    LLM_BASE_URL?: string;
    LLM_API_STYLE?: string;
  }
}
