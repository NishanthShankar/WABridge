import makeWASocket, {
  DisconnectReason,
  type ConnectionState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import type { Logger } from 'pino';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { AppConfig } from '../config/schema.js';
import { useSQLiteAuthState } from './auth-state.js';
import { authState as authStateTable } from '../db/schema.js';
import type { ConnectionHealth, ConnectionStatus } from './types.js';
import {
  calculateBackoff,
  isRetryWindowExhausted,
} from './reconnect.js';

/** Function signature for broadcasting messages to WebSocket clients */
export type BroadcastFn = (message: object) => void;

/**
 * Manages the full WhatsApp connection lifecycle:
 * - Creates Baileys socket with encrypted auth state
 * - Broadcasts QR codes to WebSocket clients
 * - Handles all disconnect reasons per Baileys v7 spec
 * - Reconnects with exponential backoff (up to 30 minutes)
 * - Resets to pairing mode on permanent failure
 *
 * PITFALL AVOIDANCE:
 * - Does NOT send ACKs (Baileys v7 removed them -- WhatsApp bans for ACK sending)
 * - Handles ALL DisconnectReason codes with explicit cases + default fallback
 * - Treats 428 (connectionClosed) as transient for backoff
 */
export class ConnectionManager {
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedAt: Date | null = null;
  private lastDisconnect: {
    reason: string;
    code: number;
    at: Date;
  } | null = null;
  private status: ConnectionStatus = 'pairing';
  private retryStartedAt: Date | null = null;
  private account: { phoneNumber: string; name: string } | null = null;

  /** Callbacks invoked every time the connection opens (including reconnections) */
  private connectedCallbacks: Array<(sock: ReturnType<typeof makeWASocket>) => void> = [];

  private readonly maxRetryMs: number;
  private readonly backoffConfig: {
    baseDelayMs: number;
    maxDelayMs: number;
  };

  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly config: AppConfig,
    private readonly broadcast: BroadcastFn,
    private readonly logger: Logger,
    private readonly masterKey: string,
  ) {
    this.maxRetryMs = config.reconnect.max_retry_minutes * 60 * 1000;
    this.backoffConfig = {
      baseDelayMs: config.reconnect.base_delay_ms,
      maxDelayMs: config.reconnect.max_delay_ms,
    };
  }

  /**
   * Returns current health state for the /api/health endpoint and WebSocket status.
   */
  getHealth(): ConnectionHealth {
    const now = Date.now();
    const uptime = this.connectedAt
      ? Math.floor((now - this.connectedAt.getTime()) / 1000)
      : 0;

    return {
      status: this.status,
      uptime,
      connectedAt: this.connectedAt?.toISOString() ?? null,
      lastDisconnect: this.lastDisconnect
        ? {
            reason: this.lastDisconnect.reason,
            code: this.lastDisconnect.code,
            at: this.lastDisconnect.at.toISOString(),
          }
        : null,
      reconnectAttempts: this.reconnectAttempt,
      account: this.account,
    };
  }

  /**
   * Initialize Baileys socket and start WhatsApp connection.
   * On first run (no stored creds), displays QR code for pairing.
   * On subsequent runs, restores session from encrypted SQLite.
   */
  async connect(): Promise<void> {
    // Clean up any existing socket before creating a new one
    this.cleanupSocket();

    const { state, saveCreds } = await useSQLiteAuthState(
      this.db,
      this.masterKey,
    );

    this.sock = makeWASocket({
      auth: state,
      // NOTE: printQRInTerminal is deprecated in Baileys v7 -- we handle QR display ourselves
      browser: [this.config.whatsapp.browser_name, 'Chrome', '22.0.0'],
      markOnlineOnConnect: this.config.whatsapp.mark_online,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on(
      'connection.update',
      (update: Partial<ConnectionState>) => {
        this.handleConnectionUpdate(update);
      },
    );
  }

  /**
   * Handle connection.update events from Baileys.
   */
  private async handleConnectionUpdate(
    update: Partial<ConnectionState>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    // QR code received -- pairing mode
    if (qr) {
      this.status = 'pairing';
      this.reconnectAttempt = 0;

      try {
        // Generate QR for web page (data URL) and broadcast to WebSocket clients
        const qrDataUrl = await QRCode.toDataURL(qr);
        this.broadcast({ type: 'qr', data: qrDataUrl });

        // Print QR to terminal for CLI-based pairing
        const qrTerminal = await QRCode.toString(qr, {
          type: 'terminal',
          small: true,
        });
        console.log('\n' + qrTerminal);
      } catch (err) {
        this.logger.error({ err }, 'Failed to generate QR code');
      }

      this.logger.info('QR code generated -- scan with WhatsApp to pair');
    }

    // Connection opened
    if (connection === 'open') {
      this.status = 'connected';
      this.connectedAt = new Date();
      this.reconnectAttempt = 0;
      this.retryStartedAt = null;

      // Extract account info from socket user
      if (this.sock?.user) {
        const user = this.sock.user;
        this.account = {
          phoneNumber: user.id.split(':')[0] ?? user.id,
          name: user.name ?? '',
        };
      }

      this.broadcast({ type: 'status', data: this.getHealth() });
      this.logger.info(
        { account: this.account },
        'WhatsApp connected',
      );

      // Invoke onConnected callbacks (e.g., delivery status listener)
      if (this.sock) {
        for (const cb of this.connectedCallbacks) {
          try {
            cb(this.sock);
          } catch (err) {
            this.logger.error({ err }, 'onConnected callback error');
          }
        }
      }
    }

    // Connection closed
    if (connection === 'close') {
      const error = lastDisconnect?.error as Boom | undefined;
      const statusCode =
        error?.output?.statusCode ??
        DisconnectReason.connectionClosed;

      // Look up the reason name from DisconnectReason enum
      const reasonName =
        (DisconnectReason as Record<number, string>)[statusCode] ??
        'unknown';

      this.lastDisconnect = {
        reason: reasonName,
        code: statusCode,
        at: new Date(),
      };

      this.logger.warn(
        { reason: reasonName, code: statusCode },
        'WhatsApp disconnected',
      );

      this.broadcast({ type: 'status', data: this.getHealth() });

      this.handleDisconnect(statusCode);
    }
  }

  /**
   * Handle disconnect based on Baileys status code.
   * Each DisconnectReason gets explicit handling with a default fallback.
   */
  private handleDisconnect(statusCode: number): void {
    switch (statusCode) {
      // Permanent: user unlinked device from phone
      case DisconnectReason.loggedOut: // 401
        this.logger.info(
          'Logged out -- clearing credentials and resetting to pairing mode',
        );
        this.clearAuthState();
        this.resetToPairing();
        break;

      // Permanent: another instance took over
      case DisconnectReason.connectionReplaced: // 440
        this.logger.warn(
          'Connection replaced by another client -- stopping',
        );
        this.status = 'disconnected';
        this.broadcast({ type: 'status', data: this.getHealth() });
        break;

      // Expected after auth -- immediate reconnect
      case DisconnectReason.restartRequired: // 515
        this.logger.info(
          'Restart required -- reconnecting immediately',
        );
        this.scheduleReconnect(0);
        break;

      // Forbidden: possible ban or policy violation
      case DisconnectReason.forbidden: // 403
        this.logger.error(
          'Connection forbidden (possible ban) -- resetting to pairing mode',
        );
        this.clearAuthState();
        this.resetToPairing();
        break;

      // Transient: all other codes (408, 411, 428, 500, 503, etc.)
      default:
        this.logger.info(
          { code: statusCode },
          'Transient disconnect -- reconnecting with backoff',
        );
        this.reconnectWithBackoff();
        break;
    }
  }

  /**
   * Reconnect with exponential backoff.
   * Gives up after 30 minutes (configurable) and resets to pairing mode.
   */
  private reconnectWithBackoff(): void {
    if (this.retryStartedAt === null) {
      this.retryStartedAt = new Date();
    }

    if (isRetryWindowExhausted(this.retryStartedAt, this.maxRetryMs)) {
      this.logger.warn(
        'Retry window exhausted (%d min) -- resetting to pairing mode',
        this.config.reconnect.max_retry_minutes,
      );
      this.clearAuthState();
      this.resetToPairing();
      return;
    }

    const delay = calculateBackoff(
      this.reconnectAttempt,
      this.backoffConfig,
    );
    this.reconnectAttempt++;

    this.status = 'connecting';
    this.broadcast({ type: 'status', data: this.getHealth() });

    this.logger.info(
      {
        attempt: this.reconnectAttempt,
        delayMs: Math.round(delay),
      },
      'Scheduling reconnect',
    );

    this.scheduleReconnect(delay);
  }

  /**
   * Schedule a reconnect after a delay.
   */
  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.logger.error({ err }, 'Reconnect failed');
        this.reconnectWithBackoff();
      });
    }, delayMs);
  }

  /**
   * Reset to pairing mode for a fresh QR code.
   */
  private resetToPairing(): void {
    this.reconnectAttempt = 0;
    this.retryStartedAt = null;
    this.status = 'pairing';
    this.account = null;
    this.connectedAt = null;

    this.connect().catch((err) => {
      this.logger.error({ err }, 'Failed to reset to pairing mode');
    });
  }

  /**
   * Clear all auth state from the database.
   * Used when credentials are permanently invalid (logged out, banned).
   */
  private clearAuthState(): void {
    try {
      this.db.delete(authStateTable).run();
      this.logger.info('Auth state cleared from database');
    } catch (err) {
      this.logger.error({ err }, 'Failed to clear auth state');
    }
  }

  /**
   * Clean up the current socket without clearing auth state.
   */
  private cleanupSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.end(undefined);
      } catch {
        // Socket may already be closed
      }
      this.sock = null;
    }
  }

  /**
   * Register a callback that runs every time the connection opens.
   * This includes initial connection and all reconnections.
   *
   * Use this to attach event listeners (like delivery status tracking)
   * that need to be re-attached on every new socket instance.
   */
  onConnected(cb: (sock: ReturnType<typeof makeWASocket>) => void): void {
    this.connectedCallbacks.push(cb);
  }

  /**
   * Get the underlying Baileys socket for sending messages.
   * Returns null if not connected.
   */
  getSocket(): ReturnType<typeof makeWASocket> | null {
    return this.sock;
  }

  /**
   * Graceful shutdown: close socket and clear timers.
   */
  destroy(): void {
    this.cleanupSocket();
    this.logger.info('ConnectionManager destroyed');
  }
}
