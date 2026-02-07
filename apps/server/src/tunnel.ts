import type { Logger } from 'pino';
import type { AppConfig } from './config/schema.js';

export interface Tunnel {
  url: string;
  close: () => Promise<void>;
}

/**
 * Start an ngrok tunnel if configured.
 *
 * Dynamically imports @ngrok/ngrok (optional dependency).
 * Returns null if ngrok is not configured or the package is missing.
 */
export async function startTunnel(
  config: AppConfig,
  logger: Logger,
  port: number,
): Promise<Tunnel | null> {
  if (!config.ngrok) return null;

  let ngrok: { forward: (opts: { addr: number; authtoken: string; domain?: string }) => Promise<{ url: () => string | null; close: () => Promise<void> }> };
  try {
    ngrok = await import('@ngrok/ngrok' as string);
  } catch {
    logger.warn('ngrok configured but @ngrok/ngrok not installed — skipping tunnel');
    return null;
  }

  const listener = await ngrok.forward({
    addr: port,
    authtoken: config.ngrok.authtoken,
    domain: config.ngrok.domain,
  });

  const url = listener.url()!;
  logger.info({ url }, 'ngrok tunnel established');

  return {
    url,
    close: () => listener.close(),
  };
}
