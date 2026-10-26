import type { Sample } from '../lib/types';

/**
 * Demo material. The JWTs are real, structurally valid tokens signed with a
 * throwaway key; the payloads are readable so the local engine can verify the
 * expiry and scopes without a model. Nothing here is a live credential.
 */
const EXPIRED_TOKEN =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjIwMjYtMTAifQ.eyJzdWIiOiJ1c3JfOGYyMSIsImlzcyI6Imh0dHBzOi8vYXV0aC5hY21lLmRldiIsImF1ZCI6Imh0dHBzOi8vYXBpLmFjbWUuZGV2Iiwic2NvcGUiOiJpbnZvaWNlcy5yZWFkIGludm9pY2VzLndyaXRlIiwiaWF0IjoxNzkzMDA3NjAwLCJleHAiOjE3OTMwMTEyMDAsImVtYWlsIjoiZGV2QGFjbWUuZGV2In0.q7Xk2mNv8pR4sT1uW3yZ5aB6cD9eF0gH2iJ4kL6mN8oP';

const LIMITED_TOKEN =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjIwMjYtMTAifQ.eyJzdWIiOiJ1c3JfOGYyMSIsImlzcyI6Imh0dHBzOi8vYXV0aC5hY21lLmRldiIsImF1ZCI6Imh0dHBzOi8vYXBpLmFjbWUuZGV2Iiwic2NvcGUiOiJpbnZvaWNlcy5yZWFkIiwiaWF0IjoxNzYxNDkwMDAwLCJleHAiOjIwMDAwMDAwMDB9.r8Yl3nOw9qS5tU2vX4zA6bC7dE0fG1hI3jK5lM7nO9pQ';

