import { z } from 'zod';
import {
  ConfigurationError,
  readRequiredSetting,
  type EnvironmentValues,
  type SecretFileReader
} from '$lib/server/config/read-setting';

export interface BootstrapAdminConfig {
  email: string;
  name: string;
  password: string;
}

const bootstrapAdminSchema = z.strictObject({
  email: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(z.email()),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(12).max(128)
});

export function loadBootstrapAdminConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): BootstrapAdminConfig {
  const raw = {
    email: readRequiredSetting(source, 'BOOTSTRAP_ADMIN_EMAIL', readSecretFile),
    name: readRequiredSetting(source, 'BOOTSTRAP_ADMIN_NAME', readSecretFile),
    password: readRequiredSetting(source, 'BOOTSTRAP_ADMIN_PASSWORD', readSecretFile)
  };
  const result = bootstrapAdminSchema.safeParse(raw);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ConfigurationError(`Invalid bootstrap administrator configuration: ${details}`);
}
