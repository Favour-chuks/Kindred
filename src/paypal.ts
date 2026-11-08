import crypto from "node:crypto";

export class PayPalClient {
  private readonly baseUrl = process.env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com";
  private cachedToken?: { value: string; expiresAt: number };

  clientId(): string | null {
    return process.env.PAYPAL_CLIENT_ID ?? null;
  }

  configured(): boolean {
    return Boolean(
      process.env.PAYPAL_CLIENT_ID &&
      process.env.PAYPAL_CLIENT_SECRET &&
      this.baseUrl.includes("sandbox")
    );
  }

  private async accessToken(): Promise<string> {
    if (!this.configured()) {
      throw new Error("PayPal Sandbox credentials are not configured or non-sandbox base URL was detected");
    }

    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.value;
    }

    const basic = Buffer.from(
      `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
    ).toString("base64");

    const response = await this.fetchWithRetry(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!response.ok) {
      throw new Error(`PayPal token request failed (${response.status})`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  private async fetchWithRetry(url: string, init: RequestInit, maxRetries = 2): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, init);
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
        const backoffMs = Math.max(1000, retryAfter * 1000) * Math.pow(2, attempt);
        console.warn(`PayPal 429 received; retrying in ${backoffMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      return response;
    }
    return fetch(url, init);
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const token = await this.accessToken();
    const response = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const debugId = (data as { debug_id?: string }).debug_id;
      const issue = (data as { details?: Array<{ issue?: string }> })?.details?.[0]?.issue;

      if (response.status === 422 && issue === "INSTRUMENT_DECLINED") {
        throw new Error(`Payment method declined (INSTRUMENT_DECLINED). Please choose another payment method in PayPal.${debugId ? ` debug_id=${debugId}` : ""}`);
      }

      throw new Error(
        `PayPal request failed (${response.status})${issue ? ` [${issue}]` : ""}${debugId ? ` debug_id=${debugId}` : ""}`
      );
    }

    return data;
  }

  async sandboxStatus(): Promise<{ configured: boolean; connected: boolean }> {
    if (!this.configured()) return { configured: false, connected: false };
    try {
      await this.accessToken();
      return { configured: true, connected: true };
    } catch {
      return { configured: true, connected: false };
    }
  }

  async createOrder(input: {
    ngoId: string;
    name: string;
    mission: string;
    projectUrl: string;
    imageUrl?: string;
    amount: string;
    matchId: string;
    profileId: string;
    recipientMerchantId: string;
  }): Promise<{ id: string; status: string }> {
    const description = input.mission.slice(0, 127);
    const itemDescription = input.mission.slice(0, 300);

    const item: Record<string, any> = {
      name: input.name.slice(0, 127),
      description: itemDescription,
      quantity: "1",
      unit_amount: { currency_code: "USD", value: input.amount },
      url: input.projectUrl,
    };

    if (input.imageUrl && input.imageUrl.startsWith("https://")) {
      item.image_url = input.imageUrl.slice(0, 500);
    }

    if (process.env.PAYPAL_DONATION_ITEMS === "true") {
      item.category = "DONATION";
    }

    const payload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.ngoId,
          payee: { merchant_id: input.recipientMerchantId },
          description,
          custom_id: `kindred:${input.matchId}:${input.ngoId}`.slice(0, 127),
          amount: {
            currency_code: "USD",
            value: input.amount,
            breakdown: {
              item_total: { currency_code: "USD", value: input.amount },
            },
          },
          items: [item],
        },
      ],
    };

    return this.request("/v2/checkout/orders", {
      method: "POST",
      headers: { "PayPal-Request-Id": crypto.randomUUID() },
      body: JSON.stringify(payload),
    });
  }

  async createMerchantOrder(input: {
    name: string;
    description: string;
    amount: string;
    category?: string;
  }): Promise<{ id: string; status: string }> {
    const payload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          description: input.description.slice(0, 127),
          amount: {
            currency_code: "USD",
            value: input.amount,
            breakdown: { item_total: { currency_code: "USD", value: input.amount } },
          },
          items: [
            {
              name: input.name.slice(0, 127),
              description: input.description.slice(0, 127),
              quantity: "1",
              unit_amount: { currency_code: "USD", value: input.amount },
            },
          ],
        },
      ],
    };
    return this.request("/v2/checkout/orders", {
      method: "POST",
      headers: { "PayPal-Request-Id": crypto.randomUUID() },
      body: JSON.stringify(payload),
    });
  }

  async captureOrder(orderId: string): Promise<{ id: string; status: string; purchase_units?: any[]; payer?: { payer_id?: string; email_address?: string } }> {
    return this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      headers: { "PayPal-Request-Id": `capture-${orderId}` },
    });
  }

  async verifyCompletedCapture(captureId: string, merchantId?: string): Promise<{ verified: boolean; payerId?: string }> {
    if (!/^[A-Za-z0-9_-]{5,128}$/.test(captureId)) return { verified: false };
    try {
      const capture = await this.request(`/v2/payments/captures/${encodeURIComponent(captureId)}`) as {
        status?: string; supplementary_data?: { related_ids?: { order_id?: string } };
      };
      if (capture.status !== "COMPLETED" || !capture.supplementary_data?.related_ids?.order_id) return { verified: false };
      const order = await this.request(`/v2/checkout/orders/${encodeURIComponent(capture.supplementary_data.related_ids.order_id)}`) as {
        payer?: { payer_id?: string };
        purchase_units?: Array<{ payee?: { merchant_id?: string }; payments?: { captures?: Array<{ id?: string }> } }>;
      };
      const merchantMatches = !merchantId || order.purchase_units?.some((unit) =>
        unit.payee?.merchant_id === merchantId && unit.payments?.captures?.some((item) => item.id === captureId)
      );
      if (!merchantMatches) return { verified: false };
      return { verified: true, payerId: order.payer?.payer_id };
    } catch {
      return { verified: false };
    }
  }

  async verifyWebhook(headers: Record<string, string | undefined>, body: string): Promise<boolean> {
    if (!process.env.PAYPAL_WEBHOOK_ID) return false;

    const result = (await this.request("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: JSON.parse(body),
      }),
    })) as { verification_status?: string };

    return result.verification_status === "SUCCESS";
  }
}
