export {};

declare global {
  interface Window {
    paypal?: {
      createInstance: (options: unknown) => Promise<PaypalSdk>;
    };
  }

  type PaypalSdk = {
    findEligibleMethods: (input: { currencyCode: string; amount: string }) => Promise<{ isEligible: (method: string) => boolean }>;
    createPayPalOneTimePaymentSession: (callbacks: {
      onApprove: (data: { orderId: string }) => Promise<void>;
      onCancel: () => void;
      onError: (error: unknown) => void;
    }) => { start: (options: { presentationMode: "auto" | "redirect" }, order: Promise<{ orderId: string }>) => Promise<void> };
  };
}
