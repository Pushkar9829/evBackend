import { config } from '../../config.js';
import { mockProvider } from './mock.js';
import { razorpayProvider } from './razorpay.js';

export function provider() {
  return config.payments.provider === 'razorpay' ? razorpayProvider : mockProvider;
}
