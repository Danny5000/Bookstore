import { z } from 'zod';
import { ConfigurationError } from './read-setting';

const port = z
  .string()
  .regex(/^\d+$/, 'must be an integer between 1 and 65535')
  .transform((value) => Number.parseInt(value, 10))
  .pipe(z.number().int().min(1).max(65_535));

const rawApplicationConfigSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']),
    APPLICATION_MODE: z.enum(['prototype', 'maintenance']),
    ORIGIN: z.url().refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, 'must use http or https'),
    DATABASE_HOST: z.string().trim().min(1),
    DATABASE_PORT: port,
    DATABASE_NAME: z.string().trim().min(1),
    DATABASE_USER: z.string().trim().min(1),
    DATABASE_PASSWORD: z.string().min(1)
  })
  .superRefine((value, context) => {
    if (value.APP_ENV === 'production' && value.APPLICATION_MODE !== 'maintenance') {
      context.addIssue({
        code: 'custom',
        path: ['APPLICATION_MODE'],
        message: 'production must use maintenance mode'
      });
    }
  })
  .transform((value) => ({
    environment: value.APP_ENV,
    applicationMode: value.APPLICATION_MODE,
    origin: value.ORIGIN,
    database: {
      host: value.DATABASE_HOST,
      port: value.DATABASE_PORT,
      name: value.DATABASE_NAME,
      user: value.DATABASE_USER,
      password: value.DATABASE_PASSWORD
    }
  }));

export type ApplicationConfig = z.output<typeof rawApplicationConfigSchema>;
export type ApplicationMode = ApplicationConfig['applicationMode'];

export function parseApplicationConfig(value: unknown): ApplicationConfig {
  const result = rawApplicationConfigSchema.safeParse(value);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
    .join('; ');
  throw new ConfigurationError(`Invalid application configuration: ${details}`);
}
