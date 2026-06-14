import { z } from 'zod';

export const currencyEnum = z.enum(['IRR', 'EUR', 'USD']);

export type CurrencyCode = z.infer<typeof currencyEnum>;
