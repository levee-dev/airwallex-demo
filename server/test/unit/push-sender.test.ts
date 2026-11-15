import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendNotification = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('web-push', () => ({ default: { sendNotification } }));

const { webPushSender } = await import('../../src/context-factory');

describe('web push sender', () => {
  beforeEach(() => {
    sendNotification.mockReset();
  });

  const target = { endpoint: 'https://push.example.test/send/1', keys: { p256dh: 'p256dh-key', auth: 'auth-key' } };
  const vapid = { subject: 'https://pay.example.com', publicKey: 'public-key', privateKey: 'private-key' };

  it('sends the payload VAPID-signed, urgent and short-lived', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    await webPushSender.send(target, '{"title":"t"}', vapid);
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: target.endpoint, keys: target.keys },
      '{"title":"t"}',
      expect.objectContaining({ vapidDetails: vapid, urgency: 'high', TTL: 900 }),
    );
  });

  it('passes the push service status through on refusal', async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    await expect(webPushSender.send(target, '{}', vapid)).rejects.toMatchObject({ statusCode: 410 });
  });
});
