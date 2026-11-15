import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

/** A stand-in for the Baileys socket: records listeners, never touches the network. */
function fakeSocket() {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    ended: false,
    ev: {
      on: (name: string, fn: (...a: unknown[]) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      },
      removeAllListeners: (name: string) => listeners.delete(name),
    },
    end() {
      this.ended = true;
    },
    emit: (name: string, ...args: unknown[]) => (listeners.get(name) ?? []).forEach((fn) => fn(...args)),
  };
}

const h = vi.hoisted(() => ({
  sockets: [] as ReturnType<typeof fakeSocket>[],
  releaseVersion: [] as Array<() => void>,
  saveCreds: vi.fn(async () => {}),
}));

vi.mock('@whiskeysockets/baileys', () => ({
  default: () => {
    const s = fakeSocket();
    h.sockets.push(s);
    return s;
  },
  DisconnectReason: { loggedOut: 401 },
  // Held open until the test releases it: this is the window destroy() can land in.
  fetchLatestBaileysVersion: () =>
    new Promise((resolve) => h.releaseVersion.push(() => resolve({ version: [2, 3000, 1] }))),
}));
vi.mock('../auth-state.js', () => ({
  useSQLiteAuthState: async () => ({ state: {}, saveCreds: h.saveCreds }),
}));

import { configSchema } from '../../config/schema.js';
import { ConnectionManager } from '../socket.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const manager = (broadcasts: object[] = []) =>
  new ConnectionManager({} as never, configSchema.parse({}), (m) => broadcasts.push(m), pino({ level: 'silent' }), 'k'.repeat(32));

beforeEach(() => {
  h.sockets.length = 0;
  h.releaseVersion.length = 0;
  h.saveCreds.mockReset();
  h.saveCreds.mockResolvedValue(undefined);
});

describe('ConnectionManager lifecycle', () => {
  it('destroy() during connect() means no socket is ever opened', async () => {
    const cm = manager();
    const connecting = cm.connect();
    await tick();
    cm.destroy();
    h.releaseVersion.forEach((go) => go());
    await connecting;
    expect(h.sockets).toHaveLength(0);
    expect(cm.getSocket()).toBeNull();
  });

  it('a destroyed manager cannot be connected or reset again', async () => {
    const cm = manager();
    cm.destroy();
    await cm.connect();
    await cm.forceResetToPairing();
    expect(h.releaseVersion).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
  });

  it('overlapping connects leave exactly one socket', async () => {
    const cm = manager();
    const all = [cm.connect(), cm.connect(), cm.connect()];
    await tick();
    h.releaseVersion.forEach((go) => go());
    await Promise.all(all);
    expect(h.sockets).toHaveLength(1);
    expect(cm.getSocket()).toBe(h.sockets[0]);
  });

  it('events from a destroyed socket are ignored', async () => {
    const broadcasts: object[] = [];
    const cm = manager(broadcasts);
    const connecting = cm.connect();
    await tick();
    h.releaseVersion.forEach((go) => go());
    await connecting;
    const sock = h.sockets[0];
    const update = (u: object) => sock.emit('connection.update', u);
    cm.destroy();
    // cleanupSocket removed the listeners; emitting must not broadcast a QR or reconnect
    update({ qr: 'LEAKED-QR' });
    update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await tick();
    expect(broadcasts.filter((b) => (b as { type: string }).type === 'qr')).toEqual([]);
    expect(h.releaseVersion).toHaveLength(1); // no second connect started
  });

  it('a failing credentials save is logged, not thrown as an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    h.saveCreds.mockRejectedValue(new Error('The database connection is not open'));
    const cm = manager();
    const connecting = cm.connect();
    await tick();
    h.releaseVersion.forEach((go) => go());
    await connecting;
    h.sockets[0].emit('creds.update', {});
    await tick();
    await tick();
    process.off('unhandledRejection', unhandled);
    expect(h.saveCreds).toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    cm.destroy();
  });
});