export const SAMPLES: Sample[] = [
  {
    id: 'oauth-401',
    title: 'OAuth request returns 401',
    subtitle: 'Expired access token on an invoice approval',
    tag: '401',
    tone: 'danger',
    draft: {
      method: 'POST',
      url: 'https://api.acme.dev/v1/invoices/8412/approve',
      statusCode: '401',
      requestHeaders: [
        `Authorization: Bearer ${EXPIRED_TOKEN}`,
        'Content-Type: application/json',
        'Accept: application/json',
        'X-Request-Id: 3f9c1a7e-52b4-4d61-9c0e-77ab21de9f10',
        'User-Agent: acme-dashboard/2.14.0',
      ].join('\n'),
      requestBody: JSON.stringify({ approver_note: 'Approved for Q4 close', notify_customer: true }, null, 2),
      responseBody: JSON.stringify(
        {
          error: 'invalid_token',
          error_description: 'The access token expired at 2026-10-26T10:40:00Z',
          request_id: 'req_9c1d4f',
        },
        null,
        2,
      ),
      errorMessage: 'Request failed with status code 401',
      logs: '',
    },
  },
  {
    id: 'scope-403',
    title: 'Forbidden on the same endpoint',
    subtitle: 'Valid token, missing invoices.write scope',
    tag: '403',
    tone: 'warn',
    draft: {
      method: 'POST',
      url: 'https://api.acme.dev/v1/invoices/8412/approve',
      statusCode: '403',
      requestHeaders: [
        `Authorization: Bearer ${LIMITED_TOKEN}`,
        'Content-Type: application/json',
        'X-Request-Id: 81c0be44-6a11-4a0e-a0d8-3ce1f0d2b7aa',
      ].join('\n'),
      requestBody: JSON.stringify({ approver_note: 'Approved for Q4 close', notify_customer: true }, null, 2),
      responseBody: JSON.stringify(
        {
          error: 'insufficient_scope',
          message: 'This action requires the invoices.write scope',
          required: 'invoices.write',
          granted: ['invoices.read'],
          request_id: 'req_5a7b21',
        },
        null,
        2,
      ),
      errorMessage: 'Request failed with status code 403',
      logs: '',
    },
  },
  {
    id: 'rate-429',
    title: 'Rate limited during a sync job',
    subtitle: '429 with Retry-After from the API gateway',
    tag: '429',
    tone: 'warn',
    draft: {
      method: 'GET',
      url: 'https://api.acme.dev/v1/customers?limit=100&page=7',
      statusCode: '429',
      requestHeaders: [
        'Authorization: Bearer acme_live_9f2c7b41e8a04d6f',
        'Accept: application/json',
        'Retry-After: 30',
        'X-RateLimit-Limit: 120',
        'X-RateLimit-Remaining: 0',
        'X-RateLimit-Reset: 1761493860',
      ].join('\n'),
      requestBody: '',
      responseBody: JSON.stringify(
        { error: 'rate_limit_exceeded', message: 'Too many requests. Limit: 120 requests per minute per API key.' },
        null,
        2,
      ),
      errorMessage: 'Too Many Requests',
      logs: '',
    },
  },
  {
    id: 'server-500',
    title: '500 while capturing a payment',
    subtitle: 'Unhandled TypeError in the payment service',
    tag: '500',
    tone: 'danger',
    draft: {
      method: 'POST',
      url: 'https://api.acme.dev/v1/payments/capture',
      statusCode: '500',
      requestHeaders: [
        'Authorization: Bearer acme_live_4b8d1f0c9e7a2b63',
        'X-Api-Key: sk-live-EXAMPLEPLACEHOLDER00',
        'Content-Type: application/json',
        'X-Request-Id: 6d0f3a92-1b7c-4f88-9e21-0c5a7d3b8e14',
      ].join('\n'),
      requestBody: JSON.stringify({ payment_intent: 'pi_3Oq7Yz2eZvKYlo2C1aBcDeFg', amount_cents: 24900 }, null, 2),
      responseBody: JSON.stringify(
        { error: 'internal_error', message: 'An unexpected error occurred.', request_id: 'req_7d2e90' },
        null,
        2,
      ),
      errorMessage: 'Request failed with status code 500',
      logs: [
        '2026-10-26T11:42:07.918Z ERROR payment-service req=req_7d2e90 capture failed',
        "TypeError: Cannot read properties of null (reading 'currency')",
        '    at capturePayment (/srv/app/src/payments/capture.ts:84:31)',
        '    at async handler (/srv/app/src/routes/payments.ts:41:18)',
        '    at async Layer.handle [as handle_request] (/srv/app/node_modules/express/lib/router/layer.js:95:5)',
        'Caused by: RedisError: Connection timeout (cache.internal:6379, 5000ms)',
      ].join('\n'),
    },
  },
  {
    id: 'timeout',
    title: 'Request times out before a response',
    subtitle: 'No HTTP status — transport-level failure',
    tag: 'TIMEOUT',
    tone: 'info',
    draft: {
      method: 'GET',
      url: 'https://api.acme.dev/v1/reports/quarterly?year=2026',
      statusCode: '',
      requestHeaders: ['Authorization: Bearer acme_live_2d6e9a0b7c4f1e83', 'Accept: application/json'].join('\n'),
      requestBody: '',
      responseBody: '',
      errorMessage: 'request to https://api.acme.dev/v1/reports/quarterly?year=2026 failed, reason: connect ETIMEDOUT 10.4.12.9:443',
      logs: [
        '2026-10-26T11:50:02.114Z WARN http-client req=outbound-4412 attempt=1 timeout=10000ms',
        '2026-10-26T11:50:12.126Z ERROR http-client req=outbound-4412 connect ETIMEDOUT 10.4.12.9:443',
        '2026-10-26T11:50:12.130Z WARN http-client req=outbound-4412 retry 1/3 scheduled in 2000ms',
      ].join('\n'),
    },
  },
];

export const EMPTY_DRAFT: Sample['draft'] = {
  method: 'GET',
  url: '',
  statusCode: '',
  requestHeaders: '',
  requestBody: '',
  responseBody: '',
  errorMessage: '',
  logs: '',
};
