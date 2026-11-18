import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type AppContext, setContext } from '../../context.js';
import { createProfileRouter } from '../profile.router.js';

const ME = '919800000001@s.whatsapp.net';

function setup(opts: { business?: boolean; refuseName?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const sock = {
    user: { id: '919800000001:7@s.whatsapp.net', name: 'Test Clinic' },
    async fetchStatus() {
      return [{ id: ME, status: { status: 'Open 9 to 6' } }];
    },
    async profilePictureUrl() {
      return 'https://pps.whatsapp.net/x.jpg';
    },
    async getBusinessProfile() {
      if (!opts.business) return undefined;
      return {
        wid: ME,
        description: 'Family clinic',
        address: 'MG Road',
        website: ['https://clinic.test'],
        email: 'desk@clinic.test',
        category: 'Medical',
        business_hours: {
          timezone: 'Asia/Kolkata',
          business_config: [
            {
              day_of_week: 'mon',
              mode: 'specific_hours',
              open_time: 540,
              close_time: 1080,
            },
            { day_of_week: 'sun', mode: 'appointment_only' },
          ],
        },
      };
    },
    async updateProfileName(name: string) {
      if (opts.refuseName) throw new Error('not-allowed');
      calls.push(['name', name]);
    },
    async updateProfileStatus(about: string) {
      calls.push(['about', about]);
    },
    async updateBussinesProfile(args: unknown) {
      calls.push(['business', args]);
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    setContext(c, {
      getSocket: () => sock,
      tenantId: 't1',
    } as unknown as AppContext);
    await next();
  });
  app.route('/api/profile', createProfileRouter());
  const call = async (method: string, path: string, body?: object) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };
  return { calls, call };
}

describe('GET /api/profile', () => {
  it('a business account, hours in HH:MM', async () => {
    const r = await setup({ business: true }).call('GET', '/api/profile');
    expect(r.body).toEqual({
      phone: '919800000001',
      name: 'Test Clinic',
      about: 'Open 9 to 6',
      pictureUrl: 'https://pps.whatsapp.net/x.jpg',
      isBusiness: true,
      business: {
        description: 'Family clinic',
        address: 'MG Road',
        email: 'desk@clinic.test',
        websites: ['https://clinic.test'],
        category: 'Medical',
        hours: {
          timezone: 'Asia/Kolkata',
          days: [
            { day: 'mon', open: '09:00', close: '18:00' },
            { day: 'sun', mode: 'appointmentOnly' },
          ],
        },
      },
    });
  });

  it('a personal account has no business profile', async () => {
    const r = await setup().call('GET', '/api/profile');
    expect(r.body).toMatchObject({ isBusiness: false, business: null });
  });
});

describe('PATCH /api/profile', () => {
  it('changes name and about, reporting refusals', async () => {
    const t = setup({ refuseName: true });
    const r = await t.call('PATCH', '/api/profile', {
      name: 'New',
      about: 'Hi',
    });
    expect(r.body).toEqual({
      applied: ['about'],
      failed: [{ field: 'name', error: 'not-allowed' }],
    });
    expect((await t.call('PATCH', '/api/profile', {})).status).toBe(400);
  });
});

describe('PATCH /api/profile/business', () => {
  it('turns HH:MM hours into minutes and modes into WhatsApp names', async () => {
    const t = setup({ business: true });
    const r = await t.call('PATCH', '/api/profile/business', {
      description: 'Family clinic',
      hours: {
        timezone: 'Asia/Kolkata',
        days: [
          { day: 'mon', open: '09:30', close: '18:00' },
          { day: 'sat', mode: 'open24h' },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(t.calls[0][1]).toEqual({
      description: 'Family clinic',
      address: undefined,
      email: undefined,
      websites: undefined,
      hours: {
        timezone: 'Asia/Kolkata',
        days: [
          {
            day: 'mon',
            mode: 'specific_hours',
            openTimeInMinutes: '570',
            closeTimeInMinutes: '1080',
          },
          { day: 'sat', mode: 'open_24h' },
        ],
      },
    });
  });

  it('validates', async () => {
    const t = setup({ business: true });
    expect((await t.call('PATCH', '/api/profile/business', {})).status).toBe(
      400,
    );
    expect(
      (
        await t.call('PATCH', '/api/profile/business', {
          websites: ['ftp://x.test'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.call('PATCH', '/api/profile/business', {
          hours: {
            timezone: 'Asia/Kolkata',
            days: [{ day: 'mon', open: '9am', close: '18:00' }],
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.call('PATCH', '/api/profile/business', {
          hours: {
            timezone: 'Asia/Kolkata',
            days: [
              { day: 'mon', mode: 'open24h' },
              { day: 'mon', mode: 'open24h' },
            ],
          },
        })
      ).status,
    ).toBe(400);
  });
});
